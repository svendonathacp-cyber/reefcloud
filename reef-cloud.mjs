// reef-cloud — Phase 1: Logger-"Cloud" für Reef-Factory-Geräte
// Gibt sich als wss://api.reeffactory.com:443/controler aus, loggt alle Frames,
// antwortet minimal (Hello, Login-Akzeptanz, Onboarding-Token).
// Start: node reef-cloud.mjs   (Ports 443 + 80; unter Windows ggf. als Administrator)

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'reef-cloud.log');

// ---------- Logging ----------
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ---------- Frame-Codec (Referenz aus dem Briefing) ----------
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
  return { serial, cls, method, extra, payload: b.slice(i) };
}

function utf16beDecode(payload) {
  let s = '';
  for (let i = 0; i + 1 < payload.length; i += 2) {
    const code = (payload[i] << 8) | payload[i + 1];
    if (code === 0) break;
    s += String.fromCharCode(code);
  }
  return s;
}

function utf16beEncode(str) {
  const out = [];
  for (const ch of str) { const c = ch.charCodeAt(0); out.push((c >> 8) & 255, c & 255); }
  return out;
}

function hexPreview(bytes, max = 64) {
  const slice = bytes.slice(0, max);
  return Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > max ? ' …' : '');
}

function latin1Preview(bytes, max = 128) {
  const slice = bytes.slice(0, max);
  let s = Array.from(slice, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
  return bytes.length > max ? s + '…' : s;
}

// Payload-Kandidaten loggen: UTF-8-JSON, UTF-16BE-JSON, sonst hex/latin1
function logPayload(payload) {
  if (!payload || payload.length === 0) { log('    payload: <leer>'); return; }
  log(`    payload (${payload.length} B) hex: ${hexPreview(payload)}`);
  log(`    payload latin1: "${latin1Preview(payload)}"`);
  // Trailing-Nullbytes ignorieren
  let end = payload.length;
  while (end > 0 && payload[end - 1] === 0) end--;
  const trimmed = payload.slice(0, end);
  try {
    const obj = JSON.parse(Buffer.from(trimmed).toString('utf8'));
    log(`    payload UTF-8-JSON: ${JSON.stringify(obj)}`);
    return;
  } catch { /* kein UTF-8-JSON */ }
  const u16 = utf16beDecode(trimmed);
  if (u16.length > 1) {
    try {
      const obj = JSON.parse(u16);
      log(`    payload UTF-16BE-JSON: ${JSON.stringify(obj)}`);
      return;
    } catch { /* kein UTF-16BE-JSON */ }
  }
}

// ---------- Frame-Verarbeitung ----------
function handleFrame(ws, buf, peerLabel) {
  let frame;
  try {
    frame = decodeFrame(buf);
  } catch (e) {
    log(`  [${peerLabel}] Frame-Dekodierung fehlgeschlagen: ${e.message}; raw hex: ${hexPreview(buf)}`);
    return;
  }
  log(`  [${peerLabel}] << serial="${frame.serial}" class="${frame.cls}" method="${frame.method}" extra="${frame.extra}"`);
  logPayload(frame.payload);

  const send = (cls, method, payload, serial = frame.serial || '0000000000000000') => {
    const out = encodeFrame(cls, method, payload, serial);
    log(`  [${peerLabel}] >> serial="${serial}" class="${cls}" method="${method}" (${out.length} B)`);
    ws.send(out);
  };

  // Minimale Antworten gemäß Briefing
  if (frame.cls === 'user' && frame.method === 'login') {
    // Jeden Login akzeptieren: status/login, Payload beginnt mit "ok" + sessionId
    send('status', 'login', [...latin1('ok'), 0, ...latin1('local-session-0000000000000000')]);
    return;
  }
  if (frame.cls === 'geConnect' && frame.method === 'login') {
    // Geräte-Login — Original-Antwort der echten Cloud (via Relay-Mitschnitt verifiziert):
    // 1) geReport/login {"status":"success","pingInterval":20}
    // 2) geSet/time {year, month, day, weekday, hour, minutes, seconds}
    send('geReport', 'login', latin1(JSON.stringify({ status: 'success', pingInterval: 20 })));
    const now = new Date();
    const timeJson = JSON.stringify({
      year: now.getFullYear() % 100, month: now.getMonth() + 1, day: now.getDate(),
      weekday: now.getDay(), hour: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds(),
    });
    send('geSet', 'time', latin1(timeJson));
    log('  → Geräte-Login akzeptiert (geReport/login + geSet/time gesendet)');
    return;
  }
  if (frame.cls === 'boardingPanel' && frame.method === 'getLoginDetails') {
    const json = JSON.stringify({ deviceToken: 'local', userMail: 'local@local' });
    send('boardingPanel', 'getLoginDetails', utf16beEncode(json));
    return;
  }
  if (frame.cls === 'set' && frame.method === 'pingTime') {
    send('set', 'pingTime', [0, 30]);
    return;
  }
  // Alles andere (geConnect/loginData, <xx>Connect/join, <xx>Get/*, Reports …): nur loggen
}

// ---------- Server-Hallo: set/pingTime direkt nach Connect ----------
function sendHello(ws, peerLabel) {
  const out = encodeFrame('set', 'pingTime', [0, 30]);
  log(`  [${peerLabel}] >> HELLO set/pingTime (30 s)`);
  ws.send(out);
}

// ---------- WSS (Ports 443 + 444, TLS, Subprotokoll reeffactory) ----------
// Port 444: die Geräte-Firmware (Base pump 1.4.24) verbindet nachweislich auf 444,
// die Web-App auf 443. Beide Ports bedienen.
try {
  const cert = fs.readFileSync(path.join(__dirname, 'reef-cloud-cert.pem'));
  const key = fs.readFileSync(path.join(__dirname, 'reef-cloud-key.pem'));

  const onWssConnection = (port) => (ws, req) => {
    const peer = `wss:${port} ${req.socket.remoteAddress}:${req.socket.remotePort}${req.url}`;
    log(`=== WSS-Connect: ${peer} ===`);
    sendHello(ws, peer);
    // Wie die echte Cloud: set/pingTime periodisch alle 30 s nachschieben
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        log(`  [${peer}] >> set/pingTime (periodisch)`);
        ws.send(encodeFrame('set', 'pingTime', [0, 30]));
      }
    }, 30000);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) log(`  [${peer}] TEXT-Frame: "${data.toString('utf8')}"`);
      handleFrame(ws, data, peer);
    });
    ws.on('close', (code, reason) => { clearInterval(pingInterval); log(`=== WSS-Close: ${peer} code=${code} reason="${reason}" ===`); });
    ws.on('error', (e) => log(`!! WSS-Fehler ${peer}: ${e.message}`));
    ws.on('pong', () => log(`  [${peer}] WS-Pong`));
  };

  for (const port of [443, 444]) {
    const httpsServer = https.createServer({ cert, key });
    httpsServer.on('tlsClientError', (err, socket) => {
      log(`!! TLS-Handshake fehlgeschlagen auf Port ${port} von ${socket.remoteAddress}: ${err.message}`);
      log('!! → Hinweis auf aktive Zertifikatsprüfung; siehe Eskalationspfade (Abschnitt 4 des Briefings).');
    });
    const wss = new WebSocketServer({
      server: httpsServer,
      maxPayload: 1 * 1024 * 1024, // Geräte-Frames sind wenige KB — 100-MiB-Default ist zu groß
      handleProtocols: (protocols) => {
        log(`  [Port ${port}] angebotene Subprotokolle: ${[...protocols].join(', ') || '(keine)'}`);
        if (protocols.has('reeffactory')) return 'reeffactory';
        if (protocols.has('arduino')) return 'arduino';
        return false;
      },
    });
    wss.on('connection', onWssConnection(port));
    httpsServer.on('request', (req, res) => {
      log(`  HTTP(S)-Request auf ${port}: ${req.method} ${req.url} von ${req.socket.remoteAddress}`);
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('websocket only\n');
    });
    httpsServer.listen(port, () => log(`WSS-Logger lauscht auf Port ${port} (TLS, Subprotokoll reeffactory)`));
    httpsServer.on('error', (e) => {
      if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
        log(`!! Port ${port} nicht verfügbar (${e.code}). Windows: ggf. als Administrator starten; belegt? "netstat -ano | findstr :${port}"`);
      } else log(`!! HTTPS-Serverfehler Port ${port}: ${e.message}`);
    });
  }
} catch (e) {
  log(`!! WSS-Setup fehlgeschlagen: ${e.message}`);
}

