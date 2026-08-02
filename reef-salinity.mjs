// Salinity Guardian (RFSG…, Altgerät mit Binärprotokoll): Parser für das
// 51-Byte-Layout von sgRefresh/settings, die Umrechnungen (Leitfähigkeit@25 °C,
// Salinität PSS-78, Dichte) und die Payloads der Kalibrier-Befehle.
//
// Layout (Live-Capture, Serial RFSG012401300020) — alle Integer Big-Endian,
// alle Float-Skalierungen Divisor 10000 (Geräte-JS: U = 1/1e4):
//   u32BE(0)/1e4                Leitfähigkeit roh, mS/cm bei Messtemperatur
//   u8(4)                       Einheit-Index (0 = Leitfähigkeit mS/cm)
//   u32BE(5)/1e4, u32BE(9)/1e4    Alarm-Paar mS/cm (R/N — Reihenfolge unklar)
//   u32BE(13)/1e4, u32BE(17)/1e4  Alarm-Paar ppt
//   u32BE(21)/1e4, u32BE(25)/1e4  Alarm-Paar d1 (Skala ~1,02, Zuordnung unklar → roh)
//   u32BE(29)/1e4, u32BE(33)/1e4  Alarm-Paar d2 (Skala ~1,02, Zuordnung unklar → roh)
//   u8(37), u8(38)              unbekannt (in der Capture-Fixture: 0x02, 0x00) — ignoriert
//   u32BE(39)/1e4               Temperatur °C
//   u8(43)                      Temp-Einheit (0 = °C)
//   u32BE(44)/1e4               unbekannter Wert h (~7,25, evtl. Kalibrierfaktor) → roh
//   i24BE(48)/1e4               Temp-Kalibrier-Offset °C
//
// Die Umrechnungen sind 1:1 aus dem Geräte-JS der Onboard-Seite portiert
// (Konstanten unverändert). Das Gerät rechnet die Salinität aus der ROHEN
// Leitfähigkeit (nicht temperaturkompensiert!) und rundet die Anzeige auf
// 0,1 ppt — wir speichern denselben gerundeten Wert, damit UI und Gerät
// übereinstimmen. Die Dichte rechnet das Gerät aus der gerundeten Salinität.

// Leitfähigkeit kompensiert auf 25 °C (Geräte-JS: calculateConductivity)
export function sgConductivity25(F, I) {
  return F / (1 + 0.0196 * (I - 25));
}

// Salinität nach PSS-78 (Geräte-JS: calculateSalinity). e = F ROH, t = °C.
export function sgSalinityPpt(F, t) {
  const o = .6766097 + t * (.0200564 + t * (.0001104259 + t * (1.0031e-9 * t - 6.9698e-7)));
  const i = Math.sqrt(1e3 * F / 42914 / o);
  return .008 + i * (i * (25.3851 + i * (14.0941 + i * (2.7081 * i - 7.0261))) - .1692)
    + (5e-4 + i * (i * (i * (i * (.0636 - .0144 * i) - .0375) - .0066) - .0056))
    * ((t - 15) / (1 + .0162 * (t - 15)));
}

// Relative Dichte (≈ kg/L, z. B. 1,0242 — NICHT kg/m³!) aus Salinität s (ppt)
// und Temperatur t (°C) (Geräte-JS: calculateDensity, dort /1e3 am Ende)
export function sgDensityRel(s, t) {
  return (1e3 * (1 - (t + 288.9414) / (508929.2 * (t + 68.12963)) * Math.pow(t - 3.9863, 2))
    + (.824493 - .0040899 * t + 76438e-9 * t ** 2 - 8.2467e-7 * t ** 3 + 5.3675e-9 * t ** 4) * s
    + (10227e-8 * t - .005724 - 16546e-10 * t ** 2) * s ** 1.5
    + 48314e-8 * s ** 2) / 1e3;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// 51-B-Payload von sgRefresh/settings → State-Patch (null bei falscher Länge)
export function parseSgSettings51(pl) {
  if (!pl || pl.length !== 51) return null;
  const u = (o) => pl.readUInt32BE(o) / 10000;
  const F = u(0);        // Leitfähigkeit roh (mS/cm)
  const tC = u(39);      // Temperatur °C
  const salinityPpt = Math.round(10 * sgSalinityPpt(F, tC)) / 10; // Rundung wie im Gerät
  return {
    conductivityMs: r4(F),
    unit: pl[4],
    // Alarm-Paare je Einheit roh durchgereicht (R = unterer / N = oberer
    // Grenzwert oder umgekehrt — Zuordnung nicht verifiziert, daher NICHT
    // interpretiert). d1/d2 liegen beide auf derselben ~1,02-Skala (vermutlich
    // Dichte-bezogen) — die Unterscheidung „kg/m³" vs „Dichte" ist mutmaßlich
    // künstlich, daher neutrale Keys ohne Einheitenbehauptung.
    alarms: {
      msCm: [r4(u(5)), r4(u(9))],
      ppt: [r4(u(13)), r4(u(17))],
      d1: [r4(u(21)), r4(u(25))],
      d2: [r4(u(29)), r4(u(33))],
    },
    temperatureC: r4(tC),
    tempUnit: pl[43],
    rawH: r4(u(44)),                          // unbekannt (~7,25) — nicht interpretieren
    tempOffsetC: r4(pl.readIntBE(48, 3) / 10000),
    conductivityMs25: r2(sgConductivity25(F, tC)),
    salinityPpt,
    // relative Dichte (≈ kg/L, 1,02x), NICHT kg/m³ — Geräte-JS-Skala
    densityRel: r4(sgDensityRel(salinityPpt, tC)),
  };
}

// sgSet/calibrationTemperature: s32BE = Math.round(Referenz-°C × 10000) (Geräte-JS)
export function sgCalibrateTempPayload(tempC) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(Number(tempC) * 10000), 0);
  return [...b];
}

// sgSet/calibrationMain: 1 Byte 0x00 (Geräte-JS: Uint8Array mit e[0]=0)
export const SG_CALIBRATE_MAIN_PAYLOAD = [0x00];
