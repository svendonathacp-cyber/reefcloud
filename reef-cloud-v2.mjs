// reef-cloud-v2 — Vollständige lokale Fake-Cloud für Reef-Factory
// - Port 444: Geräte (geConnect/login → geReport/login + geSet/time, Live)
// - Port 443: App (Replay der mitgeschnittenen Cloud-Antworten aus dumps/,
//   Live-Routing von <xx>Connect/Get/Set/Execute zwischen App und Gerät)
// Start: node reef-cloud-v2.mjs   (vorher reef-relay.mjs / reef-cloud.mjs beenden)

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { parseTankListPayload, generateTankListPayload, newDeviceRecord } from './tanklist-lib.mjs';
import { startTunnel } from './reef-tunnel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = path.join(__dirname, 'dumps');
const LOG_FILE = path.join(__dirname, 'reef-cloud-v2.log');

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ---------- Frame-Codec ----------
const latin1 = (s) => Array.from(s, (c) => c.charCodeAt(0) & 255);

function encodeFrame(cls, method, payload, serial = '0000000000000000', extra = '') {
  const head = [...latin1(serial), 0, ...latin1(cls), 0, ...latin1(method), 0, ...latin1(extra), 0];
  const body = payload && payload.length ? [...payload, 0] : [0];
  return Buffer.from([...head, ...body]);
}

function decodeFrame(buf) {
  const b = new Uint8Array(buf);
  let i = 0;
  const readStr = () => { let s = ''; while (i < b.length && b[i] !== 0) s += String.fromCharCode(b[i++]); i++; return s; };
  const serial = readStr(), cls = readStr(), method = readStr(), extra = readStr();
  return { serial, cls, method, extra, payload: Buffer.from(b.slice(i)) };
}

// Frame aus Dump-Datei laden; optional extra/serial ersetzen (Session-Tags!)
function loadReplay(file, { extra = null, serial = null } = {}) {
  const f = decodeFrame(fs.readFileSync(path.join(DUMP_DIR, file)));
  return encodeFrame(f.cls, f.method, f.payload, serial ?? f.serial, extra ?? f.extra);
}

// ---------- Replay-Map (App-Anfrage → mitgeschnittene Cloud-Antwort) ----------
// echoExtra: true = Antwort trägt den extra-Tag der Anfrage (NT_/TL_/…)
const REPLAY = {
  'get/interfaceVersion':            { file: '0014_CLOUD_APP_refresh_interface_0000000000000000.bin' },
  'notifications/unreadNumber':      { file: '0019_CLOUD_APP_refresh_notificationsUnreadNumber_0000000000000000.bin', echoExtra: true },
  'tank/list':                       { file: '0020_CLOUD_APP_refresh_tankList_0000000000000000.bin' },
  'tank/listDetails':                { file: '0024_CLOUD_APP_refresh_tankListDetails_0000000000000000.bin' },
  'tank/hwStoreList':                { file: '0027_CLOUD_APP_refresh_hwStoreList_0000000000000000.bin', echoExtra: true },
  'boardingPanel/getTutorials':      { file: '0055_CLOUD_APP_status_getTutorials_0000000000000000.bin' },
  'boardingPanel/getDeviceGroups':   { file: '0059_CLOUD_APP_status_getDeviceGroups_0000000000000000.bin' },
  'boardingPanel/getLoginDetails':   { file: '0061_CLOUD_APP_status_getLoginDetails_0000000000000000.bin' },
  'boardingPanel/getDistributorsList': { file: '0060_CLOUD_APP_status_getDistributorsList_0000000000000000.bin' },
  'boardingPanel/getDeviceTypes':    { file: '0063_CLOUD_APP_status_getDeviceTypes_0000000000000000.bin' },
  'ping/ping':                       { file: '0031_CLOUD_APP_pong_pong_0000000000000000.bin' },
};
const REPLAY_CACHE = new Map();
function replayFrame(key, reqExtra) {
  const r = REPLAY[key];
  if (!r) return null;
  if (!REPLAY_CACHE.has(key)) REPLAY_CACHE.set(key, fs.readFileSync(path.join(DUMP_DIR, r.file)));
  const f = decodeFrame(REPLAY_CACHE.get(key));
  return encodeFrame(f.cls, f.method, f.payload, f.serial, r.echoExtra ? reqExtra : f.extra);
}

