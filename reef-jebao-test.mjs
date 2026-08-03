// Isolierte Tests des Gizwits-LAN-Clients (reef-jebao.mjs), OHNE Gerätekontakt:
// Paket-Codec, Discovery-Parsing, Status-Dekodierung, Write-Packing, Deframing
// sowie ein kompletter Login/Read/Write/Keepalive-Durchlauf gegen einen
// lokalen Fake-Gizwits-Server auf 127.0.0.1. Aufruf:
//   node reef-jebao-test.mjs
import net from 'node:net';
import {
  encodeVarlen, buildPacket, parsePacket, Deframer,
  parseDiscoveryResponse, decodeStatus, statusDataFromPayload,
  buildWritePayload, JebaoClient, JEBAO_PRODUCT_KEY,
} from './reef-jebao.mjs';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`      erwartet: ${JSON.stringify(expected)}`);
    console.log(`      erhalten: ${JSON.stringify(actual)}`);
    failures++;
  }
}

// =====================================================================
// 1) varlen + Paket-Roundtrip (auch >127)
// =====================================================================
check('varlen: 3 → 1 Byte', [...encodeVarlen(3)], [3]);
check('varlen: 127 → 1 Byte', [...encodeVarlen(127)], [127]);
check('varlen: 128 → 2 Bytes', [...encodeVarlen(128)], [0x80, 0x01]);
check('varlen: 404 → 2 Bytes', [...encodeVarlen(404)], [0x94, 0x03]); // 404 = 0b11_0010100

const small = buildPacket(0x0006);
check('buildPacket: Header + cmd 0x0006', [...small], [0, 0, 0, 3, 3, 0, 0, 6]);
const bigPayload = Buffer.alloc(400, 0xab);
const big = buildPacket(0x0093, bigPayload);
check('buildPacket: varlen >127 (403 = 0x93 0x03)', [...big.subarray(4, 6)], [0x93, 0x03]);
const parsedBig = parsePacket(big);
check('parsePacket: Roundtrip cmd/flag/Länge',
  [parsedBig.cmd, parsedBig.flag, parsedBig.length, parsedBig.payload.length],
  [0x0093, 0, 403, 400]);

// =====================================================================
// 2) Deframing gestückelter Pakete
// =====================================================================
{
  const d = new Deframer();
  const p1 = buildPacket(0x0009, Buffer.from([0]));
  const p2 = buildPacket(0x0091, Buffer.concat([Buffer.from([0x04]), Buffer.alloc(401, 0x11)]));
  const stream = Buffer.concat([p1, p2]);
  // Byte für Byte füttern: kein Paket darf verloren gehen oder zerhackt werden
  let out = [];
  for (let i = 0; i < stream.length; i++) out = out.concat(d.push(stream.subarray(i, i + 1)));
  check('Deframer: byteweise → 2 Pakete', out.length, 2);
  check('Deframer: Paket 1 = Login-Ack', [out[0].cmd, out[0].payload[0]], [0x0009, 0]);
  check('Deframer: Paket 2 = Status (402 B Payload)',
    [out[1].cmd, out[1].payload.length, out[1].payload[0]], [0x0091, 402, 0x04]);
  // Alles auf einmal: gleiche Pakete
  const d2 = new Deframer();
  check('Deframer: ganzer Strom → 2 Pakete', d2.push(stream).length, 2);
  // Halbes Paket zurückhalten
  const d3 = new Deframer();
  check('Deframer: halbes Paket → noch nichts', d3.push(p2.subarray(0, 10)).length, 0);
  check('Deframer: Rest nachgeschoben → 1 Paket', d3.push(p2.subarray(10)).length, 1);
}

