// Round-trip-Test tankListDetails: UTF-16BE-JSON parse → generate → Byte-Vergleich
import fs from 'node:fs';

const buf = fs.readFileSync('dumps/0024_CLOUD_APP_refresh_tankListDetails_0000000000000000.bin');
const readZ = (b, o) => { const e = b.indexOf(0, o); return e + 1; };
const o4 = [0, 0, 0, 0].reduce((o) => readZ(buf, o), 0);
const payload = buf.subarray(o4);

const text = Buffer.from(payload).swap16().toString('utf16le');
const jsonEnd = text.lastIndexOf('}') + 1;
const trailing = text.slice(jsonEnd);
console.log(`JSON ${jsonEnd} Zeichen, Trailing: ${JSON.stringify(trailing)}`);

const model = JSON.parse(text.slice(0, jsonEnd));

function generate(model, trailing = '\0') {
  const t = JSON.stringify(model) + trailing;
  const b = Buffer.alloc(t.length * 2);
  for (let i = 0; i < t.length; i++) b.writeUInt16BE(t.charCodeAt(i), i * 2);
  return b;
}

const regen = generate(model, trailing);
console.log(`Original ${payload.length} B, regen ${regen.length} B`);
console.log(regen.equals(payload) ? '✅ ROUND-TRIP BYTE-IDENTISCH' : '❌ Abweichung');

// Sparse-Array-Struktur: Index des Tank-Eintrags
const idx = model.tankDetails.findIndex((e) => e !== null);
console.log(`Tank-Params an Index ${idx} von ${model.tankDetails.length}: ${JSON.stringify(model.tankDetails[idx])}`);
console.log(`tankTypes: ${model.tankTypes.length} Einträge (statischer Katalog)`);
