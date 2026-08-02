// Isolierte Tests des Salinity-Guardian-Parsers (51-B-Layout), der Umrechnungen
// und der Kalibrier-Payloads, OHNE einen Server zu starten. Aufruf:
//   node reef-salinity-test.mjs
// (Muster reef-autolevel-test.mjs — das Modul reef-salinity.mjs ist seitenfrei.)
import {
  parseSgSettings51, sgConductivity25, sgSalinityPpt, sgDensityRel,
  sgCalibrateTempPayload, SG_CALIBRATE_MAIN_PAYLOAD,
} from './reef-salinity.mjs';

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
function checkClose(label, actual, expected, tol) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`      erwartet: ${expected} ± ${tol}`);
    console.log(`      erhalten: ${actual}`);
    failures++;
  }
}

// Echter Capture-Frame (51-B-Payload von sgRefresh/settings, RFSG012401300020)
const CAPTURE = '000883b0000007c830000864700005302000057e40000027ef000028030000280e0000282202000003efd00000011b3affffe0';
const pl = Buffer.from(CAPTURE, 'hex');
check('Fixture ist 51 B', pl.length, 51);

// --- 1) 51-B-Layout: Rohwerte ---
const st = parseSgSettings51(pl);
check('Parser akzeptiert 51 B', st !== null, true);
checkClose('temperatureC ≈ 25,8 °C', st.temperatureC, 25.8, 0.05);
checkClose('conductivityMs ≈ 55,7–55,8 mS/cm (roh)', st.conductivityMs, 55.7488, 0.1);
check('Einheit-Index 0 (Leitfähigkeit)', st.unit, 0);
check('Temp-Einheit 0 (°C)', st.tempUnit, 0);
check('Alarm-Paar mS/cm = 51,0/55,0', st.alarms.msCm, [51, 55]);
check('Alarm-Paar ppt = 34,0/36,0', st.alarms.ppt, [34, 36]);
checkClose('rawH ≈ 7,25 (roh, uninterpretiert)', st.rawH, 7.25, 0.01);
checkClose('tempOffsetC ≈ 0 °C', st.tempOffsetC, 0, 0.01);
// d1/d2: beide Paare auf derselben ~1,02-Skala, Zuordnung unklar → nur Roh-Durchreichung prüfen
check('Alarm-Paare d1/d2 roh vorhanden',
  [st.alarms.d1.length, st.alarms.d2.length], [2, 2]);

// --- 2) Umrechnungen (Konstanten 1:1 aus dem Geräte-JS) ---
checkClose('conductivity25 ≈ 54,9 mS/cm', st.conductivityMs25, 54.9, 0.1);
// ACHTUNG: Die exakt portierte PSS-78-Formel (Verifikation gegen das
// Geräte-JS) liefert für diese Fixture (F = 55,8 mS/cm roh, t = 25,8 °C)
// 36,4 ppt — das Gerät selbst würde 36,4 anzeigen. 35,3 ppt wäre bei 25,8 °C
// erst ab ~54,3 mS/cm zu erwarten; der Wert 35,3 stammt mutmaßlich aus einem
// Live-Moment mit höherer Temperatur (Formel: dS/dt ≈ −0,75 ppt/°C bei
// konstanter Roh-Leitfähigkeit).
checkClose('salinityPpt = 36,4 (exakte PSS-78-Portierung)', st.salinityPpt, 36.4, 0.15);
checkClose('densityRel ≈ 1,024 (relative Dichte, ≈kg/L)', st.densityRel, 1.0242, 0.001);

// Referenzrechnung gegen die Einzelfunktionen (Gerät rechnet mit ROHEM F)
checkClose('sgSalinityPpt roh: F=55,7488 / t=25,8',
  sgSalinityPpt(55.7488, 25.8), 36.354, 0.01);
checkClose('sgConductivity25: F=55,8 / t=25,8',
  sgConductivity25(55.8, 25.8), 54.939, 0.01);
checkClose('sgDensityRel: s=35 / t=25 (Referenzmeerwasser)',
  sgDensityRel(35, 25), 1.0233, 0.001);

// --- 3) Längen-Gate: nur exakt 51 B parsen (4-B-Altvariante bleibt im
// Server-Zweig daneben bestehen und wird hier nicht angetastet) ---
check('4-B-Payload → null (Altvariante, anderer Zweig)',
  parseSgSettings51(Buffer.from('0000088b', 'hex')), null);
check('7-B-Payload (alert) → null (wird still akzeptiert, kein State)',
  parseSgSettings51(Buffer.alloc(7)), null);

// --- 4) Kalibrier-Payloads (Geräte-JS: s32BE = Math.round(°C × 10000)) ---
const ct = sgCalibrateTempPayload(25.5);
check('calibrateTemp: 4 Bytes', ct.length, 4);
check('calibrateTemp: 25,5 °C → s32BE 255000',
  Buffer.from(ct).readInt32BE(0), 255000);
check('calibrateTemp: negativ → s32BE −15000',
  Buffer.from(sgCalibrateTempPayload(-1.5)).readInt32BE(0), -15000);
check('calibrateMain: [0x00]', SG_CALIBRATE_MAIN_PAYLOAD, [0]);

console.log(failures ? `\n${failures} Test(s) FEHLGESCHLAGEN` : '\nAlle Salinity-Tests bestanden');
process.exit(failures ? 1 : 0);