// =====================================================================
// 3) Discovery-Response (echtes 127-B-Frame vom 03.08., synthetisch nachgebaut)
//    uid CkPd90lp2kqvdkxDPZmJbq, mac 1cdbd412c648, fw 04X3JB0S, key 54114…
// =====================================================================
function f16(buf) { const h = Buffer.alloc(2); h.writeUInt16BE(buf.length, 0); return Buffer.concat([h, buf]); }
{
  const essential = Buffer.concat([
    f16(Buffer.from('CkPd90lp2kqvdkxDPZmJbq', 'ascii')),
    f16(Buffer.from('1cdbd412c648', 'hex')),
    f16(Buffer.from('04X3JB0S', 'ascii')),
    f16(Buffer.from(JEBAO_PRODUCT_KEY, 'ascii')),
  ]);
  // Trailer wie das echte Gerät: 8 B MCU-Attrs + cstrings (API-Server, Version)
  const trailer = Buffer.concat([
    Buffer.alloc(8),
    Buffer.from('api.gizwits.com\0', 'ascii'),
    Buffer.alloc(19), // Auffüllen auf exakt 127 B Gesamt-Frame
  ]);
  const payload = Buffer.concat([essential, trailer]);
  const frame = buildPacket(0x0004, payload);
  check('Discovery: Frame ist exakt 127 B', frame.length, 127);
  const d = parseDiscoveryResponse(frame);
  check('Discovery: uid (DID)', d.did, 'CkPd90lp2kqvdkxDPZmJbq');
  check('Discovery: MAC', d.mac, '1cdbd412c648');
  check('Discovery: Firmware', d.firmware, '04X3JB0S');
  check('Discovery: product_key', d.productKey, JEBAO_PRODUCT_KEY);
  // Fremde cmd → null
  check('Discovery: cmd ≠ 0x0004 → null', parseDiscoveryResponse(buildPacket(0x0002)), null);
}

// =====================================================================
// 4) Status-Dekodierung — Live-Werte vom 03.08. (Roh 04691e050a646401…)
//    ON=true, Timer=true, Modus=3 Konstant, Linkage=0, Flow=30, Freq=5,
//    FeedTime=10, Datum 2026-08-03, Zeit 12:40:30, keine Fehler
// =====================================================================
function synthStatus({ bits = 0x0469, flow = 30, freq = 5, feedTime = 10,
  autoFlow = 100, autoFreq = 100, autoFeedTime = 1,
  date = [0x14, 0x1a, 0x08, 0x03], time = [0x00, 0x0c, 0x28, 0x1e], faults = 0 } = {}) {
  const sd = Buffer.alloc(401);
  sd.writeUInt16BE(bits, 0);
  sd[2] = flow; sd[3] = freq; sd[4] = feedTime;
  sd[5] = autoFlow; sd[6] = autoFreq; sd[7] = autoFeedTime;
  // Bytes 8–391: 48 Timer-Slots à 8 B — alle 0
  date.forEach((v, i) => { sd[392 + i] = v; });
  time.forEach((v, i) => { sd[396 + i] = v; });
  sd[400] = faults;
  return sd;
}

{
  const st = decodeStatus(synthStatus());
  check('Status: EIN + Puls/Flut aus', [st.on, st.pulseTide], [true, false]);
  check('Status: Fütterung aus + Timer an', [st.feed, st.timerOn], [false, true]);
  check('Status: Modus 3 (Konstant), Linkage 0 (Unabhängig), AutoMode 2',
    [st.mode, st.linkage, st.autoMode], [3, 0, 2]);
  check('Status: Flow/Freq/FeedTime', [st.flow, st.frequency, st.feedTimeMin], [30, 5, 10]);
  check('Status: Auto-Werte', [st.autoFlow, st.autoFreq, st.autoFeedTime], [100, 100, 1]);
  check('Status: Gerätedatum 2026-08-03', st.deviceDate, '2026-08-03');
  check('Status: Gerätezeit 12:40:30', st.deviceTime, '12:40:30');
  check('Status: keine Fehler', st.faults, []);
  // Solicited-Form: Action-Byte 0x04 vorne dran
  const p = Buffer.concat([Buffer.from([0x04]), synthStatus()]);
  check('Status: solicited Payload → gleiche Dekodierung', decodeStatus(statusDataFromPayload(p)).flow, 30);
  // Unsolicited mit Fremdpräfix (ESP32-C3 hängt UID voran): letzte 401 B zählen
  const p2 = Buffer.concat([Buffer.from('CkPd90lp2kqvdkxDPZmJbq', 'ascii'), synthStatus()]);
  check('Status: Präfix-Form → letzte 401 B', decodeStatus(statusDataFromPayload(p2)).frequency, 5);
  // Zu kurz → null
  check('Status: 7 B → null', decodeStatus(Buffer.alloc(7)), null);
}

