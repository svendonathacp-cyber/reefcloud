// Isolierte Tests des Dosing-Parsers und der Befehls-Payloads (reef-doser.mjs),
// OHNE einen Server zu starten. Synthetische Frames exakt nach den Byte-Layouts
// aus dem RE-Report (report-dz.md, Onboard-JS RfDz01Main). Erwartungswerte =
// die live-verifizierten Anker der Serial RFDZ012302130061. Aufruf:
//   node reef-doser-test.mjs
import {
  DZ_MODE, parseDzSettings, parseDzStatus, parseDzAlert, parseDzDose,
  parseDzRefresh, dzRemainingDays, dzFillPercent, ml100,
  dzSetNamePayload, dzSetContainerPayload, dzSetDosesPayload, dzSkipNextPayload,
  dzPumpPayload, dzGetSettingsPayload, dzCalibrateValuePayload,
  dzCalibrateNotifyPayload, dzManualRefillStartPayload,
} from './reef-doser.mjs';
import { writeUtf16be } from './reef-onboard.mjs';

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

// ---------- Frame-Builder (Layout report-dz.md §1.1/§1.2) ----------

// settings-Frame 440 B. ml-Werte werden als Roh-u32 (×100) übergeben.
function settingsFrame(pump, o = {}) {
  const b = Buffer.alloc(440);
  b[0] = pump;
  b.writeUInt32BE(o.fill ?? 0, 1);
  b.writeUInt32BE(o.capacity ?? 0, 5);
  b[9] = o.mode ?? 0;
  b.writeUInt32BE(o.discarded ?? 0, 10);
  b[14] = o.calDay ?? 0; b[15] = o.calMonth ?? 0; b.writeUInt16BE(o.calYear ?? 0, 16);
  b[18] = o.calOverdue ? 1 : 0;
  b.writeUInt32BE(o.today ?? 0, 19);
  b.writeUInt32BE(o.target ?? 0, 23);
  b[27] = o.calCountdown ?? 0; b[28] = o.circuitCountdown ?? 0;
  b.writeUInt32BE(o.refillDone ?? 0, 29); b.writeUInt32BE(o.refillTarget ?? 0, 33);
  b[37] = 24;
  (o.slots ?? []).forEach((s, i) => {
    const off = 38 + i * 7;
    b.writeUInt32BE(s.ml100, off); b.writeUInt16BE(s.minutes, off + 4);
  });
  b[206] = o.autoDoseNr ?? 0;
  b.writeUInt32BE(o.autoDoseDone ?? 0, 207); b.writeUInt32BE(o.autoDoseTarget ?? 0, 211);
  b.writeUInt32BE(o.manualDone ?? 0, 215); b.writeUInt32BE(o.manualTarget ?? 0, 219);
  b[223] = o.dayCounter ?? 0; b[224] = o.manualStatus ?? 0;
  b[225] = 12;
  (o.history ?? []).forEach((h, i) => {
    const off = 226 + i * 15;
    b.writeUInt32BE(h.dose100 ?? 0, off);
    b.writeUInt32BE(h.manual100 ?? 0, off + 4);
    b.writeUInt16BE(h.year, off + 8);
    b[off + 10] = h.month; b[off + 11] = h.day; b[off + 12] = h.hour; b[off + 13] = h.minute;
    b[off + 14] = h.type;
  });
  b[406] = o.mask ?? 0xff;
  b[407] = o.skip ?? 0;
  Buffer.from(writeUtf16be(o.name ?? '')).copy(b, 408, 0, 32);
  return b;
}