// ---------- tankList dynamisch (statt Replay) ----------
// Modell einmalig aus dem Original-Dump parsen (Round-trip-validiert, siehe tanklist-test.mjs);
// Online-Flags kommen zur Laufzeit aus der Geräte-Registry. Format siehe tanklist-lib.mjs.
let tankModel = null;
try {
  const raw = fs.readFileSync(path.join(DUMP_DIR, '0020_CLOUD_APP_refresh_tankList_0000000000000000.bin'));
  const f = decodeFrame(raw);
  tankModel = parseTankListPayload(f.payload);
  log(`tankList-Modell geladen: ${tankModel.tanks[0].devices.length} Geräte im Tank "${tankModel.tanks[0].name}"`);
} catch (e) {
  log(`!! tankList-Modell konnte nicht geladen werden, Fallback=Replay: ${e.message}`);
}

function tankListFrame() {
  if (!tankModel) return replayFrame('tank/list');
  const online = new Set(devices.keys());
  const payload = generateTankListPayload(tankModel, { onlineSerials: online });
  return encodeFrame('refresh', 'tankList', payload);
}

// Unbekannte Geräte beim Login automatisch im Tank registrieren (Neuanmeldung).
// Name kommt aus dem Typ-Katalog (Serial-Präfix), rowId = max+1.
function ensureDeviceRegistered(serial) {
  if (!tankModel || !serial || serial === '0000000000000000') return;
  const devs = tankModel.tanks[0].devices;
  if (devs.some((d) => d.serial === serial)) return;
  const rowId = Math.max(0, ...devs.map((d) => d.rowId)) + 1;
  const rec = newDeviceRecord(null, serial, rowId);
  devs.push(rec);
  log(`  ★ NEUES GERÄT registriert: ${serial} als "${rec.name}" (rowId=${rowId}) — erscheint in der nächsten tankList`);
}

// ====================================================================
// Tunnel zum WebOS-Server (donath-home.de) — Geräte-Snapshots + Kommandos
// ====================================================================

// .env laden (lokal: reef-cloud/.env; Pi-Image: /boot/reef-cloud.env als Fallback)
function loadEnv() {
  const env = {};
  for (const p of [path.join(__dirname, '.env'), '/boot/reef-cloud.env']) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
      }
    } catch { /* Datei optional */ }
  }
  return env;
}
const ENV = loadEnv();
const TUNNEL_URL = ENV.TUNNEL_URL || 'wss://donath-home.de/api/reef/tunnel';
const TUNNEL_TOKEN = ENV.TUNNEL_TOKEN || null;

// Family-Mapping (Serial-Präfix → deviceSnapshot.family, Briefing §3.3)
const FAMILY = {
  RFBP: 'basepump', RFSW: 'wave', RFSRS: 'roller',
  RFDZ: 'doser', RFDX: 'doser', RFDP: 'doser', RFPP: 'doser', RFDL: 'doser',
  RFDA: 'doser', RFDC: 'doser', RFDQ: 'doser', RFDS: 'doser',
  RFLS: 'levelSensor', RFSG: 'salinity', RFLK: 'level', RFTC: 'thermo',
  RFRF: 'flare', RFRB: 'flare', RFLB: 'flare', RFLX: 'flare',
  RFKH: 'kh', RFPM: 'ph', RFPS: 'powerswitcher', RFPA: 'powerswitcher',
  RFTV: 'thermoview', RFSF: 'feeder', RFST: 'smarttester', RFTM: 'tds',
};
function familyOf(serial) {
  return FAMILY[serial.slice(0, 4)] || FAMILY[serial.slice(0, 5)] || 'unknown';
}

// Geräte-Meta für Snapshots: serial → { family, firmware, ip, state, lastSeen, online }
const deviceMeta = new Map();

function metaFor(serial) {
  if (!deviceMeta.has(serial)) {
    deviceMeta.set(serial, { family: familyOf(serial), firmware: null, ip: null, state: {}, lastSeen: 0, online: false });
  }
  return deviceMeta.get(serial);
}

function snapshot(serial) {
  const m = metaFor(serial);
  return {
    serial,
    ip: (m.ip || '').replace('::ffff:', ''),
    family: m.family,
    firmware: m.firmware,
    online: devices.has(serial),
    state: m.state,
    lastSeen: m.lastSeen,
  };
}

// Tunnel-Instanz (null, wenn kein Token konfiguriert)
let tunnel = null;

