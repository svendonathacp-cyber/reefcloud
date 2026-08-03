// reef-cloud-v2 — Vollständige lokale Fake-Cloud für Reef-Factory
// - Port 444: Geräte (geConnect/login → geReport/login + geSet/time, Live)
// - Port 443: App (Replay der mitgeschnittenen Cloud-Antworten aus dumps/,
//   Live-Routing von <xx>Connect/Get/Set/Execute zwischen App und Gerät)
// Start: node reef-cloud-v2.mjs   (vorher reef-relay.mjs / reef-cloud.mjs beenden)

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { parseTankListPayload, generateTankListPayload, newDeviceRecord } from './tanklist-lib.mjs';
import { startTunnel } from './reef-tunnel.mjs';
import { ensureCertificate } from './reef-cert.mjs';
import { createAutolevel } from './reef-autolevel.mjs';
import { createUpdater } from './reef-updater.mjs';
import { scanWifiNetworks } from './reef-onboarding.mjs';
import { parseSgSettings51, sgCalibrateTempPayload, SG_CALIBRATE_MAIN_PAYLOAD } from './reef-salinity.mjs';
import {
  parseDzRefresh, dzSetNamePayload, dzSetContainerPayload, dzSetDosesPayload,
  dzSkipNextPayload, dzPumpPayload, dzGetSettingsPayload, dzCalibrateValuePayload,
  dzCalibrateNotifyPayload, dzManualRefillStartPayload,
} from './reef-doser.mjs';
import {
  LK_STATUS_TEXT,
  parseLkSettingsExtra, parseLkStatusExtra, parseLkAlert, parseLkManualRefill,
  parseLkCircuit, parseLkCalibration, parseLkTemporary,
  parseRfManualTime, parseRfManualData, parseRfOffData,
  rfManualTimePayload, rfManualUpdatePayload, u32be,
} from './reef-onboard.mjs';
import { JebaoClient, discover as jebaoDiscover } from './reef-jebao.mjs';

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

// Anzeigenamen aus dem Tank-Modell (HTML-Entities wie &#252; auflösen, trimmen)
const unescapeHtml = (s) => s && s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
function deviceName(serial) {
  const d = tankModel?.tanks[0].devices.find((x) => x.serial === serial);
  const n = d ? unescapeHtml(d.name)?.trim() : null;
  return n || null;
}
const tankName = () => unescapeHtml(tankModel?.tanks[0]?.name)?.trim() || null;

// ====================================================================
// Tunnel zu einem externen Server (z. B. WebOS) — Geräte-Snapshots + Kommandos
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
let TUNNEL_URL = ENV.TUNNEL_URL || '';
let TUNNEL_TOKEN = ENV.TUNNEL_TOKEN || null;
// Tunnel-Ziel generisch einstellbar (WebOS-Server, HomeAssistant, Custom):
// TUNNEL_TYPE wählt die Zielplattform, TUNNEL_LABEL ist der Anzeigename.
// HINWEIS: Ein HomeAssistant-spezifisches Event-Mapping kommt später —
// aktuell ist TUNNEL_TYPE nur Meta-Info (Protokoll ist bei allen Typen gleich).
const TUNNEL_TYPES = ['webos', 'homeassistant', 'custom'];
let TUNNEL_TYPE = TUNNEL_TYPES.includes(ENV.TUNNEL_TYPE) ? ENV.TUNNEL_TYPE : 'webos';
let TUNNEL_LABEL = ENV.TUNNEL_LABEL || 'WebOS-Server';

// Konfiguration persistieren: Pi → /boot/reef-cloud.env (Konfigurationsweg
// laut Pi-Briefing, kommt nicht ins Image), sonst .env neben dem Server.
// MERGE statt Vollüberschreiben: bestehende Kommentare und unbekannte Zeilen
// der Datei bleiben erhalten, nur übergebene Keys werden ersetzt/ergänzt.
function writeEnvConfig({ tunnelUrl, tunnelToken, tunnelType, tunnelLabel }) {
  const updates = {};
  if (tunnelUrl !== undefined) updates.TUNNEL_URL = tunnelUrl;
  if (tunnelToken !== undefined) updates.TUNNEL_TOKEN = tunnelToken;
  if (tunnelType !== undefined) updates.TUNNEL_TYPE = tunnelType;
  if (tunnelLabel !== undefined) updates.TUNNEL_LABEL = tunnelLabel;

  // Zweite Schutzschicht gegen Env-Injection (erste: Validierung in den
  // API-Endpunkten): Steuerzeichen (\r, \n, \0 …) in Werten hart ablehnen,
  // sonst könnte ein Wert zusätzliche KEY=-Zeilen in die Datei schmuggeln.
  for (const [k, v] of Object.entries(updates)) {
    if (/[\x00-\x1f\x7f]/.test(String(v))) {
      throw new Error(`writeEnvConfig: Steuerzeichen in ${k} nicht erlaubt`);
    }
  }

  // Zieldatei bestimmen (Pi-Boot-Partition bevorzugt)
  let target = path.join(__dirname, '.env');
  try {
    fs.accessSync('/boot', fs.constants.W_OK);
    target = '/boot/reef-cloud.env';
  } catch { /* kein Pi oder /boot nicht beschreibbar */ }

  // Bestehende Datei einlesen: Kommentare/unbekannte Zeilen erhalten,
  // bekannte Keys ersetzen, fehlende anhängen
  let lines = [];
  try { lines = fs.readFileSync(target, 'utf8').split('\n'); } catch { /* Datei wird neu angelegt */ }
  if (!lines.length || (lines.length === 1 && lines[0].trim() === '')) {
    lines = ['# reef-cloud Konfiguration (Setup-Wizard, ' + new Date().toISOString() + ')'];
  }
  const seen = new Set();
  lines = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in updates) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return line;
  });
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  // mode 0o600: die Datei enthält den Tunnel-Token — nicht lesbar für andere
  // Benutzer. writeFileSync-mode greift nur bei Neuanlage, daher chmod nachziehen
  // (bestehende Datei aus früheren Setups hatte umask-Default, typisch 0o644).
  fs.writeFileSync(target, lines.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows/andere FS: best effort */ }
  return target;
}