// status-Frame 261 B (Offsets korrigiert: heute @[10-13], Ziel @[14-17], nächste Dosis @[18-21])
function statusFrame(pump, o = {}) {
  const b = Buffer.alloc(261);
  b[0] = pump;
  b.writeUInt32BE(o.fill ?? 0, 1);
  b.writeUInt32BE(o.capacity ?? 0, 5);
  b[9] = o.mode ?? 0;
  b.writeUInt32BE(o.today ?? 0, 10);
  b.writeUInt32BE(o.target ?? 0, 14);
  b.writeUInt32BE(o.next ?? 0, 18);
  b.writeUInt32BE(o.refillTarget ?? 0, 22);
  b[26] = o.autoDoseNr ?? 0; b[27] = o.autoDoseTotal ?? 0;
  b.writeUInt32BE(o.autoDoseDone ?? 0, 28); b.writeUInt32BE(o.autoDoseTarget ?? 0, 32);
  b.writeUInt32BE(o.manualDone ?? 0, 36); b.writeUInt32BE(o.manualTarget ?? 0, 40);
  b[44] = o.dayCounter ?? 0; b[45] = o.manualStatus ?? 0;
  b[46] = 12;
  (o.history ?? []).forEach((h, i) => {
    const off = 47 + i * 15;
    b.writeUInt32BE(h.dose100 ?? 0, off);
    b.writeUInt32BE(h.manual100 ?? 0, off + 4);
    b.writeUInt16BE(h.year, off + 8);
    b[off + 10] = h.month; b[off + 11] = h.day; b[off + 12] = h.hour; b[off + 13] = h.minute;
    b[off + 14] = h.type;
  });
  b[227] = o.mask ?? 0xff;
  b[228] = o.skip ?? 0;
  Buffer.from(writeUtf16be(o.name ?? '')).copy(b, 229, 0, 32);
  return b;
}

// =====================================================================
// 1) settings 440 B — Pumpe 1 „KH" (Ankerwerte des Besitzers)
// =====================================================================
const KH_SLOTS = [480, 660, 840, 1020].map((minutes) => ({ ml100: 1340, minutes })); // 4× 13,40 ml
const KH_HISTORY = [
  { dose100: 1335, year: 2026, month: 1, day: 15, hour: 8, minute: 0, type: 1 },  // Auto 13,35 ml
  { dose100: 1340, year: 2026, month: 1, day: 14, hour: 20, minute: 0, type: 1 }, // Auto 13,40 ml
];
const kh = settingsFrame(1, {
  fill: 0, capacity: 500000, mode: 0, // 0,00 ml / 5000,00 ml, idle
  calDay: 13, calMonth: 12, calYear: 2025, calOverdue: true, // 13.12.2025, überfällig
  today: 1335, target: 6000, // heute 13,35 ml / Tagesziel 60,00 ml
  slots: KH_SLOTS, history: KH_HISTORY, name: 'KH',
});
const khParsed = parseDzSettings(kh);
check('settings KH: Parser akzeptiert 440 B', khParsed !== null, true);
const p1 = khParsed.pumps[0];
check('settings KH: genau 1 Pumpe', khParsed.pumps.length, 1);
check('settings KH: index/name', [p1.index, p1.name], [1, 'KH']);
check('settings KH: Füllstand/Kapazität', [p1.fillMl, p1.capacityMl], [0, 5000]);
check('settings KH: Modus idle', p1.mode, DZ_MODE.idle);
check('settings KH: heute/Tagesziel', [p1.todayMl, p1.targetMl], [13.35, 60]);
check('settings KH: Kalibrierdatum 13.12.2025', p1.calDate, { day: 13, month: 12, year: 2025 });
check('settings KH: Kalibrierung überfällig', p1.calOverdue, true);
check('settings KH: 24 Zeitplan-Slots', p1.schedule.length, 24);
check('settings KH: Slot 0 = 13,40 ml @ 08:00', p1.schedule[0], { ml: 13.4, minutes: 480 });
check('settings KH: Slot 3 = 13,40 ml @ 17:00', p1.schedule[3], { ml: 13.4, minutes: 1020 });
check('settings KH: freier Slot = 0 ml', p1.schedule[4], { ml: 0, minutes: 0 });
check('settings KH: History 2 Einträge', p1.history.length, 2);
check('settings KH: History[0] Auto-Dosis 13,35 ml',
  [p1.history[0].doseMl, p1.history[0].manualMl, p1.history[0].type], [13.35, 0, 1]);
check('settings KH: History[0] ts aus Gerätefeldern',
  p1.history[0].ts, new Date(2026, 0, 15, 8, 0, 0).getTime());
