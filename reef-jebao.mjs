// reef-jebao — Gizwits-LAN-Client für Jebao-Strömungspumpen (Wavemaker)
// Protokoll live verifiziert (03.08.) an einer Pumpe mit Firmware 04X3JB0S,
// product_key 54114ccdac1e41c0bb17e222887c07ba („本地造浪泵_WIFI_BLE").
// Bit-Packing/Login/Read/Write 1:1 aus der HA-Referenz (gizwits_lan) portiert.
//
// Protokoll-Überblick:
//   Discovery  UDP 12414: Request 00 00 00 03 03 00 00 03 → Antwort cmd 0x0004
//   TCP        Port 12416: Frame = 00 00 00 03 + varlen(Länge) + 1 B Flag + 2 B cmd + Payload
//              varlen: 7-Bit-Chunks, MSB = Fortsetzung; Länge = 1 (Flag) + 2 (cmd) + Payload
//   Login      0x0006 → 0x0007 (u16BE Passcode-Länge + Passcode),
//              0x0008 (u16BE len + Passcode) → 0x0009 (1 B Code, 0 = OK)
//              ACHTUNG: ESP32-C3 schickt oft eine ZWEITE 0x09 — Antworten werden
//              per cmd zugeordnet (nicht FIFO), nach dem Login ~350 ms warten.
//   Status     0x0090 [0x02] → 0x0091: 1 B Action (0x03/0x04) + 401 B Statusdaten.
//              Unaufgeforderte Pushes: cmd 0x0091/0x0093 mit Flag = 1.
//   Schreiben  0x0093 → 0x0094. Payload: seq (u32BE) + [0x01] + attr_flags + attr_values
//   Keepalive  Ping 0x0001 → Pong 0x0002, ~4 s (max. 10 s, sonst trennt das Gerät)
import dgram from 'node:dgram';
import net from 'node:net';
import { EventEmitter } from 'node:events';

export const JEBAO_PRODUCT_KEY = '54114ccdac1e41c0bb17e222887c07ba';
export const DISCOVERY_PORT = 12414;
export const TCP_PORT = 12416;
const DISCOVERY_REQUEST = Buffer.from([0, 0, 0, 3, 3, 0, 0, 3]);

// ---------- varlen / Paket-Codec ----------
export function encodeVarlen(n) {
  if (n < 128) return Buffer.from([n]);
  const out = [];
  for (;;) {
    const b7 = n & 0x7f;
    n >>= 7;
    if (n > 0) out.push(0x80 | b7);
    else { out.push(b7); break; }
  }
  return Buffer.from(out);
}

export function buildPacket(cmd, payload = Buffer.alloc(0)) {
  const bodyLen = 1 + 2 + payload.length;
  return Buffer.concat([
    Buffer.from([0, 0, 0, 3]),
    encodeVarlen(bodyLen),
    Buffer.from([0]), // Flag 0 = angefordert; Geräte setzen 1 bei Push
    Buffer.from([cmd >> 8, cmd & 0xff]),
    payload,
  ]);
}

