// Isolierte Tests des Frame-Loggers (Zeilenformat, pingTime-Filter, Rotation,
// Auto-Dump mit Dedupe + Login-Schutz), OHNE Server. Aufruf:
//   node reef-framelog-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFrameLog } from './reef-framelog.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framelog-test-'));
const fl = createFrameLog({ dir: path.join(tmp, 'logs'), dumpDir: path.join(tmp, 'dumps'), maxBytes: 400, maxFiles: 3 });

// --- 1) Zeilenformat ---
fl.logFrame({ ts: new Date('2026-08-03T16:00:00.000Z'), direction: 'in', role: 'GERÄT', peer: 'GERÄT:442 ::ffff:192.168.178.198:63164/hardware', cls: 'lkRefresh', method: 'settings', serial: 'RFLK012401230001', extra: 'join_123', frameBytes: 93, payload: Buffer.from([0xde, 0xad]) });
const lines = fs.readFileSync(path.join(tmp, 'logs', 'frames.log'), 'utf8').trim().split('\n');
check('eine Zeile geschrieben', lines.length, 1);
const cols = lines[0].split('\t');
check('Spaltenzahl 9', cols.length, 9);
check('Zeitstempel', cols[0], '2026-08-03T16:00:00.000Z');
check('Richtung/Rolle', [cols[1], cols[2]], ['in', 'GERÄT']);
check('Klasse/Methode', cols[4], 'lkRefresh/settings');
check('Serial/Extra/Länge', [cols[5], cols[6], cols[7]], ['serial="RFLK012401230001"', 'extra="join_123"', '93 B']);
check('Hex-Payload', cols[8], 'dead');

// --- 2) pingTime-Filter ---
fl.logFrame({ direction: 'out', role: 'APP', cls: 'set', method: 'pingTime', frameBytes: 40 });
const after = fs.readFileSync(path.join(tmp, 'logs', 'frames.log'), 'utf8').trim().split('\n');
check('pingTime wird nicht geloggt', after.length, 1);

// --- 3) Rotation bei maxBytes ---
for (let i = 0; i < 20; i++) {
  fl.logFrame({ direction: 'in', role: 'GERÄT', cls: 'swReport', method: 'all', serial: 'RFSW1', frameBytes: 100, payload: Buffer.alloc(50, i) });
}
const rotated = fs.readdirSync(path.join(tmp, 'logs')).sort();
check('Rotation hat frames.1.log erzeugt', rotated.includes('frames.1.log'), true);
check('maxFiles=3: nie mehr als frames.2.log', rotated.includes('frames.3.log'), false);
check('frames.log nach Rotation kleiner als Limit', fs.statSync(path.join(tmp, 'logs', 'frames.log')).size < 400, true);
check('älteste Frames liegen in frames.1.log', fs.readFileSync(path.join(tmp, 'logs', 'frames.1.log'), 'utf8').includes('swReport/all'), true);

// --- 4) Auto-Dump: schreiben, Dedupe, Update ---
const buf1 = Buffer.from('RFLK1\0lkRefresh\0status\0\0\x01\x02\x03', 'latin1');
const p1 = fl.dumpFrame(buf1, { cls: 'lkRefresh', method: 'status', serial: 'RFLK1' });
check('Dump geschrieben', typeof p1 === 'string' && p1.endsWith('GERAET_lkRefresh_status_RFLK1.bin'), true);
check('Dump-Inhalt = Rohframe', fs.readFileSync(p1).equals(buf1), true);
const mtime1 = fs.statSync(p1).mtimeMs;
check('identischer Inhalt → kein Rewrite (null)', fl.dumpFrame(buf1, { cls: 'lkRefresh', method: 'status', serial: 'RFLK1' }), null);
check('Datei unverändert', fs.statSync(p1).mtimeMs, mtime1);
const buf2 = Buffer.from('RFLK1\0lkRefresh\0status\0\0\x09\x09\x09', 'latin1');
const p2 = fl.dumpFrame(buf2, { cls: 'lkRefresh', method: 'status', serial: 'RFLK1' });
check('geänderter Inhalt → Rewrite', p2, p1);
check('neuer Inhalt liegt vor', fs.readFileSync(p1).equals(buf2), true);

// --- 5) Login-Schutz + pingTime + Größenlimit ---
check('user/login wird NICHT gedumpt', fl.dumpFrame(Buffer.from('x'), { cls: 'user', method: 'login', serial: 'RFLK1' }), null);
check('geConnect/login wird NICHT gedumpt', fl.dumpFrame(Buffer.from('x'), { cls: 'geConnect', method: 'login', serial: 'RFSW1' }), null);
check('set/pingTime wird NICHT gedumpt', fl.dumpFrame(Buffer.from('x'), { cls: 'set', method: 'pingTime', serial: '' }), null);
check('Riesenframe wird NICHT gedumpt', fl.dumpFrame(Buffer.alloc(300 * 1024), { cls: 'dzRefresh', method: 'settings', serial: 'RFDZ1' }), null);

// --- 5b) Login-Payloads landen nicht als Hex im Log (Account-Key!) ---
const fl2 = createFrameLog({ dir: path.join(tmp, 'logs2') });
fl2.logFrame({ direction: 'in', role: 'GERÄT', cls: 'user', method: 'login', serial: 'RFLK1', frameBytes: 89, payload: Buffer.from('mail@x.de\0secret-key', 'latin1') });
fl2.logFrame({ direction: 'in', role: 'GERÄT', cls: 'geConnect', method: 'login', serial: 'RFSW1', frameBytes: 100, payload: Buffer.from('{"key":"abc"}', 'latin1') });
const log2 = fs.readFileSync(path.join(tmp, 'logs2', 'frames.log'), 'utf8');
check('user/login ohne Hex', log2.split('\n')[0].endsWith('89 B\t'), true);
check('kein Key im Log', log2.includes('secret-key') || log2.includes(Buffer.from('secret-key').toString('hex')), false);
check('geConnect/login ohne Hex', log2.includes('abc') || log2.includes(Buffer.from('{"key":"abc"}').toString('hex')), false);

// --- 6) Dateiname-Sanitizer (Sonderzeichen in extra/cls) ---
const p3 = fl.dumpFrame(Buffer.from('y'), { cls: 'we ird/cls', method: 'm:e', serial: 'S/1' });
check('unsichere Zeichen → Unterstriche', path.basename(p3), 'GERAET_we_ird_cls_m_e_S_1.bin');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FEHLER` : '\nAlle Tests OK');
process.exit(failures ? 1 : 0);
