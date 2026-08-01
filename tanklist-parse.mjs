// Parser für refresh/tankList: zerlegt Dump 0020 in Tank + Geräte-Records + Trailer.
// Ziel: vollständiges Feld-Schema + Round-trip (parse → generate → byte-identisch).
import fs from 'node:fs';

const buf = fs.readFileSync('dumps/0020_CLOUD_APP_refresh_tankList_0000000000000000.bin');

function readZ(b, off) { const e = b.indexOf(0, off); return [b.subarray(off, e).toString('latin1'), e + 1]; }
const [, o1] = readZ(buf, 0); const [, o2] = readZ(buf, o1); const [, o3] = readZ(buf, o2);
const [, o4] = readZ(buf, o3);
const p = buf.subarray(o4);

function u16s(b, off) { // UTF-16BE-String + u16-NUL-Terminator
  let e = off;
  while (e + 1 < b.length && !(b[e] === 0 && b[e + 1] === 0)) e += 2;
  return [b.subarray(off, e).swap16().toString('latin1'), e + 2];
}
const hex = (b) => b.toString('hex').replace(/(..)/g, '$1 ').trim();

let off = 0;
const tankCount = p.readUInt32BE(off); off += 4;
console.log(`tankCount = ${tankCount}`);

for (let t = 0; t < tankCount; t++) {
  const tFlags = p.readUInt16BE(off); off += 2;
  const [tankName, o5] = u16s(p, off); off = o5;
  const devCount = p.readUInt32BE(off); off += 4;
  console.log(`\nTank ${t}: flags=0x${tFlags.toString(16).padStart(4, '0')} name="${tankName}" devCount=${devCount}`);

  for (let d = 0; d < devCount; d++) {
    const dbId1 = p.readUInt32BE(off); off += 4;
    const [devName, o6] = u16s(p, off); off = o6;
    const [serial, o7] = readZ(p, off); off = o7;
    const online = p[off]; off += 1;
    const unk1 = p.readUInt32BE(off); off += 4;
    const unk2 = p.readUInt16BE(off); off += 2;
    const code2 = p.subarray(off, off + 2).toString('latin1'); off += 2;
    const unk3 = p.readUInt32BE(off); off += 4;
    const z0 = p[off]; off += 1;
    const [capCode, o8] = readZ(p, off); off = o8;
    const unk4 = p.subarray(off, off + 3); off += 3;
    const unk5 = p.readUInt32BE(off); off += 4;
    const rowId = p.readUInt32BE(off); off += 4;
    console.log(`  [${d}] dbId1=${dbId1} name="${devName}" serial=${serial} online=${online} unk1=${unk1} unk2=${unk2} code2="${code2}" unk3=${unk3} z0=${z0} cap="${capCode}" unk4=${hex(unk4)} unk5=${unk5} rowId=${rowId}`);
  }
}
console.log(`\nTrailer ab 0x${off.toString(16)} (${p.length - off} B):`);
console.log(`  Kopf: ${hex(p.subarray(off, off + 64))}`);
// Nicht-Null-Bereiche im Trailer finden
let i = off;
while (i < p.length) {
  if (p[i] !== 0) {
    let e = i;
    while (e < p.length && p[e] !== 0) e++;
    console.log(`  [0x${i.toString(16)}..0x${e.toString(16)}] ${e - i} B: ${hex(p.subarray(i, Math.min(e, i + 96)))}`);
    i = e;
  } else i++;
}