// Fault-Bits einzeln (Byte 400: 7 Fault-Bits)
{
  const names = ['overcurrent', 'overvoltage', 'overtemperature', 'undervoltage', 'blocked', 'dryrun', 'uart'];
  for (let i = 0; i < 7; i++) {
    check(`Fault-Bit ${i} = ${names[i]}`, decodeStatus(synthStatus({ faults: 1 << i })).faults, [names[i]]);
  }
  check('Faults: mehrere gleichzeitig', decodeStatus(synthStatus({ faults: 0b0010011 })).faults,
    ['overcurrent', 'overvoltage', 'blocked']);
}

// =====================================================================
// 5) Write-Payload-Packing (0x93): attr_flags + swapped-bit-Gruppe
// =====================================================================
{
  // Flow (id 8) + Mode (id 5): flags [0x01, 0x20], Werte [00 40, 1e]
  const { payload } = buildWritePayload({ Flow: 30, Mode: 2 }, 0x1234);
  check('Write: seq u32BE', [...payload.subarray(0, 4)], [0, 0, 0x12, 0x34]);
  check('Write: Action-Byte 0x01', payload[4], 0x01);
  check('Write: attr_flags Flow+Mode (Bytereihenfolge umgedreht)',
    [...payload.subarray(5, 7)], [0x01, 0x20]);
  check('Write: Mode=2 als swapped bits (u16BE 0x0040) + Flow',
    [...payload.subarray(7)], [0x00, 0x40, 0x1e]);
  // Nur SwitchON (id 0): 1 Flag-Byte, Bit 0 im u16
  const p2 = buildWritePayload({ SwitchON: true }, 1);
  check('Write: SwitchON allein → flags [0x01], u16 0x0001',
    [[...p2.payload.subarray(5, 6)], p2.payload.readUInt16BE(6)], [[0x01], 0x0001]);
  // FeedSwitch + FeedTime: id 2 + id 10
  const p3 = buildWritePayload({ FeedSwitch: 1, FeedTime: 15 }, 1);
  check('Write: FeedSwitch+FeedTime flags', [...p3.payload.subarray(5, 7)], [0x04, 0x04]);
  check('Write: FeedSwitch-Bit + FeedTime-Byte (attr_values bis Byte 4)',
    [p3.payload.readUInt16BE(7), p3.payload[11]], [0x0004, 15]);
  // AutoMode (id 7, bits 9–11, Länge 3)
  const p4 = buildWritePayload({ AutoMode: 5 }, 1);
  check('Write: AutoMode=5 → u16 5<<9 = 0x0A00', p4.payload.readUInt16BE(6), 5 << 9);
  // Fehlerfälle
  let threw = 0;
  try { buildWritePayload({ Unbekannt: 1 }); } catch { threw++; }
  try { buildWritePayload({}); } catch { threw++; }
  check('Write: unbekanntes Attribut / leer → Fehler', threw, 2);
  // Default-seq: Sekunden im High-Byte, monotoner Zähler im Low-Byte —
  // zwei Writes in derselben Sekunde müssen verschiedene seqs bekommen,
  // sonst kollidiert der 0x94-Waiter-Key (seq-Echo)
  const p5 = buildWritePayload({ SwitchON: false });
  check('Write: Default-seq High-Byte = Epoch-Sekunden & 0xFF',
    p5.seq >> 8, Math.floor(Date.now() / 1000) & 0xFF);
  const p5b = buildWritePayload({ SwitchON: true });
  check('Write: aufeinanderfolgende seqs eindeutig (Zähler im Low-Byte)',
    [p5.seq !== p5b.seq, (p5b.seq & 0xff) === ((p5.seq + 1) & 0xff)], [true, true]);
  // Zwei parallele Writes: beide Waiter-Keys verschieden → beide auflösbar
  const keys = new Set([p5, p5b].map((p) => `0x94:${p.payload.subarray(0, 4).toString('hex')}`));
  check('Write: Waiter-Keys (seq-Echo) kollidieren nicht', keys.size, 2);
}