// Tunnel-Verbindungstest fürs Setup: öffnet kurz eine eigene WS-Verbindung
// mit Bearer-Token. ok=true, sobald der Server den Upgrade akzeptiert.
function testTunnelConnection(url, token) {
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => {
      try { ws?.terminate(); } catch {}
      resolve({ ok: false, error: 'Zeitüberschreitung (8 s) — URL erreichbar?' });
    }, 8000);
    try {
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, error: `Ungültige URL: ${e.message}` });
    }
    ws.on('open', () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ok: true });
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Server antwortet HTTP ${res.statusCode} — Token oder Route falsch?` });
    });
  });
}

// LAN-IPv4-Adressen (für den DNS-Rewrite-Hinweis im Setup)
function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

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
  // Jebao-Wavemaker: eigene Serial-Familie (Gizwits-LAN, reef-jebao.mjs)
  if (serial.startsWith('JEBAO-')) return 'jebao';
  return FAMILY[serial.slice(0, 4)] || FAMILY[serial.slice(0, 5)] || 'unknown';
}

// Geräte-Meta für Snapshots: serial → { family, firmware, ip, state, lastSeen,
// online, reachable, lastProbe } (reachable/lastProbe vom Hello-Ping, s.u.)
// name: Anzeigename für Geräte ohne Tank-Modell-Eintrag (z. B. Jebao aus jebao.json)
const deviceMeta = new Map();

function metaFor(serial) {
  if (!deviceMeta.has(serial)) {
    deviceMeta.set(serial, { family: familyOf(serial), firmware: null, ip: null, name: null, state: {}, lastSeen: 0, online: false, reachable: null, lastProbe: 0 });
  }
  return deviceMeta.get(serial);
}

// ---------- Geräte-Spitznamen (Nicknames) ----------
// Persistenz: names.json im Server-Verzeichnis ({ "<serial>": "<name>" }).
// Laufzeitdaten — steht in .gitignore. Schreiben atomar (tmp-Datei + rename).
const NAMES_FILE = path.join(__dirname, 'names.json');
const customNames = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')))) {
    if (typeof v === 'string' && v.trim()) customNames.set(k, v);
  }
  if (customNames.size) log(`Nicknames geladen: ${customNames.size} Spitznamen aus names.json`);
} catch { /* Datei optional oder defekt → mit leeren Nicknames starten */ }

function saveNames() {
  const tmp = NAMES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(customNames), null, 2) + '\n');
  fs.renameSync(tmp, NAMES_FILE);
}

// ---------- Geräte-Eigenschaften (device props) ----------
// Persistenz: device-props.json ({ "<serial>": { "alarmWhen": "above"|"below" } }).
// Laufzeitdaten — steht in .gitignore. Schreiben atomar (Muster names.json).
// alarmWhen steuert die Interpretation der Level-Sensor-Codes (RFLS): die
// Alarm-Richtung („Alarm, wenn Flüssigkeit über/unter") ist am Gerät selbst
// umkonfigurierbar — der Server muss sie daher pro Gerät kennen, um aus dem
// rohen alarm-Flag den Wasserstand (covered) abzuleiten. Default: 'above'
// (Werkskonfiguration der Geräte, live verifiziert 02.08.).
const PROPS_FILE = path.join(__dirname, 'device-props.json');
const deviceProps = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(PROPS_FILE, 'utf8')))) {
    if (v && (v.alarmWhen === 'above' || v.alarmWhen === 'below')) deviceProps.set(k, { alarmWhen: v.alarmWhen });
  }
  if (deviceProps.size) log(`Geräte-Props geladen: ${deviceProps.size} Einträge aus device-props.json`);
} catch { /* Datei optional oder defekt → mit Defaults starten */ }

function saveProps() {
  const tmp = PROPS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(deviceProps), null, 2) + '\n');
  fs.renameSync(tmp, PROPS_FILE);
}

function alarmWhenFor(serial) {
  return deviceProps.get(serial)?.alarmWhen === 'below' ? 'below' : 'above';
}

// covered = Wasser bedeckt den Sensor (Pegel ÜBER der Sensorposition).
// alarm ist die rohe Alarm-Bedeutung des gemeldeten Codes; die Ableitung
// hängt von der geräteseitigen Alarm-Richtung ab (alarmWhen).
function deriveCovered(alarm, alarmWhen) {
  if (alarm !== true && alarm !== false) return 'unknown';
  return alarmWhen === 'above' ? alarm : !alarm;
}

// ---------- Letzte bekannte Geräte-IPs persistieren ----------
// Die Erreichbarkeits-Probe braucht eine IP — ohne Persistenz ist sie nach
// einem Server-Neustart bis zum nächsten Geräte-Login blind (02.08.: Altgeräte
// mit halb-offener TCP-Verbindung blieben stumm, niemand konnte sie finden).
// Laufzeitdaten (LAN-IPs) — steht in .gitignore. Schreiben atomar.
const IPS_FILE = path.join(__dirname, 'device-ips.json');
const knownIps = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(IPS_FILE, 'utf8')))) {
    if (typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v)) knownIps.set(k, v);
  }
  if (knownIps.size) log(`Geräte-IPs geladen: ${knownIps.size} letzte IPs aus device-ips.json`);
} catch { /* Datei optional oder defekt */ }

let ipsSaveTimer = null;
function saveIps() {
  // Entprellt: Logins kommen oft in Bursts (Power-Reset mehrerer Geräte)
  if (ipsSaveTimer) return;
  ipsSaveTimer = setTimeout(() => {
    ipsSaveTimer = null;
    try {
      const tmp = IPS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(knownIps), null, 2) + '\n');
      fs.renameSync(tmp, IPS_FILE);
    } catch (e) { log(`!! device-ips.json nicht geschrieben: ${e.message}`); }
  }, 2000);
  ipsSaveTimer.unref();
}

// Alle Geräte aus dem Tank-Modell von Anfang an kennen — sonst zeigen Web-UI
// und Tunnel nach einem Neustart nur die Geräte, die sich seitdem eingeloggt
// haben (Bug 02.08.: 6 statt 12 Karten).
if (tankModel) {
  for (const d of tankModel.tanks[0].devices) metaFor(d.serial);
  log(`deviceMeta initialisiert: ${deviceMeta.size} bekannte Geräte aus dem Tank-Modell`);
}
// Persistierte IPs ins Meta seeden — damit die Probe direkt nach dem Start arbeitet
for (const [serial, ip] of knownIps) metaFor(serial).ip = ip;

// Letzte bekannte Geräte-States persistent halten: nach einem Neustart zeigt
// die UI sofort die zuletzt gemeldeten Werte (Temperaturen, Sensor-Stände …)
// statt leerer Karten, bis die ersten neuen Frames kommen (Pi = Dauerbetrieb).
// Laufzeitdaten — steht in .gitignore. Schreiben atomar + entprellt (30 s:
// Flares melden alle ~5 s, die SD-Karte des Pi dankt es).
const STATES_FILE = path.join(__dirname, 'device-states.json');
try {
  for (const [serial, saved] of Object.entries(JSON.parse(fs.readFileSync(STATES_FILE, 'utf8')))) {
    if (!saved || typeof saved !== 'object') continue;
    const m = metaFor(serial);
    if (saved.state && typeof saved.state === 'object' && !Array.isArray(saved.state)) m.state = saved.state;
    if (typeof saved.firmware === 'string') m.firmware = saved.firmware;
    if (Number.isFinite(saved.lastSeen)) m.lastSeen = saved.lastSeen;
  }
} catch { /* Datei optional oder defekt */ }

let statesSaveTimer = null;
function saveStates() {
  if (statesSaveTimer) return;
  statesSaveTimer = setTimeout(() => {
    statesSaveTimer = null;
    try {
      const out = {};
      for (const [serial, m] of deviceMeta) {
        if (m.state && Object.keys(m.state).length) {
          out[serial] = { state: m.state, firmware: m.firmware, lastSeen: m.lastSeen };
        }
      }
      const tmp = STATES_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out) + '\n');
      fs.renameSync(tmp, STATES_FILE);
    } catch (e) { log(`!! device-states.json nicht geschrieben: ${e.message}`); }
  }, 30000);
  statesSaveTimer.unref();
}

// ---------- Erreichbarkeits-Ping („Hello-Ping") für offline Geräte ----------
// Die Geräte sind WS-Clients — der Server kann keine WS-Verbindung ZUM Gerät
// öffnen. Stattdessen TCP-Connect-Versuche (node:net, kein ICMP, keine neuen
// Dependencies) auf Port 80 und 443 an der letzten bekannten IP, je 2 s Timeout.
// Läuft alle 60 s, nur für bekannte Geräte mit IP, die NICHT eingeloggt sind.
function probeTcp(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// Re-Entry-Guard: ein Lauf kann (bei vielen Geräten × 2 s Timeout) länger
// dauern als das Intervall — überlappende Läufe werden übersprungen.
let probing = false;
async function probeOfflineDevices() {
  if (probing) return;
  probing = true;
  try {
    for (const [serial, m] of deviceMeta) {
      if (devices.has(serial)) continue; // eingeloggt = online, kein Probe nötig
      if (jebaoClients.has(serial)) continue; // Jebao: eigener LAN-Client managt Verbindung + Erreichbarkeit
      const ip = (m.ip || '').replace('::ffff:', '');
      if (!ip) continue;                 // ohne bekannte IP kein Probe möglich
      const [p80, p443] = await Promise.all([probeTcp(ip, 80), probeTcp(ip, 443)]);
      const reachable = p80 || p443;
      m.lastProbe = Date.now();
      // Log nur bei Zustandswechsel (null → true/false beim ersten Probe zählt auch)
      if (m.reachable !== reachable) {
        m.reachable = reachable;
        if (reachable) log(`Gerät ${serial} ist per TCP erreichbar, aber nicht eingeloggt (${ip})`);
        else log(`Gerät ${serial} ist nicht mehr erreichbar (${ip})`);
        announce(serial, true); // Zustandswechsel → Tunnel/Web-UI informieren
      }
    }
  } finally {
    probing = false;
  }
}
setInterval(probeOfflineDevices, 60_000).unref();
setTimeout(probeOfflineDevices, 5_000).unref(); // erster Lauf kurz nach Start

function snapshot(serial) {
  const m = metaFor(serial);
  // Jebao-Pumpen sind keine WS-Clients — ihr Online-Status kommt vom LAN-Client
  const online = devices.has(serial) || jebaoOnline.has(serial);
  return {
    serial,
    name: deviceName(serial) ?? m.name ?? null,
    ...(customNames.has(serial) ? { customName: customNames.get(serial) } : {}),
    ip: (m.ip || '').replace('::ffff:', ''),
    family: m.family,
    firmware: m.firmware,
    online,
    state: m.state,
    lastSeen: m.lastSeen,
    // Hello-Ping: per TCP erreichbar, aber offline. Eingeloggte Geräte sind
    // trivialerweise erreichbar — sonst widersprüchlich (online:true, reachable:false).
    reachable: online ? true : (m.reachable ?? false),
    lastProbe: m.lastProbe ?? 0,
    ...(m.family === 'levelSensor' ? { alarmWhen: alarmWhenFor(serial) } : {}),
    ...(m.lampProgram ? { lampProgram: m.lampProgram } : {}),
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

// preciseData (komplettes Lampenprogramm) → { name, intensity, version, points }
// Punkte-Modell wie App-Export: [{ t: Minute 0..1440, l: [7 Kanäle 0..1] }].
// Der t=0-Startpunkt ist implizit (nicht im Frame) und wird ergänzt.
function parsePreciseData(buf) {
  try {
    if (buf.length < 73) return null;
    let name = '';
    for (let i = 6; i + 1 < 53; i += 2) {
      const code = buf.readUInt16LE(i);
      if ((code & 0xff) === 0) break; // Terminator: einzelnes 0x00 im Low-Byte
      name += String.fromCharCode(code);
    }
    const version = buf.readUInt32BE(53);
    const framePoints = Math.floor((buf.length - 72) / 9);
    const points = [];
    for (let i = 0; i < framePoints; i++) {
      const o = 67 + i * 9;
      const t = buf.readUInt16BE(o);
      if (t > 1440) return null; // Plausibilitätscheck — Layout passt nicht
      points.push({ t, l: [...buf.subarray(o + 2, o + 9)].map((v) => v / 100) });
    }
    if (!points.length || points[0].t !== 0) points.unshift({ t: 0, l: [0, 0, 0, 0, 0, 0, 0] });
    return { name, intensity: buf[buf.length - 6], version, points };
  } catch { return null; }
}

// rfPrecise/update (Schreibpfad App→Cloud→Lampe, aus App-Mitschnitt 01.08.):
//   [0] 0x00  [1-4] u32BE neue Version  [5] u8 Punktzahl INKL. implizitem t=0
//   [6-14] 9 B 0  [15..] Punkte je 9 B (u16BE Minute + 7×u8 Kanal-%)
//   [danach] u8 Intensität, 0x00.
// Hinweis: Das Payload-Ende-0x00 ist aus dem dekodierten Mitschnitt übernommen;
// encodeFrame hängt den Feld-Terminator nochmals an → auf der Leitung doppeltes
// NUL. Von der Lampe verifiziert toleriert (✓-Verifikation), daher unverändert.
// (Bei den JSON-Geräten wave/pump ist das NICHT toleriert — dort Payload ohne NUL!)
// Danach schickt die App rfPrecise/pointer ([u32BE Version][0x00]) als
// Commit/Sync — die Lampe übernimmt den Zeiger und pusht preciseData zurück.
const pendingUploads = new Map(); // serial → { version, program } (Rück-Verifikation)

function buildPreciseUpdate(program) {
  const pts = program.points.filter((p) => p.t > 0 && p.t <= 1440);
  const version = randomBytes(4).readUInt32BE(0);
  const buf = Buffer.alloc(15 + pts.length * 9 + 2);
  buf.writeUInt32BE(version, 1);
  buf[5] = pts.length + 1; // + impliziter t=0-Startpunkt (nicht im Frame)
  pts.forEach((p, i) => {
    const o = 15 + i * 9;
    buf.writeUInt16BE(p.t, o);
    p.l.slice(0, 7).forEach((v, ch) => {
      buf[o + 2 + ch] = Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100);
    });
  });
  buf[15 + pts.length * 9] = program.intensity;
  return { version, payload: [...buf] };
}

// Inhalt eines geparsten preciseData gegen das hochgeladene Programm prüfen
function programMatches(a, b) {
  const norm = (p) => p.points.filter((x) => x.t > 0)
    .map((x) => [x.t, ...x.l.slice(0, 7).map((v) => Math.round(v * 100))].join(','))
    .join('|') + `#${p.intensity}`;
  return norm(a) === norm(b);
}

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
      if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
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
      if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
    } else if (method === 'temp' && pl.length >= 1) {
      m.state = { ...m.state, ledTempC: pl[0] };
      if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
    } else if (method === 'preciseEdit' && payloadBuf.length >= 4) {
      // Programm-Versionszeiger der Lampe (u32BE; Originalpuffer, kein NUL-Strip —
      // der Zeiger kann legitimerweise auf 0x00 enden). preciseData (das eigentliche
      // Programm) wird einmalig als Hex geloggt, bis das Layout final entschlüsselt ist.
      m.state = { ...m.state, precisePointer: payloadBuf.readUInt32BE(0) };
      if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
    } else if (method === 'preciseData' && payloadBuf.length > 40) {
      // Komplettes Lichtprogramm der Lampe (wird nach Join gepusht) — Layout
      // vollständig entschlüsselt 01.08. (Verifikation gegen App-Export-JSON):
      //   [0-2] Header (unbekannt)  [3] unbekannt  [4-5] 08 00
      //   [6..] Name UTF-16LE + 00, dann 0x01, Zero-Padding bis Offset 53
      //   [53] u32BE Programmversion (= preciseEdit-Pointer!)
      //   [57] u8 Punktzahl INKL. implizitem t=0-Startpunkt (steht nicht im Frame)
      //   [58-66] 9 B Nullen
      //   [67..] Punkte je 9 B: u16BE Minute + 7×u8 Kanal-Prozent
      //   [len-6] u8 Gesamtintensität  [len-5..] 5 B Nullen
      const program = parsePreciseData(payloadBuf);
      if (program) {
        m.lampProgram = program;
        log(`  → Lampenprogramm "${program.name}" (${program.points.length} Punkte, Intensität ${program.intensity} %, Version ${program.version})`);
        // Rück-Verifikation eines eigenen Uploads (Version + Inhalt müssen passen)
        const pend = pendingUploads.get(serial);
        if (pend && program.version === pend.version) {
          pendingUploads.delete(serial);
          if (programMatches(program, pend.program)) {
            log(`  ✓ Upload verifiziert: Lampe meldet das neue Programm (Version ${program.version})`);
          } else {
            log(`  ✗ Upload-Diskrepanz: Version ${program.version} stimmt, INHALT weicht ab — Lampe hat Werte nicht (vollständig) übernommen!`);
          }
        }
      }
      // Volldump einmal je Inhalt sichern (Grundlage für Write-Pfad-Analyse)
      const sig = `preciseDataDump:${serial}:${payloadBuf.toString('hex')}`;
      if (!loggedBinaryOnce.has(sig)) {
        loggedBinaryOnce.add(sig);
        try {
          const dir = path.join(DUMP_DIR, 'precise');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${Date.now()}_preciseData_${serial}.bin`), payloadBuf);
          log(`  → preciseData-Volldump gesichert (${payloadBuf.length} B, ${serial})`);
        } catch (e) { log(`  !! preciseData-Dump fehlgeschlagen: ${e.message}`); }
      }
    } else if (method === 'manualTime' && pl.length >= 2) {
      // Onboard-FW (lokale Firmware-Generation): Restlaufzeit des Manuell-Timers
      // u16BE Sekunden, 0xFFFF = „Always" → null (reef-onboard.mjs)
      const patch = parseRfManualTime(pl);
      if (patch) {
        m.state = { ...m.state, ...patch };
        if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
      }
    } else if (method === 'manualData' && pl.length >= 5) {
      // Onboard-FW: kompletter Manuell-Modus-Zustand (temp, Power-Size-Nibble,
      // Timer, Preset-Liste UTF-16BE mit 7 Kanälen % + Intensität). Legt
      // manualPresets, channelsManual, manualIntensity, manualTimerS an.
      // rfOnboardMode = zuletzt gemeldeter Modus (nur manual/off ableitbar —
      // preciseData meldet keinen Modus, dort bleibt der Stand unbestimmt).
      const patch = parseRfManualData(pl);
      if (patch) {
        m.state = { ...m.state, ...patch, rfOnboardMode: 'manual' };
        if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
      }
    } else if (method === 'offData' && pl.length >= 2) {
      // Onboard-FW: „Lampe aus"-Zustand (temp + Power-Size-Nibble)
      const patch = parseRfOffData(pl);
      if (patch) {
        m.state = { ...m.state, ...patch, rfOnboardMode: 'off' };
        if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
      }
    }
    // (leere temp-Frames: nichts zu parsen — Temp steckt in dashboardData Byte 1)
  }
  // 2b) Altgeräte: Binär-Layouts (Level-Sensor, Thermo, Salinity, Level-Keeper)
  // Layouts aus Live-Captures entschlüsselt (Doku §5c). KEIN NUL-Strip hier —
  // die Altgeräte hängen kein NUL an. Nur exakt bekannte Längen parsen.
  let altParsed = null;
  {
    const pl = payloadBuf;
    if (cls === 'dzRefresh') {
      // Dosing (RFDZ): Parser in reef-doser.mjs liefert Patches je Pumpe —
      // Merge in state.pumps[index-1] (flach pro Pumpe; nicht gemeldete
      // Felder wie Kalibrierdatum/Zeitplan aus settings bleiben erhalten,
      // weil der status-Frame sie nicht enthält).
      const patch = parseDzRefresh(method, pl);
      if (patch) {
        const pumps = Array.isArray(m.state.pumps) ? m.state.pumps.slice(0, 4) : [];
        for (const p of patch.pumps) {
          const i = Number(p.index) - 1;
          if (i < 0 || i > 3) continue;
          const { index, ...fields } = p;
          pumps[i] = { index, ...(pumps[i] || {}), ...fields };
        }
        m.state = { ...m.state, pumps };
        if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
      }
      return;
    }
    if (cls === 'lsRefresh' && method === 'alert') {
      // 1 Byte: Zustands-Push (Onboard-JS: gleiche Code-Tabelle wie data-Byte 1).
      // Das data-Layout weicht semantisch vom Onboard-JS ab (bekannter Bruch —
      // Live-Verifikation folgt), daher hier KEINE Alarm-Ableitung: nur den
      // Roh-Code als lsAlertCode ablegen, damit schnelle Wechsel zwischen zwei
      // data-Frames nicht verloren gehen.
      if (pl.length >= 1) {
        m.state = { ...m.state, lsAlertCode: pl[0] };
        if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
      }
      return;
    }
    if (cls === 'lsRefresh' && method === 'data' && pl.length >= 3) {
      // [index][code][0x00] — Codes live an Svens Geräten verifiziert (02.08.):
      //   Index 0 (unterer Sensor, „Tief"):  0x00 = Alarm, 0x01 = ok, 0x03 = ok
      //   Index 1 (oberer Sensor, „Hoch"):   0x02 = Alarm, 0x00 = ok, 0x03 = ok
      // Belege: Tief rausgehoben → 0x03, dauerhaft trocken → 0x01; Hoch
      // Onboard rot „über" (= Alarm aktiv) bei gleichzeitig 0x02 auf der
      // Leitung (frisch per Join-Refresh erzwungen), komplett aus dem Wasser
      // → 0x00 bei Onboard „O.K.". 0x03 meldet bei beiden den Übergang
      // (frisch trocken), der jeweils zweite ok-Code „stabil trocken".
      // Die alte Bridge-Notiz (0x02 = ok bei Index 1) war invertiert —
      // das erzeugte Fehlalarme „oben", obwohl das Wasser unter dem Sensor stand.
      // Beide Geräte sind werkseitig auf „Alarm, wenn Flüssigkeit ÜBER"
      // konfiguriert, d. h. Alarm-Code = Sensor bedeckt (Wasser ÜBER dem
      // Sensor), ok-Code = nicht bedeckt. Die Richtung ist am Gerät
      // umkonfigurierbar → covered wird über alarmWhen (device-props.json)
      // pro Gerät abgeleitet. Unbekannte Codes: alarm/covered = 'unknown',
      // Roh-Code bleibt erhalten.
      const idx = pl[0], code = pl[1];
      const alarm = idx === 0
        ? (code === 0x00 ? true : (code === 0x01 || code === 0x03) ? false : 'unknown')
        : idx === 1
          ? (code === 0x02 ? true : (code === 0x03 || code === 0x00) ? false : 'unknown')
          : 'unknown';
      // Frische-Stempel NUR für echte Datenframes — das Autolevel-Frische-Gate
      // darf sich nicht auf lsRefresh/alert o. ä. stützen.
      m.lastLsDataTs = Date.now();
      // soundOn (Byte 2: 0 = aus, 1 = an) additiv aus dem Onboard-JS-Layout —
      // die Index/Code-Logik oben bleibt unverändert.
      altParsed = { sensorIndex: idx, code, alarm, covered: deriveCovered(alarm, alarmWhenFor(serial)), soundOn: pl[2] === 1 ? 1 : 0 };
    } else if (cls === 'tcRefresh' && method === 'settings' && pl.length >= 4) {
      // Kurz-Layout (4 B): u32BE @0; >= 1000 → temperatureC = raw/1000
      // (25400 = 25,4 °C, gegen Display kalibriert).
      const raw = pl.readUInt32BE(0);
      if (pl.length === 29) {
        // Lang-Layout (29 B, Live-Frames 01./02.08.): fünf Temperaturen als
        // u16BE/1000 an den Offsets 2/7/11/16/20 (25,5 / 23,0 / 24,0 / 27,0 /
        // 26,0 °C live verifiziert). Wert 1 = Ist-Temperatur, die anderen vier
        // sind mit hoher Wahrscheinlichkeit Soll-/Grenzwerte (Heizen/Kühlen/
        // Alarm) — Zuordnung NICHT verifiziert → neutral sp1..sp4. Tail: 7 B
        // Roh (u. a. 0x81 + fffffd44 = -700, Kalibrier-Offset? — unbestätigt).
        const v = [2, 7, 11, 16, 20].map((o) => pl.readUInt16BE(o) / 1000);
        altParsed = { temperatureC: Math.round(v[0] * 100) / 100, setpoints: v.slice(1), tail: pl.slice(22).toString('hex') };
      } else {
        altParsed = raw >= 1000
          ? { temperatureC: Math.round(raw / 10) / 100 }
          : { thermoRaw: raw };
      }
    } else if (cls === 'sgRefresh' && method === 'alert' && pl.length === 7) {
      // 7-B-Alarmframe: Bedeutung nicht entschlüsselt → wie lsRefresh/alert
      // still akzeptieren, kein State daraus ableiten.
      return;
    } else if (cls === 'sgRefresh' && method === 'settings' && pl.length === 4) {
      // u32BE / 100 → °C (0x0000088b = 21,87 °C).
      altParsed = { temperatureC: pl.readUInt32BE(0) / 100 };
    } else if (cls === 'sgRefresh' && method === 'settings' && pl.length === 51) {
      // Lang-Layout (51 B, Live-Capture RFSG012401300020): rohe Leitfähigkeit,
      // Alarm-Paare je Einheit, Temperatur, Temp-Kalibrier-Offset + abgeleitete
      // Werte (Leitfähigkeit@25 °C, Salinität PSS-78, Dichte). Parser und
      // Formeln (1:1 aus dem Geräte-JS) in reef-salinity.mjs.
      altParsed = parseSgSettings51(pl);
    } else if (cls === 'lkRefresh' && method === 'settings' && pl.length >= 34) {
      altParsed = {
        mode: pl[0],
        calibrationMl: pl.readUInt16BE(4),
        maxRefillRuntimeS: pl.readUInt32BE(25),
        led: pl[33],
        // Additive Onboard-Felder (Geräte-JS-Layout, BE): Statuscode,
        // Kalibrierdatum + fällig, todayMl im settings-Frame, Countdowns,
        // manueller Refill Ist/Soll, Temporary-Off-Rest (reef-onboard.mjs)
        ...parseLkSettingsExtra(pl),
      };
    } else if (cls === 'lkRefresh' && method === 'status' && pl.length >= 9) {
      // Reale Status-Frames sind 9 B (Hex-Dump 02.08.: 9×0x00 im Leerlauf) —
      // das Bridge-Layout (≥12 B, todayMl LE@4, refillRuntimeS BE@8) war zu
      // lang und hat nie geparst. JS-Lesart (statusCode@0, todayMlBe u32BE@1,
      // refillRestS u32BE@5) via parseLkStatusExtra. Legacy-Keys nur, falls
      // doch längere Frames auftauchen; die Endianness-Frage bleibt bis zum
      // Live-Hexframe während eines Refills offen.
      const statusCode = pl[0];
      altParsed = {
        statusCode,
        // Mapping additiv erweitert (Onboard-JS): 2 = manueller Refill,
        // 3 = Kreislauf-Befüllung, 4 = Kalibrierung, 7 = Temporary-Off
        status: LK_STATUS_TEXT[statusCode] ?? 'unknown',
        ...(pl.length >= 12
          ? { todayMl: pl.readUInt32LE(4), refillRuntimeS: pl.readUInt32BE(8) }
          : {}),
        ...parseLkStatusExtra(pl),
      };
    } else if (cls === 'lkRefresh' && method === 'alert' && pl.length >= 1) {
      // Kalibrier-Alarm (Push-Äquivalent zu settings-Byte 10)
      altParsed = parseLkAlert(pl);
    } else if (cls === 'lkRefresh' && method === 'manualRefill' && pl.length >= 8) {
      // Fortschritt manueller Refill: dosiert / Soll (ml)
      altParsed = parseLkManualRefill(pl);
    } else if (cls === 'lkRefresh' && method === 'circuit' && pl.length >= 1) {
      // Kreislauf-Befüllung läuft: Countdown (s)
      altParsed = parseLkCircuit(pl);
    } else if (cls === 'lkRefresh' && method === 'calibration' && pl.length >= 1) {
      // Kalibrierung läuft: Countdown (s)
      altParsed = parseLkCalibration(pl);
    } else if (cls === 'lkRefresh' && method === 'temporary') {
      // Temporary-Off-Countdown (u32BE s). Leerer/NUL-only-Payload = „aus"
      // (Geräte-JS §1.10) → Parser setzt den Restwert auf 0, kein Längen-Gate.
      altParsed = parseLkTemporary(pl);
    } else if (cls === 'lkRefresh' && ['manualRefillStop', 'circuitStop', 'calibrationStop'].includes(method)) {
      // Payload-lose Stopp-Frames (Onboard-JS): Vorgang beendet/abgebrochen —
      // still akzeptieren, kein State daraus ableiten.
      return;
    }
  }
  if (altParsed) {
    m.state = { ...m.state, ...altParsed };
    if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
    return;
  }
  // 3) Unbekannte Binärframes einmal je Gerät/Methode als Hex loggen (Analyse)
  const sig = `${serial}:${cls}/${method}`;
  if (!loggedBinaryOnce.has(sig) && !/Report$/.test(cls)) {
    loggedBinaryOnce.add(sig);
    log(`  ⓘ Binärframe ${sig} (${payloadBuf.length} B): ${payloadBuf.toString('hex').slice(0, 120)}`);
    // Volldump sichern — die Log-Zeile ist auf 120 Hex gekürzt, für das
    // Decoding großer Frames (z. B. dzRefresh/settings 440 B) reicht das nicht.
    try {
      const dir = path.join(DUMP_DIR, 'unknown');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}_${cls}_${method}_${serial}.bin`), payloadBuf);
    } catch { /* Dump ist best effort */ }
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
  // Dosing: Pumpen-Parameter 1–4 validieren (KH/CA/MG/Jod)
  const dzPump = () => {
    const pump = Number(params.pump);
    if (!Number.isInteger(pump) || pump < 1 || pump > 4) throw new Error('pump 1–4 erwartet');
    return pump;
  };
  const dzMl = (v, label = 'ml') => {
    const ml = Number(v);
    if (!Number.isFinite(ml) || ml <= 0 || ml > 100000) throw new Error(`${label} 0–100000 erwartet`);
    return ml;
  };
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
      // VERIFIZIERT 02.08. gegen App-Mitschnitt: swSet/settings trägt NUR das
      // schedule-Array mit dem Modus-Objekt (mode 1: {mode,time,speed};
      // mode 4: {mode,time,minSpeed,maxSpeed,period}), Payload endet mit NUL.
      const s = cur.settings || {};
      const schedule = Array.isArray(s.schedule) && s.schedule.length
        ? JSON.parse(JSON.stringify(s.schedule))
        : [{ mode: cur.mode ?? 1, time: 0, speed: cur.speed ?? 0 }];
      for (const e of schedule) {
        if ('minSpeed' in e || 'maxSpeed' in e) {
          // Mode 4 „Zufällig": min/max/period einzeln änderbar (App-UI:
          // Minimale/Maximale Leistung %, Frequenz s = period/1000)
          if (params.speed != null || params.maxSpeed != null) e.maxSpeed = Number(params.maxSpeed ?? params.speed);
          if (params.minSpeed != null) e.minSpeed = Number(params.minSpeed);
          if (params.period != null) e.period = Number(params.period);
        } else {
          if (params.speed != null) e.speed = Number(params.speed);
        }
      }
      // WICHTIG: Payload OHNE abschließendes NUL — encodeFrame hängt das
      // Feld-Terminator-NUL selbst an. Doppel-NUL ließ die Pumpe den Frame
      // still ignorieren (Bug 02.08.); das NUL im Mitschnitt-Payload IST der
      // Terminator, nicht Teil des Inhalts.
      return ['swSet', 'settings', latin1(JSON.stringify({ schedule }))];
    }
    case 'wave:feed':
      // VERIFIZIERT 02.08. gegen App-Mitschnitt: swSet/feed {"command":0}
      // (Payload ohne NUL — Terminator kommt von encodeFrame, s. swSet/settings)
      return ['swSet', 'feed', latin1(JSON.stringify({ command: 0 }))];
    case 'wave:setSchedule': {
      // VERIFIZIERT 02.08. gegen App-Mitschnitt (gemischter Tagesplan):
      // mode 1 Konstant {speed}; mode 2 Puls / 3 Sinus / 4 Zufällig
      // {minSpeed,maxSpeed,period}. time = Startminute des Blocks; der Tag
      // beginnt bei 0, Blöcke laufen bis zum nächsten time (bzw. 1440).
      const list = Array.isArray(params.schedule) ? params.schedule : [];
      if (!list.length) throw new Error('schedule leer');
      const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
      const clean = list.map((e) => {
        const mode = Number(e?.mode);
        const time = Math.min(1439, Math.max(0, Math.round(Number(e?.time) || 0)));
        if (mode === 1) return { mode: 1, time, speed: pct(e?.speed) };
        if (![2, 3, 4].includes(mode)) throw new Error(`unbekannter Wave-Modus ${mode}`);
        return {
          mode, time,
          minSpeed: pct(e?.minSpeed),
          maxSpeed: pct(e?.maxSpeed),
          period: Math.min(60000, Math.max(500, Math.round(Number(e?.period) || 10000))),
        };
      }).sort((a, b) => a.time - b.time);
      clean[0].time = 0; // Tag beginnt immer bei 0 (App-Verhalten)
      return ['swSet', 'settings', latin1(JSON.stringify({ schedule: clean }))];
    }
    case 'roller:feed':    // ✅ live verifiziert 01.08. (srLog/used + srReport/all als Antwort)
      return ['srExecute', 'manual', latin1(JSON.stringify({ length: Number(params.mm ?? params.length ?? 30) }))];
    case 'roller:newRoll': // ✅ live verifiziert 02.08. gegen App-Mitschnitt: {"diameter":-1}
      return ['srSet', 'newRoll', latin1(JSON.stringify({ diameter: -1 }))];
    case 'roller:setMode': { // ✅ live verifiziert 02.08. gegen App-Mitschnitt: {"type":0|1}
      const type = Number(params.type ?? (params.mode === 'auto' ? 1 : 0));
      return ['srSet', 'mode', latin1(JSON.stringify({ type: type === 1 ? 1 : 0 }))];
    }
    case 'salinity:calibrateTemp': {
      // sgSet/calibrationTemperature: Referenztemperatur °C als s32BE ×10000
      // (Geräte-JS: Math.round(°C × 1e4)). Nur mit Referenzthermometer sinnvoll.
      const tempC = Number(params.temperature);
      if (!Number.isFinite(tempC) || tempC < 0 || tempC > 40) {
        throw new Error('Referenztemperatur außerhalb 0–40 °C');
      }
      return ['sgSet', 'calibrationTemperature', sgCalibrateTempPayload(tempC)];
    }
    case 'salinity:calibrateMain':
      // sgSet/calibrationMain: 1 Byte 0x00 (Geräte-JS: Uint8Array mit e[0]=0).
      // Nur mit Referenzlösung — die Sonde muss darin liegen!
      return ['sgSet', 'calibrationMain', SG_CALIBRATE_MAIN_PAYLOAD];
    case 'salinity:unit': {
      // sgSet/unitSalinity: 1 Byte Einheit-Index (Geräte-JS: 255 & T).
      // Vorbereitet, UI folgt (hat bewusst noch keinen UI-Aufrufer).
      const idx = Number(params.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new Error('unit index 0–3 erwartet');
      return ['sgSet', 'unitSalinity', [idx & 255]];
    }
    case 'salinity:sound':
      // sgSound/on|off ohne Payload (Geräte-JS: send mit void 0).
      // Vorbereitet, UI folgt (hat bewusst noch keinen UI-Aufrufer).
      return ['sgSound', onOff(params.on) ? 'on' : 'off', []];
    // ---------- Level Keeper (RFLK, Onboard-Protokoll — Frames aus dem Geräte-JS) ----------
    case 'level:setMode': {
      // lkSet/settings: u8 Modus 0–5 (0=AUS, 1=60min, 2=30min, 3=10min, 4=∞, 5=Hysterese)
      const mode = Number(params.mode);
      if (!Number.isInteger(mode) || mode < 0 || mode > 5) throw new Error('mode 0–5 erwartet');
      return ['lkSet', 'settings', [mode]];
    }
    case 'level:setMaxRefillTime': {
      // lkSet/maxRefillTime: u32BE Sekunden (0 = Watchdog aus, max. 60 min)
      const s = Number(params.seconds);
      if (!Number.isFinite(s) || s < 0 || s > 3600) throw new Error('seconds 0–3600 erwartet');
      return ['lkSet', 'maxRefillTime', u32be(s)];
    }
    case 'level:temporaryOff': {
      // lkSet/temporaryOff: u32BE Sekunden (max. 60 min)
      const s = Number(params.seconds);
      if (!Number.isFinite(s) || s < 0 || s > 3600) throw new Error('seconds 0–3600 erwartet');
      return ['lkSet', 'temporaryOff', u32be(s)];
    }
    case 'level:setLight':
      // lkSet/light: u8 (1 = an, 0 = aus)
      return ['lkSet', 'light', [onOff(params.on)]];
    case 'level:calibrateTime': {
      // lkCalibration/time: u8 Dauer in s (0–255)
      const s = Number(params.seconds);
      if (!Number.isInteger(s) || s < 0 || s > 255) throw new Error('seconds 0–255 erwartet');
      return ['lkCalibration', 'time', [s]];
    }
    case 'level:calibrateStart':
      return ['lkCalibration', 'start', []];
    case 'level:calibrateStop':
      return ['lkCalibration', 'stop', []];
    case 'level:circuitStart':
      return ['lkCalibration', 'circuitStart', []];
    case 'level:circuitStop':
      return ['lkCalibration', 'circuitStop', []];
    case 'level:calibrateValue': {
      // lkCalibration/value: u32BE tatsächlich abgegebene Menge ml (max. 100 000)
      const ml = Number(params.ml);
      if (!Number.isFinite(ml) || ml < 0 || ml > 100000) throw new Error('ml 0–100000 erwartet');
      return ['lkCalibration', 'value', u32be(ml)];
    }
    case 'level:calibrateNotification': {
      // lkCalibration/notification: u8 Erinnerungs-Index 0–3 (1 W / 2 W / 1 M / 3 M)
      const idx = Number(params.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new Error('index 0–3 erwartet');
      return ['lkCalibration', 'notification', [idx]];
    }
    case 'level:manualRefill': {
      // lkManualRefill/start: u32BE Sollmenge ml (max. 100 000)
      const ml = Number(params.ml);
      if (!Number.isFinite(ml) || ml <= 0 || ml > 100000) throw new Error('ml 1–100000 erwartet');
      return ['lkManualRefill', 'start', u32be(ml)];
    }
    case 'level:manualRefillStop':
      return ['lkManualRefill', 'stop', []];
    // ---------- Level Sensor (RFLS, Onboard-Protokoll) ----------
    case 'levelSensor:sound':
      // lsSound/on|off ohne Payload (Geräte-JS: setSound)
      return ['lsSound', onOff(params.on) ? 'on' : 'off', []];
    case 'levelSensor:trigger': {
      // lsTrigger/low|high ohne Payload — Alarm-Richtung am Gerät setzen
      const dir = params.direction === 'high' ? 'high' : params.direction === 'low' ? 'low' : null;
      if (!dir) throw new Error("direction 'low'|'high' erwartet");
      return ['lsTrigger', dir, []];
    }
    // ---------- Dosing (RFDZ, Onboard-Protokoll — Frames aus dem Geräte-JS) ----------
    case 'doser:setName': {
      // dzSet/name: [pump][Name UTF-16BE][00 00] (max. 16 Zeichen)
      const pump = dzPump();
      const name = String(params.name ?? '').trim();
      if (!name || [...name].length > 16) throw new Error('name 1–16 Zeichen erwartet');
      return ['dzSet', 'name', dzSetNamePayload(pump, name)];
    }
    case 'doser:setContainer': {
      // dzSet/container: [pump][u32BE Füllstand ×100][u32BE Kapazität ×100]
      const pump = dzPump();
      const currentMl = Number(params.currentMl);
      const capacityMl = dzMl(params.capacityMl, 'capacityMl');
      if (!Number.isFinite(currentMl) || currentMl < 0 || currentMl > 100000) {
        throw new Error('currentMl 0–100000 erwartet');
      }
      return ['dzSet', 'container', dzSetContainerPayload(pump, currentMl, capacityMl)];
    }
    case 'doser:setSchedule': {
      // dzSet/doses: [pump][count][je Slot u32BE ml ×100 + u16BE Minute][K u8]
      const pump = dzPump();
      const slots = Array.isArray(params.slots) ? params.slots : [];
      if (!slots.length || slots.length > 24) throw new Error('slots 1–24 erwartet');
      const clean = slots.map((s) => {
        const ml = dzMl(s?.ml, 'slot ml');
        const minutes = Number(s?.minutes);
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
          throw new Error('slot minutes 0–1439 erwartet');
        }
        return { ml, minutes };
      }).sort((a, b) => a.minutes - b.minutes);
      const mask = Number(params.weekdayMask);
      if (!Number.isInteger(mask) || mask < 0 || mask > 127) throw new Error('weekdayMask 0–127 erwartet');
      return ['dzSet', 'doses', dzSetDosesPayload(pump, clean, mask)];
    }
    case 'doser:skipNext': {
      // dzSet/skipNext: [pump][Wert u8, 0..100] — Semantik des Werts (vermutlich
      // Prozent) nicht verifiziert; Default 100 wie das Geräte-UI-Maximum.
      const pump = dzPump();
      const v = params.value === undefined ? 100 : Number(params.value);
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error('value 0–100 erwartet');
      return ['dzSet', 'skipNext', dzSkipNextPayload(pump, v)];
    }
    case 'doser:cancelSkip':
      return ['dzSet', 'cancelSkip', dzPumpPayload(dzPump())];
    case 'doser:calibrateStart':
      return ['dzCalibration', 'start', dzPumpPayload(dzPump())];
    case 'doser:calibrateStop':
      return ['dzCalibration', 'stop', dzPumpPayload(dzPump())];
    case 'doser:circuitStart':
      return ['dzCalibration', 'circuitStart', dzPumpPayload(dzPump())];
    case 'doser:circuitStop':
      return ['dzCalibration', 'circuitStop', dzPumpPayload(dzPump())];
    case 'doser:calibrateValue': {
      // dzCalibration/value: [pump][u32BE gemessene Menge ×100]
      const pump = dzPump();
      return ['dzCalibration', 'value', dzCalibrateValuePayload(pump, dzMl(params.ml))];
    }
    case 'doser:calibrateNotification': {
      // dzCalibration/notification: [pump][Intervall u8: 0=1W, 1=2W, 2=1M, 3=3M]
      const pump = dzPump();
      const idx = Number(params.interval);
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new Error('interval 0–3 erwartet');
      return ['dzCalibration', 'notification', dzCalibrateNotifyPayload(pump, idx)];
    }
    case 'doser:manualDose': {
      // dzManualRefill/start: Modus 0 = sofort dosieren (11 B)
      const pump = dzPump();
      return ['dzManualRefill', 'start', dzManualRefillStartPayload(pump, dzMl(params.ml))];
    }
    case 'doser:manualStop':
      return ['dzManualRefill', 'stop', dzPumpPayload(dzPump())];
    // ---------- Reef Flare (RFRF, Onboard-Protokoll der lokalen Firmware) ----------
    case 'flare:setManual': {
      // rfManual/update: komplette Preset-Liste (Report-Layout). Basis = die
      // aktuellen Presets aus dem State (manualPresets); das aktive Preset
      // bekommt die neuen Kanäle/Intensität. Ohne State-Basis: 1 Preset „Manual".
      const ch = Array.isArray(params.channels)
        ? params.channels.slice(0, 7).map((v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0))))
        : null;
      if (!ch || ch.length !== 7) throw new Error('channels: 7 Werte (%) erwartet');
      const intensity = Math.min(100, Math.max(0, Math.round(Number(params.intensity ?? 100) || 0)));
      const curPresets = Array.isArray(cur.manualPresets) ? cur.manualPresets : [];
      let presets;
      if (curPresets.length) {
        let sel = curPresets.findIndex((p) => p && p.selected);
        if (sel < 0) sel = 0;
        presets = curPresets.slice(0, 8).map((p, i) => ({
          name: String(p?.name ?? `Preset ${i + 1}`),
          selected: i === sel,
          channels: i === sel ? ch : (Array.isArray(p?.channels) ? p.channels : [0, 0, 0, 0, 0, 0, 0]),
          intensity: i === sel ? intensity : (Number.isFinite(p?.intensity) ? p.intensity : 100),
        }));
      } else {
        presets = [{ name: 'Manual', selected: true, channels: ch, intensity }];
      }
      return ['rfManual', 'update', rfManualUpdatePayload(presets)];
    }
    case 'flare:manualTime':
      // rfManual/time: u16BE Sekunden, 0xFFFF = „Always" (seconds 'always'/null)
      return ['rfManual', 'time', rfManualTimePayload(params.seconds)];
    case 'flare:setMode': {
      // rfMode: Methode = Modusname, kein Payload
      const mode = String(params.mode);
      if (!['manual', 'precise', 'off'].includes(mode)) throw new Error("mode 'manual'|'precise'|'off' erwartet");
      return ['rfMode', mode, []];
    }
    case 'flare:preciseSelect': {
      // rfPrecise/select: u8 Preset-Index
      const idx = Number(params.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 7) throw new Error('index 0–7 erwartet');
      return ['rfPrecise', 'select', [idx]];
    }
    default:
      throw new Error(`unknown action ${action} für family ${fam}`);
  }
}

