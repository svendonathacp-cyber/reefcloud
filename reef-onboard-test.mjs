// Isolierte Tests der Onboard-Parser und Befehls-Payloads (reef-onboard.mjs),
// OHNE einen Server zu starten. Synthetische Frames exakt nach den Byte-Layouts
// aus dem Geräte-JS der Onboard-Webinterfaces. Aufruf:
//   node reef-onboard-test.mjs
import {
  LK_STATUS_TEXT,
  parseLkSettingsExtra, parseLkStatusExtra, parseLkAlert, parseLkManualRefill,
  parseLkCircuit, parseLkCalibration, parseLkTemporary,
  parseRfManualTime, parseRfManualData, parseRfOffData, parseRfPresetList,
  rfManualTimePayload, rfManualUpdatePayload, writeUtf16be, u32be,
} from './reef-onboard.mjs';

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
// 1) lkRefresh/settings — 34-B-Frame (Basis 25 B + fw>=0.6.4 + fw>=0.6.5)
// =====================================================================
// [0]=3 Modus  [1]=7 Statuscode  [2-5]=500 (verworfen)  [6]=15 Tag  [7]=8 Monat
// [8-9]=2025 Jahr  [10]=1 fällig  [11-14]=1234 ml  [15]=25 Kal.-Countdown
// [16]=30 Kreislauf-Countdown  [17-20]=150 ml dosiert  [21-24]=500 ml Soll
// [25-28]=600 s maxRefill  [29-32]=900 s Temp-Off  [33]=1 Beleuchtung
const settings = Buffer.alloc(34);
settings[0] = 3;
settings[1] = 7;
settings.writeUInt32BE(500, 2);
settings[6] = 15; settings[7] = 8; settings.writeUInt16BE(2025, 8);
settings[10] = 1;
settings.writeUInt32BE(1234, 11);
settings[15] = 25; settings[16] = 30;
settings.writeUInt32BE(150, 17);
settings.writeUInt32BE(500, 21);
settings.writeUInt32BE(600, 25);
settings.writeUInt32BE(900, 29);
settings[33] = 1;

const se = parseLkSettingsExtra(settings);
check('lk settings: Parser akzeptiert 34 B', se !== null, true);
check('lk settings: Statuscode aus Byte 1', se.statusCodeSettings, 7);
check('lk settings: Kalibrierdatum', se.calibrationDate, { day: 15, month: 8, year: 2025 });
check('lk settings: Kalibrierung fällig', se.calibrationDue, true);
check('lk settings: todayMl (u32BE @11)', se.todayMlSettings, 1234);
check('lk settings: Kalibrier-Countdown', se.calibrationCountdownS, 25);
check('lk settings: Kreislauf-Countdown', se.circuitCountdownS, 30);
check('lk settings: manueller Refill Ist/Soll',
  [se.manualRefillDoneMl, se.manualRefillTargetMl], [150, 500]);
check('lk settings: Temporary-Off Rest (u32BE @29)', se.temporaryOffRestS, 900);

// 25-B-Basis-Frame (fw < 0.6.4): ohne temporaryOffRestS
const se25 = parseLkSettingsExtra(settings.subarray(0, 25));
check('lk settings: 25 B ok, kein temporaryOffRestS',
  [se25 !== null, 'temporaryOffRestS' in (se25 || {})], [true, false]);
check('lk settings: zu kurz → null', parseLkSettingsExtra(Buffer.alloc(10)), null);

// =====================================================================
// 2) lkRefresh/status — 9-B-Frame, beide todayMl-Kandidaten
// =====================================================================
// [0]=1 Statuscode  [1-4] u32BE 256 ml  [5-8] u32BE 60 s Rest
const status = Buffer.alloc(9);
status[0] = 1;
status.writeUInt32BE(256, 1);
status.writeUInt32BE(60, 5);

const st = parseLkStatusExtra(status);
check('lk status: Parser akzeptiert 9 B', st !== null, true);
check('lk status: todayMlBe (u32BE @1)', st.todayMlBe, 256);
check('lk status: refillRestS (u32BE @5)', st.refillRestS, 60);
// Endianness-Bruch dokumentieren: die live-verifizierte Server-Lesart
// (u32LE @4) liefert auf diesem JS-konformen Frame einen anderen Wert —
// genau deshalb bleiben beide Kandidaten parallel im State.
check('lk status: LE@4-Lesart weicht ab (Bruch sichtbar)',
  status.readUInt32LE(4) !== st.todayMlBe, true);