export function parsePacket(data) {
  if (data.length < 7 || data.readUInt32BE(0) !== 3) {
    throw new Error('bad prefix: ' + data.toString('hex'));
  }
  let idx = 4;
  let length = 0;
  let shift = 0;
  for (;;) {
    if (idx >= data.length) throw new Error('unvollständiges varlen');
    const b = data[idx++];
    length |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  const flag = data[idx++];
  const cmd = data.readUInt16BE(idx);
  idx += 2;
  return { flag, cmd, length, payload: data.subarray(idx) };
}

// Deframing über die varlen-Länge — TCP-Chunks können Pakete zerreißen oder
// mehrere Pakete in einem Chunk liefern.
export class Deframer {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 4 || this.buf.readUInt32BE(0) !== 3) {
        if (this.buf.length >= 4) throw new Error('bad prefix im Stream: ' + this.buf.subarray(0, 16).toString('hex'));
        break;
      }
      let idx = 4;
      let len = 0;
      let shift = 0;
      let complete = false;
      for (;;) {
        if (idx >= this.buf.length) break; // varlen noch nicht komplett
        const b = this.buf[idx++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) { complete = true; break; }
      }
      if (!complete) break;
      const total = idx + len;
      if (this.buf.length < total) break; // Payload noch nicht komplett
      out.push(parsePacket(this.buf.subarray(0, total)));
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

// ---------- Discovery (UDP 12414) ----------
// Felder in der 0x0004-Antwort: u16BE-Länge + Daten
function field16(buf, off) {
  if (off + 2 > buf.length) return [null, off];
  const len = buf.readUInt16BE(off);
  if (off + 2 + len > buf.length) return [null, off];
  return [buf.subarray(off + 2, off + 2 + len), off + 2 + len];
}

export function parseDiscoveryResponse(msg) {
  const { cmd, payload } = parsePacket(msg);
  if (cmd !== 0x0004) return null;
  let off = 0;
  let uid;
  let mac;
  let fw;
  let key;
  [uid, off] = field16(payload, off);
  [mac, off] = field16(payload, off);
  [fw, off] = field16(payload, off);
  [key, off] = field16(payload, off);
  if (!key || !key.length) return null;
  return {
    did: uid ? uid.toString('ascii') : '',
    mac: mac ? mac.toString('hex') : '',
    firmware: fw ? fw.toString('ascii') : '',
    productKey: key.toString('ascii'),
  };
}

// ip: '255.255.255.255' (Broadcast) oder gerichtet an eine Geräte-IP.
// Liefert [{ ip, did, mac, firmware, productKey }], dedupliziert nach IP.
export function discover({ ip = '255.255.255.255', timeoutMs = 2500, retries = 3, retryDelayMs = 300 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = new Map();
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      try { sock.close(); } catch { /* schon zu */ }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const d = parseDiscoveryResponse(msg);
        if (d && !found.has(rinfo.address)) found.set(rinfo.address, { ip: rinfo.address, ...d });
      } catch { /* fremde/fehlerhafte Antwort ignorieren */ }
    });
    sock.bind(() => {
      try {
        if (ip === '255.255.255.255') sock.setBroadcast(true);
        for (let i = 0; i < retries; i++) {
          setTimeout(() => { try { sock.send(DISCOVERY_REQUEST, DISCOVERY_PORT, ip); } catch { /* best effort */ } }, i * retryDelayMs);
        }
        timer = setTimeout(finish, timeoutMs);
      } catch { finish(); }
    });
  });
}

// ---------- Wavemaker-Datenpunkt-Layout ----------
// Bit-Gruppe Byte 0–1 = „swapped": u16BE, Bit i = Bit i dieses u16
// (Bit 0 = LSB des u16, liegt also im ZWEITEN Byte — Referenz set_swapped_bits).
const BIT0 = {
  SwitchON: { bit: 0, len: 1 }, PulseTide: { bit: 1, len: 1 },
  FeedSwitch: { bit: 2, len: 1 }, TimerON: { bit: 3, len: 1 },
  AutoPulseTide: { bit: 4, len: 1 }, Mode: { bit: 5, len: 2 },
  Linkage: { bit: 7, len: 2 }, AutoMode: { bit: 9, len: 3 },
};

export const FAULT_CODES = [
  'overcurrent', 'overvoltage', 'overtemperature', 'undervoltage',
  'blocked', 'dryrun', 'uart',
];

const pad2 = (n) => String(n).padStart(2, '0');

// 401-B-Statusdaten (Action-Byte bereits entfernt) → dekodierter Zustand.
// Tolerant bei kurzen Frames: Kernfelder ab 8 B, Datum/Zeit ab 400 B, Faults ab 401 B.
export function decodeStatus(sd) {
  if (!Buffer.isBuffer(sd) || sd.length < 8) return null;
  const bits = sd.readUInt16BE(0);
  const st = {
    on: !!(bits & (1 << BIT0.SwitchON.bit)),
    pulseTide: !!(bits & (1 << BIT0.PulseTide.bit)),
    feed: !!(bits & (1 << BIT0.FeedSwitch.bit)),
    timerOn: !!(bits & (1 << BIT0.TimerON.bit)),
    autoPulseTide: !!(bits & (1 << BIT0.AutoPulseTide.bit)),
    mode: (bits >> BIT0.Mode.bit) & 3,       // 0 Klassisch / 1 Sinus / 2 Zufall / 3 Konstant
    linkage: (bits >> BIT0.Linkage.bit) & 3, // 0 Unabhängig / 1 Master / 2 Slave
    autoMode: (bits >> BIT0.AutoMode.bit) & 7,
    flow: sd[2],
    frequency: sd[3],
    feedTimeMin: sd[4],
    autoFlow: sd[5],
    autoFreq: sd[6],
    autoFeedTime: sd[7],
    faults: [],
    deviceDate: null,
    deviceTime: null,
  };
  if (sd.length >= 400) {
    // Datum: Jahrhundert/Jahr/Monat/Tag als Zahlen (14 1a 08 03 = 2026-08-03)
    st.deviceDate = `${sd[392] * 100 + sd[393]}-${pad2(sd[394])}-${pad2(sd[395])}`;
    // Zeit: 0/h/min/s
    st.deviceTime = `${pad2(sd[397])}:${pad2(sd[398])}:${pad2(sd[399])}`;
  }
  if (sd.length >= 401) {
    const f = sd[400];
    st.faults = FAULT_CODES.filter((_, i) => f & (1 << i));
  }
  return st;
}

