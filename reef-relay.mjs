// reef-relay — MITM-Relay: Gerät ↔ echte Reef-Factory-Cloud
// Das Gerät verbindet zu uns (DNS-Rewrite), wir verbinden zur echten Cloud
// und reichen alle Frames durch — mit komplettem Decode-Log in beide Richtungen.
// So beobachten wir die ORIGINAL-Antworten der Cloud (Login-Format, Ping, Reports).
// Start: node reef-relay.mjs   (statt reef-cloud.mjs; Port 444 muss frei sein)

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'reef-relay.log');

// Echte Cloud (DNS-Rewrite umgehen → feste IP, SNI bleibt Original-Hostname)
const CLOUD_HOSTS = ['34.251.45.179', '79.125.41.71'];
const CLOUD_PORT = 444;

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ---------- Frame-Codec ----------
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

function hexPreview(bytes, max = 64) {
  const slice = bytes.slice(0, max);
  return Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > max ? ' …' : '');
}

const DUMP_DIR = path.join(__dirname, 'dumps');
fs.mkdirSync(DUMP_DIR, { recursive: true });
let dumpCounter = 0;

function dumpFrame(dir, buf, f) {
  // Volldump jedes Frames als Binärdatei — Grundlage für Replay-Antworten der Fake-Cloud
  dumpCounter++;
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const name = `${String(dumpCounter).padStart(4, '0')}_${safe(dir)}_${safe(f.cls)}_${safe(f.method)}_${safe(f.serial)}.bin`;
  fs.writeFileSync(path.join(DUMP_DIR, name), buf);
  return name;
}

function logFrame(dir, buf) {
  try {
    const f = decodeFrame(buf);
    const dumpName = dumpFrame(dir, buf, f);
    log(`  ${dir} serial="${f.serial}" class="${f.cls}" method="${f.method}" extra="${f.extra}" (${buf.length} B) → dumps/${dumpName}`);
    let end = f.payload.length;
    while (end > 0 && f.payload[end - 1] === 0) end--;
    const trimmed = f.payload.slice(0, end);
    if (trimmed.length) {
      try { log(`      JSON: ${JSON.stringify(JSON.parse(Buffer.from(trimmed).toString('utf8')))}`); return; } catch {}
      const u16 = utf16beDecode(trimmed);
      if (u16.length > 1) { try { log(`      JSON(UTF-16BE): ${JSON.stringify(JSON.parse(u16))}`); return; } catch {} }
      log(`      hex: ${hexPreview(f.payload)}`);
    }
  } catch (e) {
    log(`  ${dir} <decode failed: ${e.message}> hex: ${hexPreview(buf)}`);
  }
}

// ---------- Relay (Port 444 = Geräte, Port 443 = App/User) ----------
const cert = fs.readFileSync(path.join(__dirname, 'reef-cloud-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'reef-cloud-key.pem'));

function createRelayServer(port, plain = false) {
  const server = plain ? http.createServer() : https.createServer({ cert, key });
  if (!plain) server.on('tlsClientError', (err, socket) => {
    log(`!! TLS-Handshake (Client→Relay:${port}) fehlgeschlagen von ${socket.remoteAddress}: ${err.message}`);
  });

  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => {
      log(`  [Port ${port}] Client bietet Subprotokolle: ${[...protocols].join(', ') || '(keine)'}`);
      if (protocols.has('reeffactory')) return 'reeffactory';
      if (protocols.has('arduino')) return 'arduino';
      return false;
    },
  });

  wss.on('connection', (clientWs, req) => {
    const client = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    const clientPath = req.url || (port === 444 ? '/hardware32' : port === 442 ? '/hardware' : '/controler');
    const subprotocol = clientWs.protocol || 'reeffactory';
    const role = port === 443 ? 'APP' : 'GERÄT';
    log(`=== ${role} verbunden auf :${port}: ${client} Pfad=${clientPath} Subprotokoll=${subprotocol} ===`);

    const cloudHost = CLOUD_HOSTS[0];
    const cloudUrl = `${plain ? 'ws' : 'wss'}://${cloudHost}:${port}${clientPath}`;
    log(`=== Verbinde zur echten Cloud: ${cloudUrl} ===`);

    const cloudWs = new WebSocket(cloudUrl, [subprotocol], plain ? {
      handshakeTimeout: 10000,
    } : {
      servername: 'api.reeffactory.com',
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
    });

    const pending = []; // Frames puffern, bis die Cloud-Verbindung steht

    cloudWs.on('open', () => {
      log(`=== Cloud-Verbindung steht (:${port}, Subprotokoll=${cloudWs.protocol}) ===`);
      for (const f of pending.splice(0)) cloudWs.send(f);
    });

    cloudWs.on('message', (data, isBinary) => {
      logFrame(`CLOUD→${role}`, data);
      if (clientWs.readyState === clientWs.OPEN) clientWs.send(data, { binary: isBinary });
    });

    cloudWs.on('close', (code, reason) => {
      log(`=== Cloud getrennt (:${port}): code=${code} reason="${reason}" ===`);
      clientWs.close();
    });
    cloudWs.on('error', (e) => {
      log(`!! Cloud-Verbindungsfehler (:${port}): ${e.message}`);
      clientWs.close(1011, 'cloud error');
    });

    clientWs.on('message', (data, isBinary) => {
      logFrame(`${role}→CLOUD`, data);
      if (cloudWs.readyState === cloudWs.OPEN) cloudWs.send(data, { binary: isBinary });
      else pending.push(data);
    });

    clientWs.on('close', (code, reason) => {
      log(`=== ${role} getrennt (:${port}): code=${code} reason="${reason}" ===`);
      cloudWs.close();
    });
    clientWs.on('error', (e) => log(`!! ${role}-Fehler (:${port}): ${e.message}`));
  });

  server.listen(port, () => log(`Relay lauscht auf Port ${port} → echte Cloud ${CLOUD_HOSTS[0]}:${port}`));
  server.on('error', (e) => log(`!! Serverfehler Port ${port}: ${e.code || e.message} — läuft noch reef-cloud.mjs? Vorher beenden.`));
}

createRelayServer(444); // Geräte (neue Firmware, TLS)
createRelayServer(443); // App/User (desktop.reeffactory.com)
createRelayServer(442, true); // Altgeräte (FW 1.0.0/1.1.0, PLAIN ws, Pfad /hardware)
log('reef-relay gestartet. Log-Datei: ' + LOG_FILE);