// Event-Announce, pro Serial gedrosselt (Altgeräte pushen alle 5 s!)
const announceTimers = new Map();
function announce(serial, immediate = false) {
  if (!tunnel) return;
  if (immediate) { tunnel.sendEvent(snapshot(serial)); return; }
  if (announceTimers.has(serial)) return;
  announceTimers.set(serial, setTimeout(() => {
    announceTimers.delete(serial);
    tunnel.sendEvent(snapshot(serial));
  }, 1500));
}

// Zustand aus Report/Refresh-Frames pflegen.
// JSON-Geräte (neue FW): bpReport/swReport/srReport = UTF-8-JSON → 1:1 mergen.
// WICHTIG: Filter auf die KLASSE (bpReport), nicht die Methode — bei bpReport/all
// heißt die Methode "all"! (Bug 01.08.: States blieben deshalb leer.)
// Reef flare (binär, FW 1.x): dashboardData = [on][ledTempC][9 Kanäle][reserviert]
// (Struktur aus Original-Mitschnitt abgeleitet, Nacht-Werte: ch1=2 %, Temp 33/34 °C;
// Kanalzahl 9 aus den Rampenwerten in rfRefresh/preciseData).
// announce() nur bei tatsächlicher State-Änderung (Altgeräte pushen alle 5 s!).
const loggedBinaryOnce = new Set();

function updateState(serial, cls, method, payloadBuf) {
  const m = metaFor(serial);
  m.lastSeen = Date.now();
  if (!(cls.endsWith('Report') || cls.endsWith('Refresh'))) return;
  const before = JSON.stringify(m.state);
  // 1) JSON-Report (neue Firmware)
  try {
    const j = JSON.parse(payloadBuf.toString('utf8').replace(/\0+$/, ''));
    if (j && typeof j === 'object') {
      m.state = { ...m.state, ...j };
      if (JSON.stringify(m.state) !== before) announce(serial);
      return;
    }
  } catch { /* kein JSON → binärer Altgeräte-Frame, unten */ }
  // 2) Reef flare: Binärstrukturen
  if (cls === 'rfRefresh') {
    const pl = payloadBuf.length && payloadBuf[payloadBuf.length - 1] === 0
      ? payloadBuf.subarray(0, payloadBuf.length - 1) : payloadBuf;
    if (method === 'dashboardData' && pl.length >= 11) {
      // Kanäle als Rohwerte 0–255 → Prozent skalieren (WebOS-Karte erwartet 0–100;
      // Skala + Layout [on][temp][9ch][res] per Bridge-Mitschnitt-Verifikation bestätigt)
      const channels = [...pl.subarray(2, 11)].map((v) => Math.round((v / 255) * 100));
      m.state = { ...m.state, on: pl[0] !== 0, ledTempC: pl[1], channels };
      if (JSON.stringify(m.state) !== before) announce(serial);
    } else if (method === 'temp' && pl.length >= 1) {
      m.state = { ...m.state, ledTempC: pl[0] };
      if (JSON.stringify(m.state) !== before) announce(serial);
    }
    // (leere temp-Frames: nichts zu parsen — Temp steckt in dashboardData Byte 1)
  }
  // 3) Unbekannte Binärframes einmal je Gerät/Methode als Hex loggen (Analyse)
  const sig = `${serial}:${cls}/${method}`;
  if (!loggedBinaryOnce.has(sig) && !/Report$/.test(cls)) {
    loggedBinaryOnce.add(sig);
    log(`  ⓘ Binärframe ${sig} (${payloadBuf.length} B): ${payloadBuf.toString('hex').slice(0, 120)}`);
  }
}

// ---------- Frame-Capture (Tunnel-Methoden setCapture/getCapture, Bridge-kompatibel) ----------
// Ringpuffer mit Roh-Frames der Gerätestrecke (beide Richtungen), so wie sie auf der
// Leitung lagen. Format je Frame: { ts: Epoch-ms, serial, hex, direction, class, method,
// payloadUtf8? } — die App wertet ts/serial/hex aus, die Zusatzfelder dienen der Parser-Arbeit.
// Erfasst wird: Gerät→Cloud (in), Cloud→Gerät via send(), App→Gerät via routeToDevice(),
// Tunnel-Kommandos. Nicht erfasst: die periodischen set/pingTime (30 s) — reines Rauschen.
const CAPTURE_MAX = 500;
let captureOn = false;
const captureBuffer = [];