// Status-Payload (cmd 0x91/0x93) → 401-B-Statusdaten.
// Solicited: [Action 0x03/0x04][401 B]. Unsolicited (ESP32-C3): ggf. Präfix
// (z. B. UID) — die Statusdaten sind bei beiden Firmware-Generationen die
// letzten 401 Bytes (Referenz: payload[-max_status_len:]).
export function statusDataFromPayload(payload) {
  if (!Buffer.isBuffer(payload)) return null;
  if (payload.length >= 402 && (payload[0] === 0x03 || payload[0] === 0x04)) {
    return payload.subarray(1, 402);
  }
  if (payload.length >= 401) return payload.subarray(payload.length - 401);
  if (payload.length >= 9 && (payload[0] === 0x03 || payload[0] === 0x04)) return payload.subarray(1);
  return null;
}

// ---------- Schreiben (0x93 → 0x94, partielles Update) ----------
// attr_flags: 1 Bit je Attribut-ID (id//8 = Byte, id%8 = Bit; Byte-Reihenfolge
// umgedreht: flags_byte = len-1-byte_index — Referenz _set_one_writable_attribute).
// attr_values: gepackte Datenpunkte; Bit-Gruppe an Byte 0 als u16BE (swapped).
export const WAVE_ATTRS = {
  SwitchON: { id: 0, kind: 'swapped', bit: 0, len: 1, bool: true },
  PulseTide: { id: 1, kind: 'swapped', bit: 1, len: 1, bool: true },
  FeedSwitch: { id: 2, kind: 'swapped', bit: 2, len: 1, bool: true },
  TimerON: { id: 3, kind: 'swapped', bit: 3, len: 1, bool: true },
  AutoPulseTide: { id: 4, kind: 'swapped', bit: 4, len: 1, bool: true },
  Mode: { id: 5, kind: 'swapped', bit: 5, len: 2 },
  Linkage: { id: 6, kind: 'swapped', bit: 7, len: 2 },
  AutoMode: { id: 7, kind: 'swapped', bit: 9, len: 3 },
  Flow: { id: 8, kind: 'byte', byte: 2 },
  Frequency: { id: 9, kind: 'byte', byte: 3 },
  FeedTime: { id: 10, kind: 'byte', byte: 4 },
  AutoFlow: { id: 11, kind: 'byte', byte: 5 },
  AutoFreq: { id: 12, kind: 'byte', byte: 6 },
  AutoFeedTime: { id: 13, kind: 'byte', byte: 7 },
};

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

// seq-Generator: Sekunden-Anteil im High-Byte (Referenz: int(time.time()) &
// 0xFFFF) + monotoner Zähler im Low-Byte. Ohne Zähler bekämen zwei Writes in
// derselben Sekunde dieselbe seq — der 0x94-Waiter-Key (seq-Echo) kollidierte
// und nur einer der beiden Writes liefe auf.
let seqCounter = 0;
export function nextSeq() {
  seqCounter = (seqCounter + 1) & 0xff;
  return (((Math.floor(Date.now() / 1000) & 0xff) << 8) | seqCounter) >>> 0;
}

