// Round-trip-Test: Dump 0020 parsen → regenerieren → Byte-Vergleich mit Original.
import fs from 'node:fs';
import { parseTankListPayload, generateTankListPayload } from './tanklist-lib.mjs';

const buf = fs.readFileSync('dumps/0020_CLOUD_APP_refresh_tankList_0000000000000000.bin');
const readZ = (b, o) => { const e = b.indexOf(0, o); return e + 1; };
const o4 = [0, 0, 0, 0].reduce((o) => readZ(buf, o), 0);
const payload = buf.subarray(o4);

const model = parseTankListPayload(payload);
console.log(`Geparst: ${model.tanks.length} Tank(s), ${model.tanks[0].devices.length} Geräte, Trailer ${model.trailer.length} B`);
console.log(`Tank: icon="${model.tanks[0].icon}" name="${model.tanks[0].name}" dbId=${model.tanks[0].tankDbId}`);
for (const d of model.tanks[0].devices) {
  console.log(`  ${d.serial} online=${d.online} cap="${d.capCode}" unk1=${d.unk1} rowId=${d.rowId} name="${d.name}"`);
}

const regen = generateTankListPayload(model);
console.log(`\nOriginal: ${payload.length} B, Regeneriert: ${regen.length} B`);
if (regen.equals(payload)) {
  console.log('✅ ROUND-TRIP BYTE-IDENTISCH');
} else {
  console.log('❌ Abweichung:');
  const n = Math.min(regen.length, payload.length);
  let diffs = 0;
  for (let i = 0; i < n && diffs < 10; i++) {
    if (regen[i] !== payload[i]) {
      console.log(`  @0x${i.toString(16)}: orig=${payload[i].toString(16)} regen=${regen[i].toString(16)}`);
      diffs++;
    }
  }
  if (regen.length !== payload.length) console.log(`  Länge differiert: ${payload.length} vs ${regen.length}`);
}

// Varianten-Test: Online-Flags live setzen (Pumpe + SW20 online, Rest offline), Padding kürzen
const online = new Set(['RFBP052311290012', 'RFSW202312160013']);
const variant = generateTankListPayload(model, { onlineSerials: online });
console.log(`\nVariante (online-Flags live): ${variant.length} B — Online-Bytes:`);
for (const d of model.tanks[0].devices) {
  const idx = variant.indexOf(Buffer.from(d.serial, 'latin1'));
  if (idx >= 0) console.log(`  ${d.serial} → online=${variant[idx + 16]}`);
}