// ---------- Plain WS (Port 80, Subprotokoll arduino/reeffactory) — Fallback-Mithören ----------
const httpServer = http.createServer((req, res) => {
  log(`  HTTP-Request auf 80: ${req.method} ${req.url} von ${req.socket.remoteAddress}`);
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('websocket only\n');
});
const wsPlain = new WebSocketServer({
  server: httpServer,
  maxPayload: 1 * 1024 * 1024,
  handleProtocols: (protocols) => {
    log(`  [Port 80] angebotene Subprotokolle: ${[...protocols].join(', ') || '(keine)'}`);
    if (protocols.has('arduino')) return 'arduino';
    if (protocols.has('reeffactory')) return 'reeffactory';
    return false;
  },
});
wsPlain.on('connection', (ws, req) => {
  const peer = `ws ${req.socket.remoteAddress}:${req.socket.remotePort}${req.url}`;
  log(`=== WS-Connect (plain, Port 80): ${peer} ===`);
  sendHello(ws, peer);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) log(`  [${peer}] TEXT-Frame: "${data.toString('utf8')}"`);
    handleFrame(ws, data, peer);
  });
  ws.on('close', (code, reason) => log(`=== WS-Close: ${peer} code=${code} reason="${reason}" ===`));
  ws.on('error', (e) => log(`!! WS-Fehler ${peer}: ${e.message}`));
});
httpServer.listen(80, () => log('Plain-WS-Logger lauscht auf Port 80 (Subprotokoll arduino)'));
httpServer.on('error', (e) => {
  if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
    log(`!! Port 80 nicht verfügbar (${e.code}). Ggf. als Administrator starten; belegt? "netstat -ano | findstr :80"`);
  } else log(`!! HTTP-Serverfehler: ${e.message}`);
});

// ---------- Generische TCP-Sonde auf Alternativ-Ports ----------
// Falls die Firmware nicht auf 443/80 verbindet, sehen wir hier den SYN + erste Bytes.
import net from 'node:net';
const PROBE_PORTS = [8000, 8080, 8081, 8083, 8084, 8088, 8443, 8883, 9000, 1883];
for (const port of PROBE_PORTS) {
  const probe = net.createServer((socket) => {
    log(`=== TCP-Sonde: Verbindung von ${socket.remoteAddress}:${socket.remotePort} auf Port ${port} ===`);
    socket.on('data', (d) => {
      log(`  [Sonde :${port}] ${d.length} B hex: ${hexPreview(d, 128)}`);
      log(`  [Sonde :${port}] latin1: "${latin1Preview(d, 128)}"`);
    });
    socket.on('error', () => {});
    socket.on('close', () => log(`=== TCP-Sonde: Close auf Port ${port} (${socket.remoteAddress}) ===`));
  });
  probe.on('error', (e) => log(`!! Sonde Port ${port}: ${e.code}`));
  probe.listen(port, () => log(`TCP-Sonde lauscht auf Port ${port}`));
}

log('reef-cloud Phase-1-Logger gestartet. Log-Datei: ' + LOG_FILE);