function captureFrame(buf, direction, fallbackSerial = '') {
  if (!captureOn) return;
  try {
    const f = decodeFrame(buf);
    const utf8 = f.payload.toString('utf8').replace(/\0+$/, '');
    const printable = utf8.length > 0 && !/[\x00-\x08\x0e-\x1f]/.test(utf8);
    captureBuffer.push({
      ts: Date.now(),
      serial: f.serial && f.serial !== '0000000000000000' ? f.serial : (fallbackSerial || f.serial || 'unknown'),
      hex: Buffer.from(buf).toString('hex'),
      direction,
      class: f.cls,
      method: f.method,
      ...(printable ? { payloadUtf8: utf8 } : {}),
    });
    if (captureBuffer.length > CAPTURE_MAX) captureBuffer.shift();
  } catch { /* kein dekodierbarer Frame — nicht capturen */ }
}

// Steuer-Aktionen aus dem WebOS (Briefing §3.4)
function buildCommandFrame(serial, action, params) {
  const m = metaFor(serial);
  const fam = m.family;
  const cur = m.state || {};
  const onOff = (v) => (v === 'on' || v === 1 || v === true ? 1 : 0);
  switch (`${fam}:${action}`) {
    case 'basepump:setSpeed':
      // bpSet/settings: ALLE Felder mitschicken (aktuelle Werte als Basis)
      return ['bpSet', 'settings', latin1(JSON.stringify({
        speed: Number(params.speed),
        feedModeTime: cur.feedModeTime ?? 5,
        feedSpeed: cur.feedSpeed ?? 0,
        display: onOff(cur.display ?? 'on'),
        backlight: onOff(cur.backlight ?? 'on'),
      }))];
    case 'wave:setSpeed': {
      // UNVERIFIZIERT: Format per Analogie bpSet angenommen — erste App-Nutzung
      // liefert das echte Format via Payload-Capture (dumps/live_capture/)
      const s = cur.settings || {};
      return ['swSet', 'settings', latin1(JSON.stringify({
        speed: Number(params.speed),
        mode: cur.mode ?? 1,
        settings: {
          feedTime: s.feedTime ?? 900,
          display: s.display ?? 1,
          backlight: s.backlight ?? 1,
          schedule: s.schedule ?? [],
        },
      }))];
    }
    case 'roller:feed':    // UNVERIFIZIERT (Payload-Form geraten, Capture prüft)
      return ['srExecute', 'manual', latin1(JSON.stringify({ length: Number(params.mm ?? params.length ?? 30) }))];
    case 'roller:newRoll': // UNVERIFIZIERT
      return ['srSet', 'newRoll', latin1(JSON.stringify({}))];
    case 'roller:unblock': // UNVERIFIZIERT
      return ['srSet', 'unblock', latin1(JSON.stringify({}))];
    default:
      throw new Error(`unknown action ${action} für family ${fam}`);
  }
}

async function handleTunnelRequest(method, params) {
  if (method === 'listDevices') {
    return [...devices.keys()].map(snapshot);
  }
  if (method === 'command') {
    const { serial, action, params: ap = {} } = params;
    const dev = devices.get(serial);
    if (!dev || dev.readyState !== dev.OPEN) throw new Error(`Gerät ${serial} nicht verbunden`);
    const [cls, mth, payload] = buildCommandFrame(serial, action, ap);
    log(`  [tunnel] command ${action} → ${serial}: ${cls}/${mth}`);
    const buf = encodeFrame(cls, mth, payload, serial);
    captureFrame(buf, 'out', serial);
    dev.send(buf);
    return { ok: true };
  }
  if (method === 'rawCommand') {
    const { serial, frame } = params;
    const dev = devices.get(serial);
    if (!dev || dev.readyState !== dev.OPEN) throw new Error(`Gerät ${serial} nicht verbunden`);
    const payload = frame.payloadHex ? Buffer.from(frame.payloadHex, 'hex') : Buffer.alloc(0);
    const buf = encodeFrame(frame.command, frame.subcommand, payload, serial, frame.identifier || '');
    captureFrame(buf, 'out', serial);
    dev.send(buf);
    return { ok: true };
  }
  // Capture-Schalter (Bridge-kompatibel): Einschalten leert den Puffer, Ausschalten behält ihn
  if (method === 'setCapture') {
    captureOn = !!(params && params.on);
    if (captureOn) captureBuffer.length = 0;
    log(`  [tunnel] Capture ${captureOn ? 'AN (Puffer geleert)' : 'AUS (Puffer bleibt erhalten)'}`);
    return { capture: captureOn };
  }
  if (method === 'getCapture') {
    return { capture: captureOn, frames: captureBuffer.slice() };
  }
  throw new Error(`unknown method ${method}`);
}