check('settings KH: Wochentag-Maske alle Tage', p1.weekdayMask, 0x7f);
check('settings KH: Automatik aktiv (bit7)', p1.autoActive, true);
check('settings KH: Skip-Wert 0', p1.skipValue, 0);

// =====================================================================
// 2) settings 440 B — Pumpe 3 „MG" (Anker: 2375,13 ml, Ziel 3,00 ml → 792 Tage)
// =====================================================================
const mg = settingsFrame(3, {
  fill: 237513, capacity: 500000, mode: 0, // 2375,13 ml / 5000,00 ml
  calDay: 1, calMonth: 3, calYear: 2026, calOverdue: false,
  today: 0, target: 300, // Tagesziel 3,00 ml
  name: 'MG',
});
const p3 = parseDzSettings(mg).pumps[0];
check('settings MG: index/name', [p3.index, p3.name], [3, 'MG']);
check('settings MG: Füllstand 2375,13 ml', p3.fillMl, 2375.13);
check('settings MG: Tagesziel 3,00 ml', p3.targetMl, 3);
check('settings MG: Kalibrierung nicht überfällig', p3.calOverdue, false);

// Abgeleitete Werte (Geräte-JS-Formeln §3 des Reports)
check('MG: Restzeit round(2375,13/3,00) = 792 Tage', dzRemainingDays(p3.fillMl, p3.targetMl), 792);
check('MG: Füllstand % = 100×2375,13/5000', dzFillPercent(p3.fillMl, p3.capacityMl), 47.5026);
check('KH: Restzeit 0 Tage bei leerem Behälter', dzRemainingDays(p1.fillMl, p1.targetMl), 0);
check('Restzeit null ohne Tagesziel', dzRemainingDays(100, 0), null);
check('Füllstand null ohne Kapazität', dzFillPercent(100, 0), null);

// =====================================================================
// 3) Broadcast-Frame (Pumpe 0): 1 B 0x00 + 4×439 B = 1757 B
// =====================================================================
const ca = settingsFrame(2, { fill: 100000, capacity: 500000, target: 500, name: 'CA' });
const jod = settingsFrame(4, { fill: 25000, capacity: 500000, target: 100, name: 'Jod' });
const broadcast = Buffer.concat([
  Buffer.from([0]),
  kh.subarray(1), ca.subarray(1), mg.subarray(1), jod.subarray(1),
]);
check('Broadcast: Länge 1757 B', broadcast.length, 1757);
const bc = parseDzSettings(broadcast);
check('Broadcast: 4 Pumpen', bc.pumps.length, 4);
check('Broadcast: Pumpen-Reihenfolge 1..4', bc.pumps.map((p) => p.index), [1, 2, 3, 4]);
check('Broadcast: Namen UTF-16BE je Record',
  bc.pumps.map((p) => p.name), ['KH', 'CA', 'MG', 'Jod']);
check('Broadcast: MG-Füllstand 2375,13 ml', bc.pumps[2].fillMl, 2375.13);
check('Broadcast: KH-Kalibrierdatum bleibt lesbar', bc.pumps[0].calDate, { day: 13, month: 12, year: 2025 });
check('Broadcast: KH-Zeitplan Slot 0', bc.pumps[0].schedule[0], { ml: 13.4, minutes: 480 });

// =====================================================================
// 4) status 261 B — korrigierte Offsets (heute @[10-13], Ziel @[14-17], nächste @[18-21])
// =====================================================================
const st = statusFrame(1, {
  fill: 0, capacity: 500000, today: 1335, target: 6000, next: 1340,
  history: KH_HISTORY, name: 'KH',
});
const s1 = parseDzStatus(st);
check('status: Parser akzeptiert 261 B', s1 !== null, true);
check('status: heute 13,35 ml @[10-13]', s1.todayMl, 13.35);
check('status: Tagesziel 60,00 ml @[14-17]', s1.targetMl, 60);
check('status: nächste Dosis 13,40 ml @[18-21]', s1.nextDoseMl, 13.4);
check('status: Name KH @[229-260]', s1.name, 'KH');
check('status: Wochentag-Maske/Automatik @[227]', [s1.weekdayMask, s1.autoActive], [0x7f, true]);
check('status: History ab @[47]', s1.history.length, 2);
// Offset-Verifikation: mit der früheren (falschen) Vermutung +1 Byte lägen
// die Werte versetzt — die korrigierten Offsets liefern exakt die Anker.
check('status: Versetzungs-Probe (Byte 13/17/21 = Low-Bytes der Anker)',
  [st[13], st[17], st[21]], [0x37, 0x70, 0x3c]);

