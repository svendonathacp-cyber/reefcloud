// Analysiert das Binärformat von refresh/tankList (Dump 0020) und tankListDetails (0024).
// Nutzt bekannte Strings (Serials, UTF-16BE-Namen) als Anker und zeigt die Regionen dazwischen.
import fs from 'node:fs';

const FILE = process.argv[2] || 'dumps/0020_CLOUD_APP_refresh_tankList_0000000000000000.bin';
const buf = fs.readFileSync(FILE);

// Frame-Header: serial\0 class\0 method\0 extra\0 → Payload
function readZ(b, off) { const e = b.indexOf(0, off); return [b.subarray(off, e).toString('latin1'), e + 1]; }
let off = 0;
const [serial, o1] = readZ(buf, off); const [cls, o2] = readZ(buf, o1);
const [method, o3] = readZ(buf, o2); const [extra, o4] = readZ(buf, o3);
console.log(`Frame: serial="${serial}" class="${cls}" method="${method}" extra="${extra}"`);
console.log(`Header ${o4} B, Payload ${buf.length - o4} B\n`);
const p = buf.subarray(o4);

// Bekannte Anker im Payload finden
const anchors = [];
for (let i = 0; i < p.length - 2; i++) {
  // RF-Serials: latin1 "RF" + 14 alphanumerische Zeichen
  if (p[i] === 0x52 && p[i + 1] === 0x46) {
    const s = p.subarray(i, i + 16).toString('latin1');
    if (/^RF[A-Z0-9]{14}$/.test(s)) anchors.push({ off: i, type: 'serial', val: s });
  }
}
// UTF-16BE-Strings (mind. 3 Zeichen druckbar)
for (let i = 0; i < p.length - 8; i += 2) {
  let len = 0;
  while (i + len * 2 + 1 < p.length && p[i + len * 2] === 0 && p[i + len * 2 + 1] >= 0x20 && p[i + len * 2 + 1] < 0x7f) len++;
  if (len >= 3) {
    const s = p.subarray(i, i + len * 2).swap16().toString('latin1');
    anchors.push({ off: i, type: 'utf16be', val: s, len: len * 2 });
    i += len * 2;
  }
}
anchors.sort((a, b) => a.off - b.off);

// Überlappende UTF16-Funde (in Serials) rausfiltern
const filtered = [];
for (const a of anchors) {
  const prev = filtered[filtered.length - 1];
  if (prev && a.off < prev.off + (prev.len || prev.val.length)) continue;
  filtered.push(a);
}

console.log('=== Anker (Offset, Typ, Wert) ===');
let lastEnd = 0;
for (const a of filtered) {
  if (a.off > lastEnd) {
    const gap = p.subarray(lastEnd, a.off);
    console.log(`  [0x${lastEnd.toString(16).padStart(4, '0')}..0x${a.off.toString(16).padStart(4, '0')}] GAP ${gap.length} B: ${gap.toString('hex').replace(/(..)/g, '$1 ').trim()}`);
  }
  const end = a.off + (a.len || a.val.length);
  console.log(`  [0x${a.off.toString(16).padStart(4, '0')}..0x${end.toString(16).padStart(4, '0')}] ${a.type}: "${a.val}"`);
  lastEnd = end;
}
if (lastEnd < p.length) {
  const gap = p.subarray(lastEnd);
  console.log(`  [0x${lastEnd.toString(16).padStart(4, '0')}..EOF] GAP ${gap.length} B: ${gap.toString('hex').replace(/(..)/g, '$1 ').trim()}`);
}

// Erste 32 Payload-Bytes als Zähler/Flags interpretieren
console.log('\n=== Payload-Kopf ===');
console.log(`u32BE@0 = ${p.readUInt32BE(0)}  (Tanks?)`);
console.log(`u16BE@4 = ${p.readUInt16BE(4)}  (Flags?)`);
console.log(`Bytes 6..23: ${p.subarray(6, 24).toString('hex').replace(/(..)/g, '$1 ').trim()}`);