// Nach Schreibbefehlen an die Dosierpumpe frische Einstellungen anfordern
// (dzGet/settings [pump]), damit der State zeitnah das Geräte-Echo abbildet —
// Muster wie der rfPrecise/pointer-Sync nach dem Programm-Upload.
function scheduleDoserRefresh(serial, action, ap) {
  if (!String(action).startsWith('doser:')) return;
  const pump = Number(ap?.pump);
  if (!Number.isInteger(pump) || pump < 1 || pump > 4) return;
  setTimeout(() => {
    const dev = devices.get(serial);
    if (dev && dev.readyState === dev.OPEN) {
      const buf = encodeFrame('dzGet', 'settings', dzGetSettingsPayload(pump), serial);
      captureFrame(buf, 'out', serial);
      dev.send(buf);
      log(`  → dzGet/settings [${pump}] angefordert (Refresh nach ${action})`);
    }
  }, 1500);
}

async function handleTunnelRequest(method, params) {
  if (method === 'listDevices') {
    return [...deviceMeta.keys()].map(snapshot);
  }
  if (method === 'command') {
    const { serial, action, params: ap = {} } = params;
    // Jebao-Branch: Gizwits-LAN-Client, nicht das RF-Frame-Protokoll
    if (isJebaoTarget(serial, action)) {
      const r = await handleJebaoCommand(serial, action, ap);
      log(`  [tunnel] jebao command ${action} → ${serial}`);
      return r;
    }
    const dev = devices.get(serial);
    if (!dev || dev.readyState !== dev.OPEN) throw new Error(`Gerät ${serial} nicht verbunden`);
    const [cls, mth, payload] = buildCommandFrame(serial, action, ap);
    log(`  [tunnel] command ${action} → ${serial}: ${cls}/${mth}`);
    const buf = encodeFrame(cls, mth, payload, serial);
    captureFrame(buf, 'out', serial);
    dev.send(buf);
    scheduleDoserRefresh(serial, action, ap);
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

// Tunnel (neu) starten — beim Serverstart und nach dem Setup-Wizard ohne Restart.
function launchTunnel(reason = 'Start') {
  try { tunnel?.stop?.(); } catch {}
  tunnel = null;
  if (!TUNNEL_TOKEN || !TUNNEL_URL) {
    log('Tunnel deaktiviert (kein TUNNEL_TOKEN/TUNNEL_URL in .env / /boot/reef-cloud.env)');
    return;
  }
  tunnel = startTunnel({
    url: TUNNEL_URL,
    token: TUNNEL_TOKEN,
    log,
    getSnapshots: () => [...deviceMeta.keys()].map(snapshot),
    handleRequest: handleTunnelRequest,
  });
  log(`Tunnel aktiviert (${reason}) → ${TUNNEL_URL} [${TUNNEL_TYPE}: ${TUNNEL_LABEL}]`);
}
launchTunnel();

// ---------- Verbindungs-Registry ----------
const devices = new Map(); // serial → ws
const apps = new Set();    // app websockets
const joins = new Map();   // serial → Set<appWs>  (welche App hat welches Gerät abonniert)

// Ablaufschacht-Stabilisierung (siehe reef-autolevel.mjs): Level-Sensoren
// regeln die RFP-Stärke. Config autolevel.json (Laufzeitdaten, .gitignore).
const autolevel = createAutolevel({
  dir: __dirname, log, metaFor, devices, buildCommandFrame, encodeFrame, captureFrame,
});

// Auto-Update über das Git-Repo (siehe reef-updater.mjs): täglicher Check
// gegen origin/main, Installation nur manuell aus der UI angestoßen.
const updater = createUpdater({ dir: __dirname, log });

// ====================================================================
// Jebao-Strömungspumpen (Gizwits-LAN, reef-jebao.mjs)
// ====================================================================
// Konfiguration: jebao.json im Server-Verzeichnis (Laufzeitdaten, .gitignore —
// Muster wie names.json/device-ips.json; Vorlage: jebao.example.json):
//   [{ "ip": "…", "name": "…", "productKey": "…" (optional) }]
// Fehlende/defekte Datei = keine Jebao-Geräte (tolerant).
// Serial-Schema: "JEBAO-" + MAC-Suffix (z. B. JEBAO-12C648), aus der gerichteten
// Discovery gelernt und in jebao.json zurückgeschrieben; Fallback (Pumpe offline
// beim Start): "JEBAO-" + IP mit Bindestrichen.
// Die Pumpe ist KEIN WS-Client — Online/Offline läuft über jebaoOnline und die
// Events des JebaoClient (connect/disconnect), nicht über die devices-Registry.
const JEBAO_FILE = path.join(__dirname, 'jebao.json');
const jebaoClients = new Map(); // serial → JebaoClient
const jebaoOnline = new Set();  // Serials mit aktivem Login (Keepalive läuft)
let jebaoConfig = [];
try {
  const raw = JSON.parse(fs.readFileSync(JEBAO_FILE, 'utf8'));
  if (Array.isArray(raw)) {
    jebaoConfig = raw
      .filter((e) => e && typeof e.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(e.ip))
      .map((e) => ({
        ip: String(e.ip),
        name: String(e.name ?? '').slice(0, 40),
        ...(e.serial ? { serial: String(e.serial) } : {}),
        ...(e.mac ? { mac: String(e.mac) } : {}),
        ...(e.productKey ? { productKey: String(e.productKey) } : {}),
        ...(e.firmware ? { firmware: String(e.firmware) } : {}),
      }));
  }
  if (jebaoConfig.length) log(`Jebao: ${jebaoConfig.length} Pumpe(n) aus jebao.json geladen`);
} catch { /* Datei optional oder defekt → ohne Jebao-Geräte starten */ }

let jebaoSaveTimer = null;
function saveJebaoConfig() {
  // Entprellt + atomar (Muster saveIps)
  if (jebaoSaveTimer) return;
  jebaoSaveTimer = setTimeout(() => {
    jebaoSaveTimer = null;
    try {
      const tmp = JEBAO_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(jebaoConfig, null, 2) + '\n');
      fs.renameSync(tmp, JEBAO_FILE);
    } catch (e) { log(`!! jebao.json nicht geschrieben: ${e.message}`); }
  }, 500);
  jebaoSaveTimer.unref();
}

const jebaoSerialFromMac = (mac) => 'JEBAO-' + mac.replace(/:/g, '').slice(-6).toUpperCase();
const jebaoFallbackSerial = (ip) => 'JEBAO-' + ip.replace(/\./g, '-');

// Jebao-Status (dekodiert) in den Geräte-State spiegeln — selbe announce/
// saveStates-Strecke wie die WS-Geräte.
function jebaoApplyStatus(serial, st) {
  const m = metaFor(serial);
  const before = JSON.stringify(m.state);
  m.state = { ...m.state, ...st };
  m.lastSeen = Date.now();
  if (JSON.stringify(m.state) !== before) { announce(serial); saveStates(); }
}

// Identität per gerichteter Discovery lernen (MAC → Serial, Firmware) und
// Client starten. Fehler (Pumpe offline) sind tolerant — der Client reconnectet.
async function startJebaoPump(entry) {
  let serial = entry.serial || null;
  try {
    const found = await jebaoDiscover({ ip: entry.ip, timeoutMs: 1500, retries: 2 });
    const d = found.find((x) => x.ip === entry.ip) || found[0];
    if (d && d.mac) {
      serial = jebaoSerialFromMac(d.mac);
      let changed = false;
      if (entry.serial !== serial) { entry.serial = serial; changed = true; }
      if (entry.mac !== d.mac) { entry.mac = d.mac; changed = true; }
      if (d.productKey && entry.productKey !== d.productKey) { entry.productKey = d.productKey; changed = true; }
      if (d.firmware && entry.firmware !== d.firmware) { entry.firmware = d.firmware; changed = true; }
      if (changed) saveJebaoConfig();
    }
  } catch { /* Discovery optional — Fallback-Serial unten */ }
  if (!serial) serial = jebaoFallbackSerial(entry.ip);
  const m = metaFor(serial);
  m.family = 'jebao';
  m.name = entry.name || m.name;
  m.ip = entry.ip;
  if (entry.firmware) m.firmware = entry.firmware;
  if (jebaoClients.has(serial)) return serial; // Doppelstart vermeiden
  const client = new JebaoClient(entry.ip);
  jebaoClients.set(serial, client);
  client.on('connect', () => {
    jebaoOnline.add(serial);
    const mm = metaFor(serial);
    mm.reachable = true;
    mm.lastSeen = Date.now();
    log(`Jebao ${serial} (${entry.ip}) verbunden`);
    announce(serial, true);
  });
  client.on('status', (st) => jebaoApplyStatus(serial, st));
  client.on('disconnect', () => {
    jebaoOnline.delete(serial);
    const mm = metaFor(serial);
    mm.reachable = false;
    log(`Jebao ${serial} (${entry.ip}) getrennt — Reconnect mit Backoff läuft`);
    announce(serial, true);
  });
  client.on('error', (e) => log(`!! Jebao ${serial} (${entry.ip}): ${e.message}`));
  client.connect(); // Verbindungsschleife — wirft nicht (Fehler via Events)
  return serial;
}

function stopJebaoPump(entry) {
  for (const [serial, client] of jebaoClients) {
    if (client.ip !== entry.ip) continue;
    client.close();
    jebaoClients.delete(serial);
    jebaoOnline.delete(serial);
    deviceMeta.delete(serial); // aus Geräteliste/Tunnel entfernen
    log(`Jebao ${serial} (${entry.ip}) entfernt`);
  }
}

// Befehls-Dispatch für jebao:* — NICHT über buildCommandFrame (das ist das
// RF-5-Felder-Protokoll). Aktionen (Präfix jebao: optional): setPower {on},
// setMode {mode 0–3}, setFlow {0–100}, setFrequency {0–100}, setFeed {on},
// setFeedTime {minutes 1–255}. Nach dem Write Status zur Bestätigung lesen.
async function handleJebaoCommand(serial, action, ap = {}) {
  const client = jebaoClients.get(serial);
  if (!client || !client.connected) throw new Error(`Jebao-Pumpe ${serial} nicht verbunden`);
  const act = String(action).replace(/^jebao:/, '');
  const onOff = (v) => v === true || v === 1 || v === '1' || v === 'on';
  const pct = (v, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${label} 0–100 erwartet`);
    return n;
  };
  let updates;
  switch (act) {
    case 'setPower': updates = { SwitchON: onOff(ap.on) }; break;
    case 'setMode': {
      const mode = Number(ap.mode);
      if (!Number.isInteger(mode) || mode < 0 || mode > 3) throw new Error('mode 0–3 erwartet');
      updates = { Mode: mode };
      break;
    }
    case 'setFlow': updates = { Flow: pct(ap.flow ?? ap.value, 'flow') }; break;
    case 'setFrequency': updates = { Frequency: pct(ap.frequency ?? ap.value, 'frequency') }; break;
    case 'setFeed': updates = { FeedSwitch: onOff(ap.on) }; break;
    case 'setFeedTime': {
      const minutes = Number(ap.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 255) throw new Error('minutes 1–255 erwartet');
      updates = { FeedTime: minutes };
      break;
    }
    default: throw new Error(`unknown action ${action} für family jebao`);
  }
  await client.writeDatapoints(updates);
  // Bestätigung: Status frisch lesen (die Pumpe bestätigt mit 0x94, der
  // Voll-Status aus 0x90/0x91 ist die zuverlässigere Quelle fürs UI)
  setTimeout(() => client.readStatus().catch((e) => log(`!! Jebao ${serial}: Status-Refresh nach ${act}: ${e.message}`)), 400);
  return { ok: true };
}

const isJebaoTarget = (serial, action) =>
  String(action).startsWith('jebao:') || deviceMeta.get(serial)?.family === 'jebao';

// Scan-Endpunkt-Helfer: geteilte In-Flight-Promise (parallele UI-Requests
// warten auf dieselbe Discovery), Broadcast im LAN.
let jebaoScanInflight = null;
function jebaoScan() {
  if (!jebaoScanInflight) {
    jebaoScanInflight = (async () => {
      try {
        const devices = await jebaoDiscover({ timeoutMs: 2500, retries: 3 });
        return { devices, scannedAt: Date.now() };
      } catch (e) {
        return { devices: [], error: e.message, scannedAt: Date.now() };
      }
    })().finally(() => { jebaoScanInflight = null; });
  }
  return jebaoScanInflight;
}

// Beim Start alle konfigurierten Pumpen verbinden (async, Fehler nur im Log)
for (const entry of jebaoConfig) startJebaoPump(entry);

// Self-Exit nach Update/Neustart: erst antworten, dann ~1 s später beenden.
// Unter systemd (Restart=always, deploy/reef-cloud.service) kommt der Server
// mit neuem Code zurück; im Dev muss manuell neu gestartet werden (die UI
// sagt das über autoRestart=false).
function scheduleSelfExit(reason) {
  log(`  [system] ${reason} — Server beendet sich in 1 s${process.env.INVOCATION_ID ? ' (systemd startet neu)' : ' (kein systemd: manuell neu starten!)'}`);
  setTimeout(() => process.exit(0), 1000);
}
// Rate-Limit für /api/server/restart: binnen 10 s nach dem letzten Aufruf
// wird abgelehnt (Doppelklick/UI-Spam).
let lastRestartAt = 0;

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
// Log-Drossel für periodische Push-Klassen (Refresh/Report): Manche Geräte
// (v. a. Thermo control, tcRefresh/settings alle 1–2 s) fluten das Log.
// State-Updates und Capture laufen weiter pro Frame — nur die Logzeile wird
// auf 1×/60 s pro Gerät+Klasse begrenzt, mit Zähler der übersprungenen Frames.
const logThrottle = new Map(); // key → { last, skipped }
function throttledFrameLog(peer, f, size) {
  const key = `${f.serial}|${f.cls}/${f.method}`;
  const now = Date.now();
  const t = logThrottle.get(key);
  if (t && now - t.last < 60000) { t.skipped++; return; }
  const extra = t && t.skipped ? ` (×${t.skipped + 1} seit letzter Logzeile)` : '';
  logThrottle.set(key, { last: now, skipped: 0 });
  log(`  [${peer}] << ${f.cls}/${f.method} serial="${f.serial}" extra="${f.extra}" (${size} B)${extra}`);
}

function handleDeviceFrame(ws, buf, peer) {
  const f = decodeFrame(buf);
  if (/(Refresh|Report)\//.test(`${f.cls}/${f.method}`)) throttledFrameLog(peer, f, buf.length);
  else log(`  [${peer}] << ${f.cls}/${f.method} serial="${f.serial}" extra="${f.extra}" (${buf.length} B)`);
  captureFrame(buf, 'in', ws.deviceIp);

  if (f.cls === 'geConnect' && f.method === 'login') {
    // Neue Firmware (1.4.x/1.5.x): JSON-Login → geReport/login + geSet/time (JSON)
    if (f.serial && f.serial !== '0000000000000000') {
      devices.set(f.serial, ws); ws.deviceSerial = f.serial; ensureDeviceRegistered(f.serial);
      // Tunnel-Meta: IP, Firmware, online
      const meta = metaFor(f.serial);
      meta.ip = ws.deviceIp || meta.ip;
      meta.lastSeen = Date.now();
      if (ws.deviceIp) { knownIps.set(f.serial, ws.deviceIp); saveIps(); }
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
      if (ws.deviceIp) { knownIps.set(f.serial, ws.deviceIp); saveIps(); }
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
    // Account-Key maskiert loggen: das Klartext-Log liegt ungeschützt neben
    // dem Server. E-Mail bleibt sichtbar (Owner-Identifikation im LAN-Kontext),
    // der Key (Reef-Factory-Account-Geheimnis) nur als Präfix zum Wiedererkennen.
    const maskedKey = key ? key.slice(0, 2) + '***' : key;
    log(`  → Altgerät ${f.serial} eingeloggt (email=${email}, key=${maskedKey}, version=${version})`);
    // Altgeräte-Priming: <prefix>Connect/join nachschieben (Payload = serial\0,
    // extra = join_-Tag, exakt wie die App — Original-Mitschnitt 0023). Erst dann
    // starten die Geräte ihre Periodik (z. B. Flare dashboardData alle ~5 s) —
    // ohne Join fließen Daten nur, solange eine App gejoint ist. Präfix je Familie:
    // flare=rf, salinity=sg, thermo=tc, levelSensor=ls, level=lk (Level Keeper).
    // Ein falsches Präfix wäre unkritisch: das Gerät ignoriert unbekannte Klassen.
    const JOIN_PREFIX = { flare: 'rf', salinity: 'sg', thermo: 'tc', levelSensor: 'ls', level: 'lk', doser: 'dz' };
    if (f.serial && f.serial !== '0000000000000000') {
      const jp = JOIN_PREFIX[metaFor(f.serial).family];
      if (jp) {
        const buf = encodeFrame(`${jp}Connect`, 'join', [...latin1(f.serial), 0], f.serial, `join_${Date.now()}`);
        captureFrame(buf, 'out', f.serial);
        ws.send(buf);
        log(`  → ${jp}Connect/join gesendet (Priming, startet Periodik)`);
      }
    }
    return;
  }
  if (f.cls === 'user' && f.method === 'logout') {
    // Altgeräte-Logout: Bestätigung status/logout "ok" + Gerät abmelden.
    // Nur die aktuell registrierte Verbindung darf die Online-Registry leeren —
    // nach Power-Cycle/Reconnect können alte Sockets sonst das neue Login löschen.
    send(ws, 'status', 'logout', latin1('ok'), f.serial);
    if (ws.deviceSerial) {
      const serial = ws.deviceSerial;
      if (devices.get(serial) === ws) {
        devices.delete(serial);
        log(`  → Altgerät ${serial} abgemeldet`);
      } else {
        log(`  → Altgerät ${serial}: Logout auf alter Verbindung ignoriert`);
      }
      ws.deviceSerial = null;
    }
    return;
  }
  // Alles andere vom Gerät: State fürs Tunnel-Snapshot pflegen + an abonnierende Apps weiterreichen
  if (f.serial && f.serial !== '0000000000000000') {
    // „zuletzt gesehen" bei JEDEM Geräte-Frame frisch halten — nicht nur beim
    // Login (updateState stempelt ebenfalls; hier explizit, damit es auch für
    // Frame-Arten gilt, die den State-Pfad nicht durchlaufen).
    metaFor(f.serial).lastSeen = Date.now();
    updateState(f.serial, f.cls, f.method, f.payload);
    autolevel.onStateUpdate(f.serial); // Ablaufschacht-Stabilisierung (wirft nie)
  }
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
    if (/(Set|Execute|Manual|Log|Precise)\//.test(key)) {
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
// Zertifikat sicherstellen: fehlt es (z. B. frisches Pi-Image), wird es hier
// automatisch selbst-signiert erzeugt (CN/SAN api.reeffactory.com, CA, 10 Jahre).
const { certPem: cert, keyPem: key, info: certInfo } = await ensureCertificate(__dirname, log);
log(`TLS-Zertifikat bereit: CN=${certInfo.cn}, Fingerprint ${certInfo.fingerprint256 || '?'}${certInfo.generated ? ' (neu erzeugt)' : ''}`);

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
    // WS-Payload-Limit: echte Geräte-/App-Frames sind wenige KB groß;
    // der ws-Default (100 MiB) erlaubt Memory-Pressure per Riesenframe.
    maxPayload: 1 * 1024 * 1024,
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
        const serial = ws.deviceSerial;
        for (const set of joins.values()) set.delete(ws);
        // Nur die aktuell registrierte Verbindung darf offline melden. Beim
        // Power-Cycle bauen Geräte oft die neue Verbindung auf, bevor die alte
        // endgültig geschlossen wird; sonst löscht der späte Close das neue Login.
        if (devices.get(serial) === ws) {
          devices.delete(serial);
          announce(serial, true); // Tunnel: Gerät offline melden
          log(`=== ${role}-Close: ${peer} (${serial} abgemeldet) code=${code} ===`);
        } else {
          log(`=== ${role}-Close: ${peer} (alte Verbindung ${serial}, aktive bleibt) code=${code} ===`);
        }
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

// ====================================================================
// Web-UI + JSON-API (Port 8080) — Dashboard aus webui/dist (npm run build)
// ====================================================================
// Endpunkte:
//   GET  /api/devices  → { devices: [deviceSnapshot…], now }      (alle bekannten, auch offline)
//   POST /api/devices/name { serial, name } → Spitzname setzen/ändern (leer = löschen)
//   POST /api/devices/props { serial, alarmWhen } → Level-Sensor: Alarm-Richtung 'above'|'below'
//   GET  /api/settings → Tunnel-Einstellungen (ohne Token)
//   POST /api/settings { tunnelUrl?, tunnelToken?, tunnelType?, tunnelLabel? } → speichern + Tunnel neu starten
//   POST /api/command  { serial, action, params } → Steuerung wie Tunnel-command
//   GET  /api/capture  → { capture, frames }      POST /api/capture { on } → Schalter
//   GET  /api/onboarding/scan → { networks: [{ssid, signal, rfLike}], scannedAt } (WLAN-Scan am Host)
//   GET  /api/jebao → konfigurierte Jebao-Pumpen (jebao.json)
//   POST /api/jebao { ip, name?, productKey? } → Pumpe hinzufügen + verbinden
//   DELETE /api/jebao { ip } → Pumpe entfernen
//   GET  /api/jebao/scan → { devices: [{ip, did, mac, firmware, productKey}], scannedAt } (UDP-Discovery)
//   GET  /api/update/status → Update-Status (supported, current, behind, latestMsg, lastCheck, checking, updating, autoRestart)
//   POST /api/update/check → Update-Check sofort ausführen, Status zurück
//   POST /api/update/install → Update installieren (nur behind>0): pull --ff-only + npm install, dann Self-Exit
//   POST /api/server/restart → Server neu starten (Self-Exit; systemd zieht ihn hoch), Rate-Limit 10 s
//   /*               → statische Dateien aus webui/dist (SPA-Fallback auf index.html)
const WEBUI_DIR = path.join(__dirname, 'webui', 'dist');
// Flare-Programme (Laufzeitdaten, in .gitignore): programs/<serial>.json
const PROGRAM_DIR = path.join(__dirname, 'programs');

// Serial-Validierung: <serial> wird als Dateiname programs/<serial>.json
// verwendet — ohne Einschränkung wäre Path-Traversal über "../../" möglich.
const isValidSerial = (s) => /^[A-Za-z0-9_-]{1,32}$/.test(s);

function loadProgram(serial) {
  try { return JSON.parse(fs.readFileSync(path.join(PROGRAM_DIR, `${serial}.json`), 'utf8')); }
  catch { return null; }
}

// Eingabe bereinigen: t auf 0..1440 clampen + auf ganze Minute runden,
// Kanalwerte auf 0..1, Punkte nach t sortieren, Duplikate entfernen
function sanitizeProgram(p) {
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const points = (Array.isArray(p?.points) ? p.points : [])
    .map((pt) => ({
      t: Math.min(1440, Math.max(0, Math.round(Number(pt?.t) || 0))),
      l: Array.from({ length: 7 }, (_, i) => clamp01(pt?.l?.[i])),
    }))
    .sort((a, b) => a.t - b.t)
    .filter((pt, i, arr) => i === 0 || pt.t !== arr[i - 1].t);
  if (points.length < 2) throw new Error('Programm braucht mindestens 2 Punkte');
  return {
    name: String(p?.name ?? 'Mein Programm').slice(0, 64),
    intensity: Math.min(100, Math.max(0, Math.round(Number(p?.intensity) || 0))),
    points,
  };
}
const WEBUI_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function webSendJson(res, obj, code = 200) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(obj));
}

// Request-Body-Limit: 1 MB — alle API-Bodies (Kommandos, Programme, Setup)
// sind Kilobyte-klein; größere Bodies werden als Angriff/Fehler abgelehnt.
const WEB_BODY_LIMIT = 1 * 1024 * 1024;

function webReadBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    // Guard gegen doppeltes Settle ('error' + 'close' können beide feuern)
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    req.on('data', (c) => {
      if (settled) return; // Rest verwerfen, bis der Socket zu Ende läuft
      size += c.length;
      if (size > WEB_BODY_LIMIT) {
        chunks.length = 0;
        fail(new Error(`Request-Body zu groß (Limit ${WEB_BODY_LIMIT / 1024 / 1024} MB)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); }
    });
    // Stiller Client-Abbruch ohne 'error'/'end': sonst hängt das await für immer
    req.on('close', () => fail(new Error('Verbindung vor Ende des Request-Bodys geschlossen')));
    req.on('error', fail);
  });
}