if (TUNNEL_TOKEN) {
  tunnel = startTunnel({
    url: TUNNEL_URL,
    token: TUNNEL_TOKEN,
    log,
    getSnapshots: () => [...devices.keys()].map(snapshot),
    handleRequest: handleTunnelRequest,
  });
  log(`Tunnel aktiviert → ${TUNNEL_URL}`);
} else {
  log('Tunnel deaktiviert (kein TUNNEL_TOKEN in .env / /boot/reef-cloud.env)');
}

// ---------- Verbindungs-Registry ----------
const devices = new Map(); // serial → ws
const apps = new Set();    // app websockets
const joins = new Map();   // serial → Set<appWs>  (welche App hat welches Gerät abonniert)

function routeToDevice(serial, buf, fromApp) {
  const dev = devices.get(serial);
  if (dev && dev.readyState === dev.OPEN) { captureFrame(buf, 'out', serial); dev.send(buf); return true; }
  log(`  !! Routing fehlgeschlagen: Gerät ${serial} nicht verbunden`);
  return false;
}

function routeToApps(serial, buf) {
  const targets = joins.get(serial);
  if (targets) for (const app of targets) if (app.readyState === app.OPEN) app.send(buf);
}

// ---------- Geräte-Seite (Port 444) ----------
function handleDeviceFrame(ws, buf, peer) {
  const f = decodeFrame(buf);
  log(`  [${peer}] << ${f.cls}/${f.method} serial="${f.serial}" extra="${f.extra}" (${buf.length} B)`);
  captureFrame(buf, 'in', ws.deviceIp);

  if (f.cls === 'geConnect' && f.method === 'login') {
    // Neue Firmware (1.4.x/1.5.x): JSON-Login → geReport/login + geSet/time (JSON)
    if (f.serial && f.serial !== '0000000000000000') {
      devices.set(f.serial, ws); ws.deviceSerial = f.serial; ensureDeviceRegistered(f.serial);
      // Tunnel-Meta: IP, Firmware, online
      const meta = metaFor(f.serial);
      meta.ip = ws.deviceIp || meta.ip;
      meta.lastSeen = Date.now();
      try { meta.firmware = JSON.parse(f.payload.toString('utf8').replace(/\0+$/, '')).version || meta.firmware; } catch {}
      announce(f.serial, true);
    }
    send(ws, 'geReport', 'login', latin1(JSON.stringify({ status: 'success', pingInterval: 20 })), f.serial);
    const now = new Date();
    send(ws, 'geSet', 'time', latin1(JSON.stringify({
      year: now.getFullYear() % 100, month: now.getMonth() + 1, day: now.getDate(),
      weekday: now.getDay(), hour: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds(),
    })), f.serial);
    log(`  → Gerät ${f.serial} eingeloggt und registriert (neue Firmware)`);
    // State-Priming: bei bekannten JSON-Familien sofort den Voll-Report anfordern,
    // damit Tunnel-Snapshots/App-Karten direkt nach dem Login gefüllt sind
    if (f.serial && f.serial !== '0000000000000000') {
      const fam = metaFor(f.serial).family;
      if (fam === 'roller') {
        // Roller antwortet NICHT auf srGet/all — die echte Cloud fragte
        // srGet/settings mit join_-Tag im extra-Feld (Original-Mitschnitt 0009/0042)
        const buf = encodeFrame('srGet', 'settings', [], f.serial, `join_${Date.now()}`);
        captureFrame(buf, 'out', f.serial);
        ws.send(buf);
        log('  → srGet/settings angefordert (State-Priming, mit join_-Tag)');
      } else {
        const gp = { basepump: 'bp', wave: 'sw' }[fam];
        if (gp) { send(ws, `${gp}Get`, 'all', [], f.serial); log(`  → ${gp}Get/all angefordert (State-Priming)`); }
      }
    }
    return;
  }
  if (f.cls === 'user' && f.method === 'login') {
    // Altgeräte (FW 1.0.0/1.1.0, Port 442): binärer Login email\0pass\0\0key\0version\0
    // Antwort (Original mitgeschnitten): status/login binär + set/time binär (7 Bytes: u16BE Jahr, M, T, h, m, s)
    const parts = [];
    let cur = [];
    for (const b of f.payload) { if (b === 0) { if (cur.length) { parts.push(Buffer.from(cur).toString('latin1')); cur = []; } } else cur.push(b); }
    const [email, , , key, version] = parts;
    if (f.serial && f.serial !== '0000000000000000') {
      devices.set(f.serial, ws); ws.deviceSerial = f.serial; ensureDeviceRegistered(f.serial);
      // Tunnel-Meta: IP, Firmware, online
      const meta = metaFor(f.serial);
      meta.ip = ws.deviceIp || meta.ip;
      meta.firmware = version || meta.firmware;
      meta.lastSeen = Date.now();
      announce(f.serial, true);
    }
    const loginReply = loadReplay('0030_CLOUD_GER_T_status_login_RFRFM52302210014.bin', { serial: f.serial });
    captureFrame(loginReply, 'out', f.serial);
    ws.send(loginReply);
    const now = new Date();
    send(ws, 'set', 'time', [
      (now.getFullYear() >> 8) & 255, now.getFullYear() & 255,
      now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(),
    ], f.serial);
    log(`  → Altgerät ${f.serial} eingeloggt (email=${email}, key=${key}, version=${version})`);
    return;
  }
  if (f.cls === 'user' && f.method === 'logout') {
    // Altgeräte-Logout: Bestätigung status/logout "ok" + Gerät abmelden
    send(ws, 'status', 'logout', latin1('ok'), f.serial);
    if (ws.deviceSerial) { devices.delete(ws.deviceSerial); log(`  → Altgerät ${ws.deviceSerial} abgemeldet`); ws.deviceSerial = null; }
    return;
  }
  // Alles andere vom Gerät: State fürs Tunnel-Snapshot pflegen + an abonnierende Apps weiterreichen
  if (f.serial && f.serial !== '0000000000000000') updateState(f.serial, f.cls, f.method, f.payload);
  routeToApps(f.serial, buf);
}

