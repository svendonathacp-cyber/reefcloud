// Einmal-Diagnose (nicht ins Repo committen): Prüft, ob Altgeräte-Sensoren
// auf aktive Getter (lsGet/…) mit einem frischen Report antworten.
// Verbindet sich als "App" an Port 443 des lokalen reef-cloud-Servers.
import WebSocket from 'ws';

const DEEP = 'RFLS012312110020'; // Schacht Tief
const UP   = 'RFLS012312110046'; // Schacht Hoch

function frame(cls, method, payload = Buffer.alloc(0), serial, extra = '') {
  return Buffer.concat([
    Buffer.from(serial, 'latin1'), Buffer.from([0]),
    Buffer.from(cls, 'latin1'), Buffer.from([0]),
    Buffer.from(method, 'latin1'), Buffer.from([0]),
    Buffer.from(extra, 'latin1'), Buffer.from([0]),
    payload,
  ]);
}

function decode(buf) {
  const parts = [];
  let cur = [];
  let fields = 0;
  for (const b of buf) {
    if (b === 0 && fields < 4) { parts.push(Buffer.from(cur).toString('latin1')); cur = []; fields++; }
    else cur.push(b);
  }
  const payload = Buffer.from(cur);
  return { serial: parts[0], cls: parts[1], method: parts[2], extra: parts[3], payload };
}

const ws = new WebSocket('wss://localhost:443', { rejectUnauthorized: false });
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

ws.on('open', () => {
  console.log(ts(), 'verbunden — Join beide Sensoren');
  for (const s of [DEEP, UP]) {
    ws.send(frame('lsConnect', 'join', Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]), s, `join_${Date.now()}`));
  }
  const probes = [
    [5,  DEEP, 'lsGet', 'data'],
    [13, UP,   'lsGet', 'data'],
    [21, DEEP, 'lsGet', 'all'],
    [29, DEEP, 'lsGet', 'settings'],
    [37, UP,   'lsRefresh', 'data'], // Kontrolle: Klasse, die das Gerät selbst nutzt
  ];
  for (const [at, serial, cls, method] of probes) {
    setTimeout(() => {
      console.log(ts(), `>> PROBE ${cls}/${method} → ${serial}`);
      ws.send(frame(cls, method, Buffer.alloc(0), serial));
    }, at * 1000);
  }
  setTimeout(() => { console.log(ts(), 'Ende — trenne'); ws.close(); process.exit(0); }, 50 * 1000);
});

ws.on('message', (buf) => {
  const f = decode(buf);
  console.log(ts(), `<< ${f.cls}/${f.method} serial="${f.serial}" extra="${f.extra}" payload=${f.payload.toString('hex')}`);
});
ws.on('error', (e) => { console.error('WS-Fehler:', e.message); process.exit(1); });