// Erste Schutzschicht gegen Env-Injection: Werte mit Zeilenumbrüchen/
// Steuerzeichen ablehnen (400 über den zentralen catch). Zweite Schicht
// sitzt in writeEnvConfig().
function assertNoCtrl(field, value) {
  if (/[\r\n]/.test(String(value))) {
    throw new Error(`${field} darf keine Zeilenumbrüche enthalten`);
  }
}

// WLAN-Scan drosseln: geteilte In-Flight-Promise (parallele Requests warten
// auf denselben Scan) + kurzer Ergebnis-Cache, damit UI-Spam/Mehrfach-Klicks
// keine netsh/nmcli-Prozessflut auslösen.
const ONBOARDING_SCAN_CACHE_MS = 12_000;
let onboardingScanCache = null; // { ts, payload }
let onboardingScanInflight = null; // Promise | null
function onboardingScan() {
  if (onboardingScanCache && Date.now() - onboardingScanCache.ts < ONBOARDING_SCAN_CACHE_MS) {
    return Promise.resolve(onboardingScanCache.payload);
  }
  if (!onboardingScanInflight) {
    onboardingScanInflight = (async () => {
      try {
        return { networks: await scanWifiNetworks(), scannedAt: Date.now() };
      } catch (e) {
        return { networks: [], error: e.message, scannedAt: Date.now() };
      }
    })().then((payload) => {
      // Fehler werden NICHT gecacht — ein Retry soll sofort wieder scannen
      if (!payload.error) onboardingScanCache = { ts: Date.now(), payload };
      return payload;
    }).finally(() => { onboardingScanInflight = null; });
  }
  return onboardingScanInflight;
}