// =====================================================================
// 5) dose 5 B / alert 44 B / Kurz-Events
// =====================================================================
const dose = Buffer.alloc(5);
dose[0] = 1; dose.writeUInt32BE(1335, 1);
const d1 = parseDzRefresh('dose', dose, 1700000000000);
check('dose: Pumpe 1, 13,35 ml', [d1.pumps[0].index, d1.pumps[0].lastDoseMl], [1, 13.35]);
check('dose: Zeitstempel durchgereicht', d1.pumps[0].lastDoseTs, 1700000000000);

const alertBuf = Buffer.alloc(44);
alertBuf[0] = 1; alertBuf[1] = 1;
check('alert: Kalibrier-Flag 1 → überfällig', parseDzAlert(alertBuf), { index: 1, calOverdue: true });
alertBuf[1] = 0;
check('alert: Flag 0 → ok', parseDzAlert(alertBuf), { index: 1, calOverdue: false });

const mr = Buffer.alloc(9);
mr[0] = 2; mr.writeUInt32BE(7500, 1); mr.writeUInt32BE(15000, 4 + 1);
const mrP = parseDzRefresh('manualRefill', mr).pumps[0];
check('manualRefill: Modus 2, Ist/Soll',
  [mrP.mode, mrP.refillDoneMl, mrP.refillTargetMl], [DZ_MODE.manualRefill, 75, 150]);

check('calibration: Modus 4 + Countdown',
  parseDzRefresh('calibration', Buffer.from([3, 42])).pumps[0],
  { index: 3, mode: DZ_MODE.calibration, calCountdownS: 42 });
check('circuit: Modus 3 + Countdown',
  parseDzRefresh('circuit', Buffer.from([3, 17])).pumps[0],
  { index: 3, mode: DZ_MODE.circuit, circuitCountdownS: 17 });
check('manualRefillStop: idle + Refill-Felder zurückgesetzt',
  parseDzRefresh('manualRefillStop', Buffer.from([2])).pumps[0],
  { index: 2, mode: DZ_MODE.idle, refillDoneMl: 0, refillTargetMl: 0, manualStatus: 0 });
check('calibrationStop: idle + Countdown 0',
  parseDzRefresh('calibrationStop', Buffer.from([1])).pumps[0],
  { index: 1, mode: DZ_MODE.idle, calCountdownS: 0 });
check('circuitStop: idle + Countdown 0',
  parseDzRefresh('circuitStop', Buffer.from([4])).pumps[0],
  { index: 4, mode: DZ_MODE.idle, circuitCountdownS: 0 });

// =====================================================================
// 6) Längen-Gates / Robustheit — keine Out-of-bounds-Reads
// =====================================================================
check('settings: 439 B → null', parseDzSettings(kh.subarray(0, 439)), null);
check('settings: 441 B → null', parseDzSettings(Buffer.concat([kh, Buffer.from([0])])), null);
check('settings: Broadcast mit Pumpe != 0 → null',
  parseDzSettings(Buffer.concat([Buffer.from([1]), kh.subarray(1), ca.subarray(1), mg.subarray(1), jod.subarray(1)])), null);
check('settings: Pumpen-Nr. 5 → null', parseDzSettings(settingsFrame(5)), null);
check('status: 260 B → null', parseDzStatus(st.subarray(0, 260)), null);
check('dose: 4 B → null', parseDzDose(dose.subarray(0, 4)), null);
check('alert: 1 B → null', parseDzAlert(Buffer.from([1])), null);
check('alert: 2 B (zu kurz, spezifiziert sind 44 B) → null', parseDzAlert(Buffer.from([1, 1])), null);
check('alert: 43 B → null', parseDzAlert(alertBuf.subarray(0, 43)), null);
check('unbekannte Methode → null', parseDzRefresh('preciseData', kh), null);
check('null-Payload → null', parseDzRefresh('settings', null), null);