// ---------- App-Seite (Port 443) ----------
function handleAppFrame(ws, buf, peer) {
  const f = decodeFrame(buf);
  const key = `${f.cls}/${f.method}`;
  log(`  [${peer}] << ${key} serial="${f.serial}" extra="${f.extra}" (${buf.length} B)`);

  if (f.cls === 'user' && f.method === 'login') {
    // Original-Sequenz: status/login → refresh/interface → status/tokenId (Replay)
    ws.send(loadReplay('0013_CLOUD_APP_status_login_0000000000000000.bin'));
    ws.send(loadReplay('0014_CLOUD_APP_refresh_interface_0000000000000000.bin'));
    ws.send(loadReplay('0015_CLOUD_APP_status_tokenId_0000000000000000.bin'));
    log('  → App-Login beantwortet (Replay status/login + interface + tokenId)');
    return;
  }
  if (f.cls === 'user' && f.method === 'setFirstLogin') return; // nur loggen
  if (key.endsWith('Connect/join')) {
    if (!joins.has(f.serial)) joins.set(f.serial, new Set());
    joins.get(f.serial).add(ws);
    routeToDevice(f.serial, buf, ws);
    return;
  }
  if (key.endsWith('Connect/leave')) {
    joins.get(f.serial)?.delete(ws);
    routeToDevice(f.serial, buf, ws);
    return;
  }
  // tankList dynamisch aus Live-Verbindungen generieren (Online-Flags aktuell)
  if (key === 'tank/list') { ws.send(tankListFrame()); log(`  → tankList dynamisch (${devices.size} Gerät(e) online)`); return; }
  // Replaybare Account-Anfragen
  const replay = replayFrame(key, f.extra);
  if (replay) { ws.send(replay); log(`  → Replay ${key}`); return; }
  // Geräteadressierte Frames (bpGet/all, swSet/…, srExecute/…): ans Gerät routen
  if (f.serial && f.serial !== '0000000000000000') {
    // Steuerframes (Set/Execute/Manual/Log) als Volldump sichern — Format-Verifikation
    // für das Tunnel-Aktions-Mapping (wave/roller-Payloads sind bisher unverifiziert)
    if (/(Set|Execute|Manual|Log)\//.test(key)) {
      try {
        const dir = path.join(DUMP_DIR, 'live_capture');
        fs.mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}_APP_${f.cls}_${f.method}_${f.serial}.bin`;
        fs.writeFileSync(path.join(dir, file), buf);
        log(`  → Capture dumps/live_capture/${file}`);
      } catch (e) { log(`  !! Capture fehlgeschlagen: ${e.message}`); }
    }
    routeToDevice(f.serial, buf, ws); return;
  }
  log('  (kein Handler — nur geloggt)');
}

function send(ws, cls, method, payload, serial = '0000000000000000') {
  const buf = encodeFrame(cls, method, payload, serial);
  captureFrame(buf, 'out', ws.deviceIp || serial);
  ws.send(buf);
}

// ---------- Server-Aufbau ----------
const cert = fs.readFileSync(path.join(__dirname, 'reef-cloud-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'reef-cloud-key.pem'));

function createWssServer(port, role, frameHandler, useTls = true) {
  const server = useTls ? https.createServer({ cert, key }) : http.createServer();
  // HTTP(S)-Requests (kein WS-Upgrade) loggen + minimal beantworten —
  // die Altgeräte-Web-UI pollt evtl. Cloud-Endpunkte per HTTP
  server.on('request', (req, res) => {
    log(`  HTTP-Request :${port} ${req.method} ${req.url} von ${req.socket.remoteAddress} (UA: ${req.headers['user-agent'] || '-'})`);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{}');
  });
  if (useTls) server.on('tlsClientError', (err, socket) => {
    log(`!! TLS-Handshake :${port} fehlgeschlagen von ${socket.remoteAddress}: ${err.message}`);
  });
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => {
      // Altgeräte bieten 'arduino', neue 'reeffactory', manche nichts — alles annehmen
      if (protocols.has('reeffactory')) return 'reeffactory';
      if (protocols.has('arduino')) return 'arduino';
      return false;
    },
  });
  wss.on('connection', (ws, req) => {
    const peer = `${role}:${port} ${req.socket.remoteAddress}:${req.socket.remotePort}${req.url}`;
    ws.deviceIp = req.socket.remoteAddress; // für Tunnel-Snapshots
    log(`=== ${role}-Connect: ${peer} (Subprotokoll=${ws.protocol}) ===`);
    if (role === 'APP') {
      apps.add(ws);
      // Wie die echte Cloud: set/pingTime direkt nach Connect (serial="")
      ws.send(loadReplay('0004_CLOUD_APP_set_pingTime_.bin'));
    }
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(encodeFrame('set', 'pingTime', [0, 30], role === 'APP' ? '' : '0000000000000000'));
    }, 30000);
    ws.on('message', (data, isBinary) => {
      try { frameHandler(ws, data, peer); } catch (e) { log(`!! Frame-Fehler ${peer}: ${e.message}`); }
    });
    ws.on('close', (code, reason) => {
      clearInterval(pingInterval);
      if (role === 'GERÄT' && ws.deviceSerial) {
        devices.delete(ws.deviceSerial);
        for (const set of joins.values()) set.delete(ws);
        announce(ws.deviceSerial, true); // Tunnel: Gerät offline melden
        log(`=== ${role}-Close: ${peer} (${ws.deviceSerial} abgemeldet) code=${code} ===`);
      } else {
        apps.delete(ws);
        for (const set of joins.values()) set.delete(ws);
        log(`=== ${role}-Close: ${peer} code=${code} reason="${reason}" ===`);
      }
    });
    ws.on('error', (e) => log(`!! ${role}-Fehler ${peer}: ${e.message}`));
  });
  server.listen(port, () => log(`${role}-Server lauscht auf Port ${port}`));
  server.on('error', (e) => log(`!! Port ${port}: ${e.code || e.message} — andere reef-*.mjs vorher beenden!`));
}

createWssServer(444, 'GERÄT', handleDeviceFrame);
createWssServer(443, 'APP', handleAppFrame);
// Altgeräte (Reef flare & Co., FW 1.0.0/1.1.0): Cloud-Client auf Port 442, PLAIN ws (kein TLS!)
createWssServer(442, 'GERÄT', handleDeviceFrame, false);
// Fallback, falls ein Gerät plain ws versucht
createWssServer(80, 'GERÄT', handleDeviceFrame, false);
log('reef-cloud-v2 gestartet. Log-Datei: ' + LOG_FILE);