const webServer = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://reefcloud.local');
  try {
    if (req.method === 'OPTIONS') return webSendJson(res, {});
    if (u.pathname === '/api/devices' && req.method === 'GET') {
      // alle bekannten Geräte (deviceMeta), Online-Flag aus der Live-Registry
      return webSendJson(res, {
        devices: [...deviceMeta.keys()].map(snapshot),
        now: Date.now(),
        tank: tankName(),
        tunnel: { connected: !!(tunnel && tunnel.isConnected()), url: TUNNEL_URL },
      });
    }
    if (u.pathname === '/api/command' && req.method === 'POST') {
      const { serial, action, params: ap = {} } = JSON.parse(await webReadBody(req) || '{}');
      // Jebao-Branch: Gizwits-LAN-Client, nicht das RF-Frame-Protokoll
      if (isJebaoTarget(serial, action)) {
        const r = await handleJebaoCommand(serial, action, ap);
        log(`  [webui] jebao command ${action} → ${serial}`);
        return webSendJson(res, r);
      }
      const dev = devices.get(serial);
      if (!dev || dev.readyState !== dev.OPEN) throw new Error(`Gerät ${serial} nicht verbunden`);
      const [cls, mth, payload] = buildCommandFrame(serial, action, ap);
      const buf = encodeFrame(cls, mth, payload, serial);
      captureFrame(buf, 'out', serial);
      dev.send(buf);
      scheduleDoserRefresh(serial, action, ap);
      log(`  [webui] command ${action} → ${serial}: ${cls}/${mth}`);
      return webSendJson(res, { ok: true });
    }
    if (u.pathname === '/api/devices/name' && req.method === 'POST') {
      // Spitzname für ein Gerät setzen/ändern/löschen (leerer name = löschen).
      // Bereinigung: trimmen, <>& entfernen, max. 40 Zeichen.
      const body = JSON.parse(await webReadBody(req) || '{}');
      const serial = String(body.serial || '').trim();
      if (!serial) throw new Error('serial fehlt');
      if (!/^[\w-]{1,32}$/.test(serial)) throw new Error('serial ungültig (1–32 Zeichen: Buchstaben, Ziffern, _, -)');
      const name = String(body.name ?? '').replace(/[<>&]/g, '').trim().slice(0, 40);
      if (name) customNames.set(serial, name); else customNames.delete(serial);
      saveNames(); // sofort atomar persistieren
      log(`  [webui] Nickname ${serial} → ${name ? `"${name}"` : '(gelöscht)'}`);
      announce(serial, true); // geänderten Snapshot sofort an Tunnel melden
      return webSendJson(res, { ok: true, serial, customName: name || null });
    }
    if (u.pathname === '/api/devices/props' && req.method === 'POST') {
      // Geräte-Eigenschaften setzen (aktuell: alarmWhen für Level-Sensoren —
      // geräteseitige Alarm-Richtung „Flüssigkeit über/unter"). Wirkt sofort:
      // covered wird aus dem letzten alarm-Stand neu abgeleitet.
      const body = JSON.parse(await webReadBody(req) || '{}');
      const serial = String(body.serial || '').trim();
      if (!serial) throw new Error('serial fehlt');
      if (!/^[\w-]{1,32}$/.test(serial)) throw new Error('serial ungültig (1–32 Zeichen: Buchstaben, Ziffern, _, -)');
      if (body.alarmWhen !== 'above' && body.alarmWhen !== 'below') {
        throw new Error("alarmWhen muss 'above' oder 'below' sein");
      }
      deviceProps.set(serial, { alarmWhen: body.alarmWhen });
      saveProps(); // sofort atomar persistieren
      const m = metaFor(serial);
      if (m.state && (m.state.alarm === true || m.state.alarm === false || m.state.alarm === 'unknown')) {
        m.state = { ...m.state, covered: deriveCovered(m.state.alarm, body.alarmWhen) };
      }
      log(`  [webui] Props ${serial} → alarmWhen=${body.alarmWhen}`);
      announce(serial, true);
      return webSendJson(res, { ok: true, serial, alarmWhen: body.alarmWhen });
    }
    if (u.pathname === '/api/capture') {
      if (req.method === 'POST') {
        const { on } = JSON.parse(await webReadBody(req) || '{}');
        captureOn = !!on;
        if (captureOn) captureBuffer.length = 0;
        log(`  [webui] Capture ${captureOn ? 'AN (Puffer geleert)' : 'AUS (Puffer bleibt)'}`);
        return webSendJson(res, { capture: captureOn });
      }
      return webSendJson(res, { capture: captureOn, frames: captureBuffer.slice() });
    }
    if (u.pathname === '/api/jebao' && req.method === 'GET') {
      // Konfigurierte Jebao-Pumpen (jebao.json)
      return webSendJson(res, { pumps: jebaoConfig.map((e) => ({ ...e })) });
    }
    if (u.pathname === '/api/jebao' && req.method === 'POST') {
      // Pumpe hinzufügen: { ip, name?, productKey? } — speichert jebao.json
      // und verbindet sofort (Identität via gerichteter Discovery).
      const body = JSON.parse(await webReadBody(req) || '{}');
      const ip = String(body.ip || '').trim();
      if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) || ip.split('.').some((o) => Number(o) > 255)) {
        throw new Error('ip ungültig (IPv4 erwartet)');
      }
      if (jebaoConfig.some((e) => e.ip === ip)) throw new Error('Pumpe mit dieser IP bereits konfiguriert');
      const name = String(body.name ?? '').replace(/[<>&]/g, '').trim().slice(0, 40);
      const entry = { ip, name, ...(body.productKey ? { productKey: String(body.productKey).slice(0, 64) } : {}) };
      jebaoConfig.push(entry);
      saveJebaoConfig();
      startJebaoPump(entry); // async — Fehler landen im Log, nicht in der API
      log(`  [webui] Jebao-Pumpe hinzugefügt: ${ip}${name ? ` ("${name}")` : ''}`);
      return webSendJson(res, { ok: true, pump: { ...entry } });
    }
    if (u.pathname === '/api/jebao' && req.method === 'DELETE') {
      // Pumpe entfernen: { ip } — Client schließen, Config + Geräteliste bereinigen
      const body = JSON.parse(await webReadBody(req) || '{}');
      const ip = String(body.ip || '').trim();
      const idx = jebaoConfig.findIndex((e) => e.ip === ip);
      if (idx < 0) throw new Error('Pumpe nicht gefunden');
      const [entry] = jebaoConfig.splice(idx, 1);
      saveJebaoConfig();
      stopJebaoPump(entry);
      log(`  [webui] Jebao-Pumpe entfernt: ${ip}`);
      return webSendJson(res, { ok: true });
    }
    if (u.pathname === '/api/jebao/scan' && req.method === 'GET') {
      // UDP-Discovery (Gizwits 12414) für den „Pumpe hinzufügen"-Dialog.
      // Dauert bis zu ~2,5 s; parallele Requests teilen denselben Lauf.
      const payload = await jebaoScan();
      log(`  [webui] jebao/scan: ${payload.error ? `fehlgeschlagen: ${payload.error}` : `${payload.devices.length} Gerät(e) gefunden`}`);
      return webSendJson(res, payload);
    }
    if (u.pathname === '/api/autolevel') {
      // Ablaufschacht-Stabilisierung: Status + History lesen, Config ändern.
      // Änderungen wirken sofort (kein Neustart nötig).
      if (req.method === 'GET') return webSendJson(res, autolevel.payload());
      if (req.method === 'POST') {
        const body = JSON.parse(await webReadBody(req) || '{}');
        // knownFamily: Serial muss ein bekanntes Gerät der erwarteten Familie sein
        const knownFamily = (serial) => (deviceMeta.has(serial) ? metaFor(serial).family : null);
        const patch = autolevel.validateSubset(body, knownFamily);
        const config = autolevel.applyConfig(patch);
        log(`  [webui] autolevel-Config aktualisiert (enabled=${config.enabled})`);
        return webSendJson(res, { ok: true, config });
      }
    }
    if (u.pathname === '/api/program') {
      // Flare-Lichtprogramm (24h-Kurven): serverseitig in programs/<serial>.json.
      // Datenmodell wie der App-Export: { name, intensity: 0..100,
      // points: [{ t: Minute des Tages 0..1440, l: [7 Kanäle 0..1] }] }.
      // Der Upload zur Lampe (rfPrecise-Schreibpfad) wird aktiviert, sobald das
      // Write-Format aus einem App-Mitschnitt entschlüsselt ist (live_capture).
      if (req.method === 'GET') {
        const serial = u.searchParams.get('serial') || '';
        if (!isValidSerial(serial)) throw new Error('serial ungültig ([A-Za-z0-9_-]{1,32} erwartet)');
        // Eigenes gespeichertes Programm hat Vorrang; sonst das echte
        // Lampenprogramm (preciseData), damit der Editor damit vorbefüllt
        const custom = loadProgram(serial);
        const lamp = deviceMeta.get(serial)?.lampProgram ?? null;
        return webSendJson(res, {
          serial,
          program: custom ?? lamp,
          source: custom ? 'custom' : lamp ? 'lamp' : null,
        });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await webReadBody(req) || '{}');
        const serial = String(body.serial || '');
        if (!isValidSerial(serial)) throw new Error('serial ungültig ([A-Za-z0-9_-]{1,32} erwartet)');
        const program = sanitizeProgram(body.program);
        fs.mkdirSync(PROGRAM_DIR, { recursive: true });
        fs.writeFileSync(path.join(PROGRAM_DIR, `${serial}.json`), JSON.stringify(program));
        // Upload zur Lampe: rfPrecise/update (Schreibformat aus App-Mitschnitt
        // verifiziert), danach rfPrecise/pointer als Commit/Sync (App-Verhalten —
        // der Pointer triggert den preciseData-Re-Push zur Rück-Verifikation)
        let uploaded = false; let version = null;
        const dev = devices.get(serial);
        if (dev && dev.readyState === dev.OPEN && metaFor(serial).family === 'flare') {
          const up = buildPreciseUpdate(program);
          version = up.version;
          const buf = encodeFrame('rfPrecise', 'update', up.payload, serial);
          captureFrame(buf, 'out', serial);
          dev.send(buf);
          pendingUploads.set(serial, { version, program });
          uploaded = true;
          log(`  [webui] Programm-Upload → ${serial}: rfPrecise/update Version ${version} (${program.points.length} Punkte, Intensität ${program.intensity} %)`);
          setTimeout(() => {
            const d2 = devices.get(serial);
            if (d2 && d2.readyState === d2.OPEN) {
              const pv = Buffer.alloc(5);
              pv.writeUInt32BE(version >>> 0, 0);
              const pb = encodeFrame('rfPrecise', 'pointer', [...pv], serial);
              captureFrame(pb, 'out', serial);
              d2.send(pb);
              log(`  [webui] rfPrecise/pointer Version ${version} → ${serial} (Commit/Sync)`);
            }
          }, 2000);
        } else {
          log(`  [webui] Programm gespeichert für ${serial} (Lampe offline — kein Upload)`);
        }
        return webSendJson(res, { ok: true, uploaded, version });
      }
    }
    if (u.pathname === '/api/onboarding/scan' && req.method === 'GET') {
      // Serverseitiger WLAN-Scan fürs Geräte-Onboarding (Browser können nicht
      // scannen). Statische Kommandos (netsh/nmcli/iwlist) mit Timeout —
      // Details in reef-onboarding.mjs. In-Flight geteilt + 12 s Ergebnis-
      // Cache (siehe onboardingScan). Fehler (z. B. Server per LAN ohne
      // WLAN-Adapter) kommen als { networks: [], error } mit HTTP 200, damit
      // die UI sie als Hinweis statt als harten Fehler anzeigen kann.
      const payload = await onboardingScan();
      log(`  [webui] onboarding/scan: ${payload.error ? `nicht möglich: ${payload.error}` : `${payload.networks.length} WLAN(s) sichtbar`}`);
      return webSendJson(res, payload);
    }
    if (u.pathname === '/api/setup/status' && req.method === 'GET') {
      // Setup-Wizard-Status. Token wird absichtlich nie zurückgegeben.
      return webSendJson(res, {
        needsSetup: !TUNNEL_TOKEN,
        hasToken: !!TUNNEL_TOKEN,
        tunnelUrl: TUNNEL_URL,
        tunnelType: TUNNEL_TYPE,
        tunnelLabel: TUNNEL_LABEL,
        tunnelConnected: !!(tunnel && tunnel.isConnected()),
        lanIps: lanIps(),
        cert: { cn: certInfo.cn, fingerprint256: certInfo.fingerprint256, notAfter: certInfo.notAfter },
      });
    }
    if (u.pathname === '/api/setup/test' && req.method === 'POST') {
      const body = JSON.parse(await webReadBody(req) || '{}');
      const url = String(body.tunnelUrl || TUNNEL_URL);
      const token = String(body.tunnelToken || '');
      if (!token) throw new Error('tunnelToken fehlt');
      return webSendJson(res, await testTunnelConnection(url, token));
    }
    if (u.pathname === '/api/setup' && req.method === 'POST') {
      const body = JSON.parse(await webReadBody(req) || '{}');
      const tunnelUrl = String(body.tunnelUrl || '').trim() || TUNNEL_URL;
      let tunnelToken = String(body.tunnelToken || '').trim();
      if (!tunnelToken && TUNNEL_TOKEN) tunnelToken = TUNNEL_TOKEN; // leer = bestehenden behalten
      if (!/^[0-9a-f]{32,128}$/i.test(tunnelToken)) throw new Error('tunnelToken ungültig (32–128 Hex-Zeichen erwartet)');
      if (!/^wss?:\/\//.test(tunnelUrl)) throw new Error('tunnelUrl muss mit ws:// oder wss:// beginnen');
      assertNoCtrl('tunnelUrl', tunnelUrl);
      assertNoCtrl('tunnelToken', tunnelToken);
      const envFile = writeEnvConfig({ tunnelUrl, tunnelToken });
      TUNNEL_URL = tunnelUrl;
      TUNNEL_TOKEN = tunnelToken;
      launchTunnel('Setup-Wizard');
      log(`  [setup] Konfiguration gespeichert → ${envFile}; Tunnel neu gestartet → ${tunnelUrl}`);
      return webSendJson(res, { ok: true, envFile, tunnelConnected: !!(tunnel && tunnel.isConnected()) });
    }
    // Laufzeit-Einstellungen des Tunnels (generisch: WebOS, HomeAssistant, Custom).
    // Token wird absichtlich nie zurückgegeben (nur hasToken).
    if (u.pathname === '/api/update/status' && req.method === 'GET') {
      return webSendJson(res, updater.status());
    }
    if (u.pathname === '/api/update/check' && req.method === 'POST') {
      // check() wirft nie — Fehler stehen im Status (error)
      return webSendJson(res, await updater.check());
    }
    if (u.pathname === '/api/update/install' && req.method === 'POST') {
      // 409-artig: parallele Installationen ablehnen; ohne behind>0 gar nicht starten
      if (updater.status().updating) return webSendJson(res, { ok: false, error: 'Update läuft bereits' }, 409);
      try {
        const result = await updater.install(); // wirft bei behind=0 / git-/npm-Fehler
        webSendJson(res, result);
        scheduleSelfExit('Update installiert');
        return;
      } catch (e) {
        return webSendJson(res, { ok: false, error: e.message }, 400);
      }
    }
    if (u.pathname === '/api/server/restart' && req.method === 'POST') {
      if (Date.now() - lastRestartAt < 10_000) {
        return webSendJson(res, { ok: false, error: 'Gerade erst neu gestartet — bitte ein paar Sekunden warten' }, 429);
      }
      lastRestartAt = Date.now();
      log('  [system] Neustart über Web-UI angefordert');
      webSendJson(res, { ok: true, restarting: true, autoRestart: updater.status().autoRestart });
      scheduleSelfExit('Neustart aus den Einstellungen');
      return;
    }
    if (u.pathname === '/api/settings' && req.method === 'GET') {
      return webSendJson(res, {
        tunnelUrl: TUNNEL_URL,
        tunnelType: TUNNEL_TYPE,
        tunnelLabel: TUNNEL_LABEL,
        hasToken: !!TUNNEL_TOKEN,
        tunnelConnected: !!(tunnel && tunnel.isConnected()),
      });
    }
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      // Nur gesetzte Felder ändern; fehlende Felder bleiben wie bisher.
      const body = JSON.parse(await webReadBody(req) || '{}');
      const tunnelUrl = body.tunnelUrl !== undefined ? String(body.tunnelUrl).trim() : TUNNEL_URL;
      let tunnelToken = String(body.tunnelToken || '').trim();
      if (!tunnelToken) tunnelToken = TUNNEL_TOKEN; // leer = bestehenden behalten
      const tunnelType = body.tunnelType !== undefined ? String(body.tunnelType).trim() : TUNNEL_TYPE;
      const tunnelLabel = body.tunnelLabel !== undefined ? String(body.tunnelLabel).trim() : TUNNEL_LABEL;
      if (!/^wss?:\/\//.test(tunnelUrl)) throw new Error('tunnelUrl muss mit ws:// oder wss:// beginnen');
      if (tunnelToken && !/^[0-9a-f]{32,128}$/i.test(tunnelToken)) throw new Error('tunnelToken ungültig (32–128 Hex-Zeichen erwartet)');
      if (!TUNNEL_TYPES.includes(tunnelType)) throw new Error(`tunnelType ungültig (erlaubt: ${TUNNEL_TYPES.join(', ')})`);
      assertNoCtrl('tunnelUrl', tunnelUrl);
      assertNoCtrl('tunnelLabel', tunnelLabel);
      assertNoCtrl('tunnelToken', tunnelToken);
      const envFile = writeEnvConfig({ tunnelUrl, tunnelToken: tunnelToken ?? undefined, tunnelType, tunnelLabel });
      TUNNEL_URL = tunnelUrl;
      TUNNEL_TOKEN = tunnelToken;
      TUNNEL_TYPE = tunnelType;
      TUNNEL_LABEL = tunnelLabel;
      launchTunnel('Einstellungen');
      log(`  [settings] Konfiguration gespeichert → ${envFile}; Typ=${tunnelType} (${tunnelLabel}), Tunnel neu gestartet → ${tunnelUrl}`);
      return webSendJson(res, { ok: true, envFile });
    }
    if (u.pathname === '/setup') {
      const fp = path.join(__dirname, 'setup.html');
      try {
        const data = fs.readFileSync(fp);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(data);
      } catch { res.writeHead(404); return res.end('setup.html fehlt'); }
    }
    // Anleitungs-Seiten (guides/): Zertifikats-Installation iOS/Android,
    // DNS-Rewrite-Anleitung mit Live-Test. Statisch, kein Build.
    if (u.pathname === '/guides/reef-cloud-cert.crt') {
      // NUR das Zertifikat — niemals den Schlüssel ausliefern.
      try {
        const pem = fs.readFileSync(path.join(__dirname, 'reef-cloud-cert.pem'));
        res.writeHead(200, {
          'content-type': 'application/x-pem-file',
          'content-disposition': 'attachment; filename="reef-cloud-cert.crt"',
          'cache-control': 'no-cache',
        });
        return res.end(pem);
      } catch { res.writeHead(404); return res.end('Zertifikat noch nicht erzeugt'); }
    }
    if (u.pathname === '/guides' || u.pathname.startsWith('/guides/')) {
      const GUIDES_DIR = path.join(__dirname, 'guides');
      const grel = (u.pathname === '/guides' || u.pathname === '/guides/') ? 'index.html'
        : decodeURIComponent(u.pathname.slice('/guides/'.length)).replace(/^\/+/, '') || 'index.html';
      const gfp = path.normalize(path.join(GUIDES_DIR, grel));
      if (gfp !== GUIDES_DIR && !gfp.startsWith(GUIDES_DIR + path.sep)) { res.writeHead(403); return res.end(); }
      try {
        const data = fs.readFileSync(gfp);
        res.writeHead(200, {
          'content-type': WEBUI_MIME[path.extname(gfp).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        return res.end(data);
      } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Anleitung nicht gefunden'); }
    }
    // Statische Auslieferung der gebauten UI (SPA-Fallback: index.html).
    // Erststart ohne Token: Setup-Wizard statt Dashboard zeigen.
    const rel = u.pathname === '/' ? (!TUNNEL_TOKEN ? '__setup__' : 'index.html') : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (rel === '__setup__') {
      try {
        const data = fs.readFileSync(path.join(__dirname, 'setup.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(data);
      } catch { /* fällt auf index.html zurück */ }
    }
    const fp = path.normalize(path.join(WEBUI_DIR, rel));
    // Guard mit Separator bzw. exakter Gleichheit: ein Geschwister-Verzeichnis
    // mit gemeinsamem Präfix (z. B. webui/dist-evil) darf nicht durchrutschen.
    if (fp !== WEBUI_DIR && !fp.startsWith(WEBUI_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, data) => {
      if (err) {
        fs.readFile(path.join(WEBUI_DIR, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('webui nicht gebaut — in webui/ erst npm install, dann npm run build'); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(idx);
        });
        return;
      }
      res.writeHead(200, { 'content-type': WEBUI_MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    webSendJson(res, { ok: false, error: e.message }, 400);
  }
});
webServer.listen(8080, () => log('Web-UI lauscht auf Port 8080 (Dashboard: http://<host>:8080)'));
webServer.on('error', (e) => log(`!! Port 8080 (Web-UI): ${e.code || e.message}`));

log('reef-cloud-v2 gestartet. Log-Datei: ' + LOG_FILE);
