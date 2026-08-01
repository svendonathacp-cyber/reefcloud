// Analysiert refresh/tankListDetails (UTF-16BE-JSON im Payload)
import fs from 'node:fs';

const buf = fs.readFileSync('dumps/0024_CLOUD_APP_refresh_tankListDetails_0000000000000000.bin');
const readZ = (b, o) => { const e = b.indexOf(0, o); return e + 1; };
const o4 = [0, 0, 0, 0].reduce((o) => readZ(buf, o), 0);
const payload = buf.subarray(o4);

const text = Buffer.from(payload).swap16().toString('utf16le');
console.log(`Payload ${payload.length} B → JSON-Text ${text.length} Zeichen`);

const json = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
const top = Object.keys(json);
console.log(`Top-Level-Keys: ${top.join(', ')}`);

const td = json.tankDetails;
console.log(`tankDetails: Array mit ${td.length} Einträgen`);
const nonNull = td.map((e, i) => [i, e]).filter(([, e]) => e !== null);
console.log(`Nicht-null: ${nonNull.length}`);
for (const [i, e] of nonNull) {
  const keys = e && typeof e === 'object' ? Object.keys(e).join(',') : typeof e;
  const serial = e?.serial || e?.deviceSerial || e?.Serial || '?';
  console.log(`  [${i}] ${keys}  → serial=${serial}`);
}
// ersten Nicht-null-Eintrag komplett zeigen (gekürzt)
if (nonNull.length) {
  const s = JSON.stringify(nonNull[0][1]);
  console.log(`\nErster Eintrag (${s.length} Zeichen):`);
  console.log(s.slice(0, 1500));
}
fs.writeFileSync('tanklistdetails-decoded.json', JSON.stringify(json, null, 1));
console.log('\n→ tanklistdetails-decoded.json geschrieben');