check('lk status: zu kurz → null', parseLkStatusExtra(Buffer.alloc(5)), null);

// Statuscode-Mapping (additiv erweitert)
check('lk Statuscode 2 = manualRefill', LK_STATUS_TEXT[2], 'manualRefill');
check('lk Statuscode 3 = circuit', LK_STATUS_TEXT[3], 'circuit');
check('lk Statuscode 4 = calibration', LK_STATUS_TEXT[4], 'calibration');
check('lk Statuscode 7 = temporaryOff', LK_STATUS_TEXT[7], 'temporaryOff');
check('lk Statuscode 0/1/5/6 unverändert',
  [LK_STATUS_TEXT[0], LK_STATUS_TEXT[1], LK_STATUS_TEXT[5], LK_STATUS_TEXT[6]],
  ['normal', 'filling', 'high', 'low']);

// =====================================================================
// 3) lkRefresh alert / manualRefill / circuit / calibration / temporary
// =====================================================================
check('lk alert: 1 → fällig', parseLkAlert(Buffer.from([1])), { calibrationDue: true });
check('lk alert: 0 → ok', parseLkAlert(Buffer.from([0])), { calibrationDue: false });

const mr = Buffer.alloc(8);
mr.writeUInt32BE(75, 0); mr.writeUInt32BE(250, 4);
check('lk manualRefill: Ist/Soll', parseLkManualRefill(mr),
  { manualRefillDoneMl: 75, manualRefillTargetMl: 250 });

check('lk circuit: Countdown', parseLkCircuit(Buffer.from([42])), { circuitCountdownS: 42 });
check('lk calibration: Countdown', parseLkCalibration(Buffer.from([10])), { calibrationCountdownS: 10 });

const tmp = Buffer.alloc(4); tmp.writeUInt32BE(1800, 0);
check('lk temporary: Restsekunden', parseLkTemporary(tmp), { temporaryOffRestS: 1800 });
// Leerer/NUL-only-Payload = „Temporary-Off aus" (Geräte-JS §1.10) → Restwert 0,
// damit ein alter Countdown-Badge in der UI verschwindet
check('lk temporary: leeres Frame → aus', parseLkTemporary(Buffer.alloc(0)), { temporaryOffRestS: 0 });
check('lk temporary: NUL-only Frame → aus', parseLkTemporary(Buffer.from([0])), { temporaryOffRestS: 0 });
check('lk temporary: 2–3 B (ungültig) → null', parseLkTemporary(Buffer.from([0, 5])), null);

// =====================================================================
// 4) rfRefresh/manualData — 2 Presets (UTF-16BE-Namen, Kanäle, Intensität)
// =====================================================================
// [0]=55 °C  [1]=0x02 (Power-Size 2)  [2-3]=300 s  [4]=2 Presets
// P1 "Tag" (selected, 10..70 %, Intensität 80) / P2 "Nacht" (0,0,0,0,0,5,10, 100 %)
const manualData = Buffer.from([
  55, 0x02, 0x01, 0x2c, 2,
  ...writeUtf16be('Tag'), 1, 10, 20, 30, 40, 50, 60, 70,
  ...writeUtf16be('Nacht'), 0, 0, 0, 0, 0, 0, 5, 10,
  80, 100,
]);
const md = parseRfManualData(manualData);
check('rf manualData: Parser ok', md !== null, true);
check('rf manualData: Temperatur + Power-Size', [md.ledTempC, md.powerSize], [55, 2]);
check('rf manualData: Timer 300 s', md.manualTimerS, 300);
check('rf manualData: 2 Presets', md.manualPresets.length, 2);
check('rf manualData: Namen UTF-16BE',
  [md.manualPresets[0].name, md.manualPresets[1].name], ['Tag', 'Nacht']);
check('rf manualData: Selected-Flags',
  [md.manualPresets[0].selected, md.manualPresets[1].selected], [true, false]);
check('rf manualData: Kanäle P1', md.manualPresets[0].channels, [10, 20, 30, 40, 50, 60, 70]);
check('rf manualData: Intensitäten', [md.manualPresets[0].intensity, md.manualPresets[1].intensity], [80, 100]);
check('rf manualData: channelsManual = aktives Preset', md.channelsManual, [10, 20, 30, 40, 50, 60, 70]);
check('rf manualData: manualIntensity', md.manualIntensity, 80);
check('rf manualData: selectedIndex', md.manualSelectedPreset, 0);