// =====================================================================
// 6) Kompletter Durchlauf gegen lokalen Fake-Gizwits-Server (127.0.0.1):
//    Login (inkl. doppelter 0x09), Keepalive Ping/Pong, readStatus,
//    writeDatapoints mit seq-Ack, unsolicited Push
// =====================================================================
const PASSCODE = Buffer.from('probe-passcode', 'ascii');

function startFakePump(statusBuf) {
  const seen = { pings: 0, writes: [] };
  const conns = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    const d = new Deframer();
    let sentSecondLogin = false;
    sock.on('data', (chunk) => {
      for (const p of d.push(chunk)) {
        if (p.cmd === 0x0006) {
          const pl = Buffer.alloc(2 + PASSCODE.length);
          pl.writeUInt16BE(PASSCODE.length, 0);
          PASSCODE.copy(pl, 2);
          sock.write(buildPacket(0x0007, pl));
        } else if (p.cmd === 0x0008) {
          sock.write(buildPacket(0x0009, Buffer.from([0])));
          if (!sentSecondLogin) { // ESP32-C3-Verhalten: zweite 0x09 hinterher
            sentSecondLogin = true;
            setTimeout(() => sock.write(buildPacket(0x0009, Buffer.from([0]))), 50);
          }
        } else if (p.cmd === 0x0015) {
          seen.pings++;
          sock.write(buildPacket(0x0016));
        } else if (p.cmd === 0x0090) {
          sock.write(buildPacket(0x0091, Buffer.concat([Buffer.from([0x03]), statusBuf])));
        } else if (p.cmd === 0x0093) {
          seen.writes.push(p.payload);
          // Ack: seq-Echo + Action (Referenz: erste 4 B der 0x94 = seq-Echo)
          sock.write(buildPacket(0x0094, Buffer.concat([p.payload.subarray(0, 4), Buffer.from([0])])));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, conns, port: server.address().port }));
  });
}

// Flag-Byte eines gebauten Frames patchen (Offset = 4 + varlen-Länge)
function patchFlag(frame, flag) {
  let idx = 4;
  while (frame[idx] & 0x80) idx++;
  frame[idx + 1] = flag;
  return frame;
}