// updates: { AttrName: value }. seq: u32BE (Default: nextSeq()).
export function buildWritePayload(updates, seq = nextSeq()) {
  const names = Object.keys(updates);
  if (!names.length) throw new Error('keine Attribute übergeben');
  for (const n of names) if (!WAVE_ATTRS[n]) throw new Error(`unbekanntes Attribut "${n}"`);
  const maxId = Math.max(...names.map((n) => WAVE_ATTRS[n].id));
  const flagsLen = (maxId >> 3) + 1;
  const flags = Buffer.alloc(flagsLen);
  let maxOffset = 0;
  for (const n of names) {
    const a = WAVE_ATTRS[n];
    maxOffset = Math.max(maxOffset, a.kind === 'byte' ? a.byte + 1 : 2);
  }
  const values = Buffer.alloc(maxOffset);
  for (const n of names) {
    const a = WAVE_ATTRS[n];
    flags[flagsLen - 1 - (a.id >> 3)] |= 1 << (a.id & 7);
    const raw = a.bool ? (truthy(updates[n]) ? 1 : 0) : Number(updates[n]);
    if (a.kind === 'swapped') {
      const mask = (1 << a.len) - 1;
      let avn = values.readUInt16BE(0);
      avn &= ~(mask << a.bit);
      avn |= (raw & mask) << a.bit;
      values.writeUInt16BE(avn, 0);
    } else {
      values[a.byte] = raw & 0xff;
    }
  }
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(seq >>> 0, 0);
  return { seq: seq >>> 0, payload: Buffer.concat([seqBuf, Buffer.from([0x01]), flags, values]) };
}

// ---------- TCP-Client mit Login, Keepalive und Auto-Reconnect ----------
// Events: 'connect' | 'disconnect' | 'status' (dekodiert) | 'error'
export class JebaoClient extends EventEmitter {
  constructor(ip, {
    port = TCP_PORT,
    pingIntervalMs = 4000,
    pongTimeoutMs = 12000,
    minReconnectMs = 2000,
    maxReconnectMs = 60000,
    commandTimeoutMs = 5000,
  } = {}) {
    super();
    this.ip = ip;
    this.port = port;
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.minReconnectMs = minReconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.connected = false;
    this.lastStatus = null;
    this._sock = null;
    this._deframer = new Deframer();
    this._waiters = new Map(); // key → { resolve, timer }
    this._closed = false;
    this._connecting = null;
    this._backoffMs = minReconnectMs;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._lastRx = 0;
  }

  // Startet die Verbindungsschleife (Login, dann Keepalive + Reconnect bei Abbruch).
  // Wirft nicht — Fehler laufen über 'error'/'disconnect' und den Backoff-Reconnect.
  connect() {
    this._closed = false;
    if (!this._connecting) this._connecting = this._connectLoop();
    return this._connecting;
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopKeepalive();
    this._failAllWaiters(new Error('Client geschlossen'));
    try { this._sock?.destroy(); } catch { /* best effort */ }
    this._sock = null;
    this.connected = false;
  }