// =====================================================================
// 7) Befehls-Payloads (Byte-exakt nach Report §2)
// =====================================================================
check('dzSet/name: [pump][UTF-16BE][00 00]',
  dzSetNamePayload(1, 'KH'), [1, 0, 0x4b, 0, 0x48, 0, 0]);
check('dzSet/container: 0 ml / 5000 ml (9 B)',
  dzSetContainerPayload(1, 0, 5000), [1, 0, 0, 0, 0, 0x00, 0x07, 0xa1, 0x20]);
check('dzSet/doses: 2 Slots + Wochentag-Maske mit bit7',
  dzSetDosesPayload(1, [{ ml: 13.4, minutes: 480 }, { ml: 13.4, minutes: 840 }], 0x7f),
  [1, 2, 0, 0, 0x05, 0x3c, 0x01, 0xe0, 0, 0, 0x05, 0x3c, 0x03, 0x48, 0xff]);
check('dzSet/doses: Maske ohne bit7 im Eingang wird gesetzt',
  dzSetDosesPayload(2, [{ ml: 3, minutes: 0 }], 0x41)[8], 0xc1);
check('dzSet/skipNext: Wert 100', dzSkipNextPayload(1, 100), [1, 100]);
check('dzSet/cancelSkip + Ein-Byte-Payloads', dzPumpPayload(3), [3]);
check('dzGet/settings: alle Pumpen', dzGetSettingsPayload(0), [0]);
check('dzCalibration/value: 100,50 ml → 10050',
  dzCalibrateValuePayload(3, 100.5), [3, 0, 0, 0x27, 0x42]);
check('dzCalibration/notification: Intervall 3', dzCalibrateNotifyPayload(2, 3), [2, 3]);
check('dzManualRefill/start: 50 ml sofort (11 B, Modus 0)',
  dzManualRefillStartPayload(1, 50), [1, 0, 0, 0, 0x13, 0x88, 0, 0, 0, 0, 0]);
check('dzManualRefill/start: verzögert 30 min (Modus 8)',
  dzManualRefillStartPayload(1, 50, 8, 30), [1, 0, 0, 0, 0x13, 0x88, 8, 0, 0, 0, 30]);
check('ml100: 13,40 ml → 1340', ml100(13.4), [0, 0, 0x05, 0x3c]);

// Roundtrip: Name über writeUtf16be in den Frame → Parser liest ihn zurück
check('Name-Roundtrip UTF-16BE (16 Zeichen max)',
  parseDzSettings(settingsFrame(4, { name: 'Jod-Lösung Plus1' })).pumps[0].name, 'Jod-Lösung Plus1');
// Default-Namen bei leerem Namensfeld (Geräte-JS-Verhalten)
check('Leerer Name → Default „Pump B"',
  parseDzSettings(settingsFrame(2, { name: '' })).pumps[0].name, 'Pump B');
// Monats-Normierung der History ((raw-1)%12)+1 wie im Geräte-JS
const h13 = settingsFrame(1, {
  history: [{ dose100: 100, year: 2026, month: 13, day: 1, hour: 0, minute: 0, type: 1 }],
});
check('History: Monat-Rohbyte 13 → Januar (Geräte-JS-Normierung)',
  parseDzSettings(h13).pumps[0].history[0].ts, new Date(2026, 0, 1, 0, 0, 0).getTime());
// History-Typ 0 = freier Slot → übersprungen
const h0 = settingsFrame(1, {
  history: [{ dose100: 100, year: 2026, month: 1, day: 1, hour: 0, minute: 0, type: 0 }],
});
check('History: Typ 0 (frei) wird übersprungen', parseDzSettings(h0).pumps[0].history.length, 0);

console.log(failures ? `\n${failures} Test(s) FEHLGESCHLAGEN` : '\nAlle Doser-Tests bestanden');
process.exit(failures ? 1 : 0);