{
  const statusBuf = synthStatus({ flow: 42 });
  const fake = await startFakePump(statusBuf);
  const client = new JebaoClient('127.0.0.1', {
    port: fake.port, pingIntervalMs: 80, pongTimeoutMs: 5000, commandTimeoutMs: 2000,
  });
  const errors = [];
  client.on('error', (e) => errors.push(e.message));
  const statuses = [];
  client.on('status', (st) => statuses.push(st));
  await client.connect();
  check('Client: Login-Handshake abgeschlossen', client.connected, true);

  const st = await client.readStatus();
  check('Client: readStatus Flow=42', st.flow, 42);
  check('Client: readStatus Modus/Datum', [st.mode, st.deviceDate], [3, '2026-08-03']);

  const w = await client.writeDatapoints({ Flow: 55, Mode: 1 });
  check('Client: writeDatapoints seq-Roundtrip (Echo = gesendete seq)',
    w.seq, fake.seen.writes[0].readUInt32BE(0));
  // Zweiter Write in derselben Sekunde: eigene seq, beide Acks zugeordnet
  const w2 = await client.writeDatapoints({ Flow: 66 });
  check('Client: zwei Writes gleiche Sekunde → verschiedene seqs',
    [w2.seq !== w.seq, fake.seen.writes.length], [true, 2]);
  check('Client: Write landete auf dem „Gerät"',
    [[...fake.seen.writes[0].subarray(5, 7)], fake.seen.writes[0][9]],
    [[0x01, 0x20], 55]);

  // Keepalive: 80 ms Intervall → nach 350 ms mindestens 2 Pings
  await new Promise((r) => setTimeout(r, 350));
  check('Client: Keepalive-Pings ≥ 2', fake.seen.pings >= 2, true);

  // Unsolicited Push (Flag=1, cmd 0x91) vom „Gerät" → onStatus-Callback
  const before = statuses.length;
  const push = patchFlag(
    buildPacket(0x0091, Buffer.concat([Buffer.from([0x04]), synthStatus({ flow: 77 })])), 1);
  for (const s of fake.conns) s.write(push);
  await new Promise((r) => setTimeout(r, 50));
  check('Client: unsolicited Push → onStatus', statuses.length > before, true);
  check('Client: Push-Flow=77 übernommen', statuses[statuses.length - 1]?.flow, 77);

  // Absichtliches Ende: close() darf kein disconnect-Event feuern
  let disconnected = 0;
  client.on('disconnect', () => disconnected++);
  client.close();
  check('Client: close() → connected=false', client.connected, false);
  await new Promise((r) => setTimeout(r, 50));
  check('Client: close() ohne disconnect-Event', disconnected, 0);
  check('Client: keine Client-Fehler im Durchlauf', errors, []);
  fake.server.close();
}

// Reconnect mit Backoff: Pumpe „stirbt", kommt wieder → Client verbindet erneut
{
  const statusBuf = synthStatus();
  const fake = await startFakePump(statusBuf);
  const client = new JebaoClient('127.0.0.1', {
    port: fake.port, pingIntervalMs: 100, pongTimeoutMs: 600,
    minReconnectMs: 100, maxReconnectMs: 400, commandTimeoutMs: 1000,
  });
  client.on('error', () => {});
  let connects = 0;
  let disconnects = 0;
  client.on('connect', () => connects++);
  client.on('disconnect', () => disconnects++);
  await client.connect();
  check('Reconnect: Initial-Login', connects, 1);
  // Pumpe killen: Sockets zerstören + Port freigeben
  for (const s of fake.conns) s.destroy();
  await new Promise((r) => { fake.server.close(r); });
  await new Promise((r) => setTimeout(r, 50));
  check('Reconnect: Abbruch sofort erkannt', disconnects, 1);
  // Pumpe „startet neu" auf demselben Port
  const fake2 = await new Promise((resolve, reject) => {
    const s2 = net.createServer((sock) => {
      const d = new Deframer();
      sock.on('data', (chunk) => {
        for (const p of d.push(chunk)) {
          if (p.cmd === 0x0006) {
            const pl = Buffer.alloc(2 + PASSCODE.length);
            pl.writeUInt16BE(PASSCODE.length, 0); PASSCODE.copy(pl, 2);
            sock.write(buildPacket(0x0007, pl));
          } else if (p.cmd === 0x0008) sock.write(buildPacket(0x0009, Buffer.from([0])));
          else if (p.cmd === 0x0015) sock.write(buildPacket(0x0016));
          else if (p.cmd === 0x0090) sock.write(buildPacket(0x0091, Buffer.concat([Buffer.from([0x03]), statusBuf])));
        }
      });
    });
    s2.once('error', reject);
    s2.listen(fake.port, '127.0.0.1', () => resolve(s2));
  });
  await new Promise((r) => setTimeout(r, 1500)); // Backoff + Reconnect + Login
  check('Reconnect: erneut verbunden', connects >= 2, true);
  const st2 = await client.readStatus().catch(() => null);
  check('Reconnect: readStatus nach Reconnect', st2?.mode, 3);
  client.close();
  fake2.close();
}

console.log(failures ? `\n${failures} Test(s) FEHLGESCHLAGEN` : '\nAlle Jebao-Tests bestanden');
process.exit(failures ? 1 : 0);