  async _connectLoop() {
    while (!this._closed) {
      try {
        await this._connectOnce();
        return; // Verbindung steht — Reconnect übernimmt der close-Handler
      } catch (e) {
        this.emit('error', e);
        this._teardown();
        if (this._closed) return;
        const wait = this._backoffMs;
        this._backoffMs = Math.min(this.maxReconnectMs, this._backoffMs * 2);
        await new Promise((resolve) => {
          this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; resolve(); }, wait);
        });
      }
    }
  }

  async _connectOnce() {
    const sock = net.connect({ host: this.ip, port: this.port });
    this._sock = sock;
    this._deframer = new Deframer();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`TCP-Timeout zu ${this.ip}:${this.port}`)), this.commandTimeoutMs);
      sock.once('connect', () => { clearTimeout(t); resolve(); });
      sock.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    sock.on('data', (chunk) => {
      let packets;
      try { packets = this._deframer.push(chunk); } catch (e) { this.emit('error', e); sock.destroy(); return; }
      for (const p of packets) this._handlePacket(p);
    });
    sock.on('error', () => { /* close-Handler übernimmt */ });
    sock.on('close', () => {
      // Nur eine etablierte Verbindung triggert den Backoff-Reconnect hier;
      // schlägt _connectOnce fehl (Login, Timeout), steuert die Schleife selbst.
      const wasConnected = this.connected;
      this._teardown();
      if (wasConnected) {
        this.emit('disconnect');
        if (!this._closed) this._scheduleReconnect();
      }
    });

    // Login-Sequenz
    await delay(150);
    const pc = await this._send(0x0006, 0x0007);
    if (pc.payload.length < 2) throw new Error('Login: keine Passcode-Länge in 0x07');
    const pcLen = pc.payload.readUInt16BE(0);
    if (!pcLen) throw new Error('Login: Gerät nicht im Bindungsmodus (Passcode leer)');
    const passcode = pc.payload.subarray(2, 2 + pcLen);
    const lp = Buffer.alloc(2 + passcode.length);
    lp.writeUInt16BE(passcode.length, 0);
    passcode.copy(lp, 2);
    const login = await this._send(0x0008, 0x0009, lp);
    if (login.payload[0] !== 0) throw new Error(`Login abgelehnt (Code ${login.payload[0]})`);
    // ESP32-C3 schickt oft eine zweite 0x09 — abwarten, sonst klebt sie am
    // nächsten Befehl (Waiter sind cmd-zugeordnet, kein FIFO).
    await delay(350);
    this.connected = true;
    this._lastRx = Date.now();
    this._backoffMs = this.minReconnectMs;
    this._startKeepalive();
    this.emit('connect');
    // Initialer Status best effort — ein Fehler hier darf den Login nicht kippen
    try { await this.readStatus(); } catch (e) { this.emit('error', e); }
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const wait = this._backoffMs;
    this._backoffMs = Math.min(this.maxReconnectMs, this._backoffMs * 2);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this._connecting = this._connectLoop();
    }, wait);
  }

  _teardown() {
    this.connected = false;
    this._stopKeepalive();
    this._failAllWaiters(new Error('Verbindung getrennt'));
    try { this._sock?.destroy(); } catch { /* best effort */ }
    this._sock = null;
  }

  _failAllWaiters(err) {
    for (const [, w] of this._waiters) { clearTimeout(w.timer); w.reject(err); }
    this._waiters.clear();
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._pingTimer = setInterval(() => {
      if (!this.connected || !this._sock) return;
      if (Date.now() - this._lastRx > this.pongTimeoutMs) {
        this.emit('error', new Error(`Pong-Timeout (${this.pongTimeoutMs} ms ohne Antwort)`));
        this._sock.destroy();
        return;
      }
      try { this._sock.write(buildPacket(0x0001)); } catch { /* close-Handler übernimmt */ }
    }, this.pingIntervalMs);
  }

  _stopKeepalive() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _handlePacket({ flag, cmd, payload }) {
    this._lastRx = Date.now();
    if (cmd === 0x0002) return; // Pong — _lastRx reicht als Lebenszeichen
    if (cmd === 0x0062) return; // ESP32-C3: unaufgefordert, ohne Nutzlast-Bedeutung
    const seqKey = cmd === 0x0094 && payload.length >= 4
      ? `0x94:${payload.subarray(0, 4).toString('hex')}` : null;
    let key = null;
    if (seqKey && this._waiters.has(seqKey)) key = seqKey;
    else if (this._waiters.has(cmd)) key = cmd;
    if (key) {
      const waiter = this._waiters.get(key);
      this._waiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve({ flag, cmd, payload });
      return;
    }
    // Unaufgeforderte Status-Pushes (Flag = 1): cmd 0x91/0x93
    if (cmd === 0x0091 || cmd === 0x0093) {
      const st = decodeStatus(statusDataFromPayload(payload));
      if (st) { this.lastStatus = st; this.emit('status', st); }
    }
    // Doppelte 0x09 (ESP32-C3) und alles andere: ignorieren
  }

  _send(cmd, expectCmd, payload = Buffer.alloc(0), timeoutMs = this.commandTimeoutMs, waiterKey = null) {
    return new Promise((resolve, reject) => {
      if (!this._sock) return reject(new Error('nicht verbunden'));
      const key = waiterKey ?? expectCmd;
      const timer = setTimeout(() => {
        this._waiters.delete(key);
        reject(new Error(`Timeout cmd 0x${expectCmd.toString(16)}`));
      }, timeoutMs);
      this._waiters.set(key, { resolve, reject, timer });
      try { this._sock.write(buildPacket(cmd, payload)); } catch (e) {
        clearTimeout(timer);
        this._waiters.delete(key);
        reject(e);
      }
    });
  }

  // 0x0090 [0x02] → 0x0091; dekodiert und feuert 'status'.
  async readStatus() {
    const p = await this._send(0x0090, 0x0091, Buffer.from([0x02]));
    const st = decodeStatus(statusDataFromPayload(p.payload));
    if (!st) throw new Error(`unerwartete Status-Antwort (${p.payload.length} B)`);
    this.lastStatus = st;
    this.emit('status', st);
    return st;
  }

  // Partielles Update (0x0093 → 0x0094, Ack per seq-Echo zugeordnet).
  async writeDatapoints(updates) {
    const { seq, payload } = buildWritePayload(updates);
    const seqHex = payload.subarray(0, 4).toString('hex');
    const ack = await this._send(0x0093, 0x0094, payload, this.commandTimeoutMs, `0x94:${seqHex}`);
    return { seq, ack: ack.payload };
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