// Ohne Intensitäts-Bytes (fw <= 0.6.9): intensity null
const mdNoInt = parseRfManualData(manualData.subarray(0, manualData.length - 2));
check('rf manualData: ohne Intensität → null',
  [mdNoInt.manualPresets[0].intensity, mdNoInt.manualPresets[1].intensity], [null, null]);

// Kein Selected-Flag → erstes Preset gilt (Geräte-JS-Verhalten)
const mdNoSel = Buffer.from([
  40, 0x01, 0xff, 0xff, 1,
  ...writeUtf16be('Solo'), 0, 1, 2, 3, 4, 5, 6, 7,
  90,
]);
const mds = parseRfManualData(mdNoSel);
check('rf manualData: 0xFFFF-Timer → null (Always)', mds.manualTimerS, null);
check('rf manualData: kein Selected → erstes Preset',
  [mds.channelsManual, mds.manualIntensity], [[1, 2, 3, 4, 5, 6, 7], 90]);

// =====================================================================
// 5) rfRefresh/manualTime + offData
// =====================================================================
check('rf manualTime: 0xFFFF → null (Always)', parseRfManualTime(Buffer.from([0xff, 0xff])), { manualTimerS: null });
check('rf manualTime: 600 s', parseRfManualTime(Buffer.from([0x02, 0x58])), { manualTimerS: 600 });
check('rf offData: temp + powerSize', parseRfOffData(Buffer.from([48, 0x01])), { ledTempC: 48, powerSize: 1 });
check('rf offData: zu kurz → null', parseRfOffData(Buffer.from([48])), null);

// =====================================================================
// 6) Befehls-Payloads
// =====================================================================
check('rfManual/time: 300 s → u16BE', rfManualTimePayload(300), [0x01, 0x2c]);
check('rfManual/time: always → 0xFFFF', rfManualTimePayload('always'), [0xff, 0xff]);
check('rfManual/time: null → 0xFFFF', rfManualTimePayload(null), [0xff, 0xff]);

// rfManual/update-Roundtrip: Payload bauen und mit dem Preset-Parser wieder lesen
const presets = [
  { name: 'Tag', selected: true, channels: [10, 20, 30, 40, 50, 60, 70], intensity: 80 },
  { name: 'Nacht', selected: false, channels: [0, 0, 0, 0, 0, 5, 10], intensity: 100 },
];
const up = Buffer.from(rfManualUpdatePayload(presets));
check('rfManual/update: count-Byte', up[0], 2);
const rt = parseRfPresetList(up, 0);
check('rfManual/update: Roundtrip Namen',
  [rt.presets[0].name, rt.presets[1].name], ['Tag', 'Nacht']);
check('rfManual/update: Roundtrip Selected',
  [rt.presets[0].selected, rt.presets[1].selected], [true, false]);
check('rfManual/update: Roundtrip Kanäle', rt.presets[0].channels, [10, 20, 30, 40, 50, 60, 70]);
check('rfManual/update: Roundtrip Intensitäten',
  [rt.presets[0].intensity, rt.presets[1].intensity], [80, 100]);

// Klemmung: Kanäle > 100 / < 0 werden auf 0–100 begrenzt, Name auf 16 Zeichen
const clamped = parseRfPresetList(Buffer.from(rfManualUpdatePayload([
  { name: 'DieserNameIstVielZuLang', selected: true, channels: [-5, 250, 0, 0, 0, 0, 0], intensity: 120 },
])), 0);
check('rfManual/update: Name auf 16 Zeichen gekürzt', clamped.presets[0].name, 'DieserNameIstVie');
check('rfManual/update: Kanäle geklemmt', clamped.presets[0].channels.slice(0, 2), [0, 100]);
check('rfManual/update: Intensität geklemmt', clamped.presets[0].intensity, 100);

// u32be-Baustein (lkSet/maxRefillTime, lkCalibration/value, lkManualRefill/start …)
check('u32be: 600 s', u32be(600), [0, 0, 2, 88]);
check('u32be: 100000 ml', u32be(100000), [0, 1, 134, 160]);

console.log(failures ? `\n${failures} Test(s) FEHLGESCHLAGEN` : '\nAlle Onboard-Tests bestanden');
process.exit(failures ? 1 : 0);
