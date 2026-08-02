// Onboard-Protokoll der Altgeräte — additive Parser und Befehls-Payloads,
// 1:1 aus dem Geräte-JS der Onboard-Webinterfaces abgeleitet (Reverse-
// Engineering der lokalen Firmware-Generation; Frames: serial\0class\0method\0
// extra\0payload\0, Integer durchgängig Big-Endian).
//
// Abgedeckt:
//   Level Keeper (RFLK): lkRefresh alert/manualRefill/circuit/calibration/
//     temporary + die Zusatzfelder von settings/status, die der Server bisher
//     nicht ausgewertet hat. Die bestehenden, live-verifizierten Keys
//     (mode, calibrationMl, maxRefillRuntimeS, led, statusCode, todayMl u32LE@4,
//     refillRuntimeS u32BE@8) bleiben im Server-Zweig und werden hier NICHT
//     dupliziert — dieses Modul liefert nur die NEUEN Keys.
//   Reef Flare (RFRF): rfRefresh manualTime/manualData/offData der LOKALEN
//     Firmware (7 Kanäle 0–100 %, Preset-Namen UTF-16BE) + die Schreib-Payloads
//     rfManual/update, rfManual/time. preciseData/preciseEdit/dashboardData
//     (Cloud-Protokoll-Variante, anderweitig verifiziert) bleiben unangetastet.
//
// Bekannte, bewusst offene Punkte (Verifikation live):
//   - lkRefresh/status todayMl: Geräte-JS liest u32BE@1, der Server hat
//     u32LE@4 (live-verifiziert in Bridge-Zeit). parseLkStatusExtra liefert
//     die JS-Lesart als Kandidaten-Keys todayMlBe/refillRestS — beide bleiben
//     parallel im State, bis ein Live-Hexframe während aktivem Refill
//     entscheidet.

const u8 = (v) => [Number(v) & 255];

// u32 Big-Endian als Byte-Array (Payload-Baustein)
export function u32be(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(Math.round(Number(v)) >>> 0, 0);
  return [...b];
}

// ---------- Level Keeper (RFLK) ----------

// Statuscodes laut Geräte-JS (status[0] / settings[1]). Additiv zum bisherigen
// Server-Mapping (0/1/5/6): 2 = manueller Refill, 3 = Kreislauf-Befüllung,
// 4 = Kalibrierung, 7 = Temporary-Off.
export const LK_STATUS_TEXT = {
  0: 'normal', 1: 'filling', 2: 'manualRefill', 3: 'circuit',
  4: 'calibration', 5: 'high', 6: 'low', 7: 'temporaryOff',
};

// lkRefresh/settings — NUR die neuen Felder (Geräte-JS-Layout, alle BE):
//   [1]  u8     Statuscode (auch im settings-Frame)
//   [6]  u8     Kalibrierdatum Tag, [7] u8 Monat-Roh ((b-1)%12)+1, [8-9] u16BE Jahr
//   [10] u8     Kalibrierung fällig (0 = OK)
//   [11-14] u32BE heute nachgefüllte ml (auch im settings-Frame)
//   [15] u8     Kalibrier-Countdown (s), [16] u8 Kreislauf-Countdown (s)
//   [17-20] u32BE manueller Refill: bisher dosiert (ml)
//   [21-24] u32BE manueller Refill: Sollmenge (ml)
//   [29-32] u32BE Temporary-Off Restzeit (s) — ab fw 0.6.4 (33 B Mindestlänge)
// Bytes 0 (Modus), 2-5 (verworfen; Server: calibrationMl u16BE@4), 25-28
// (maxRefillRuntimeS) und 33 (led) parst der Server-Zweig bereits — bewusst
// hier ausgelassen.
export function parseLkSettingsExtra(pl) {
  if (!pl || pl.length < 25) return null;
  return {
    statusCodeSettings: pl[1],
    calibrationDate: {
      day: pl[6],
      month: ((pl[7] - 1) % 12) + 1, // Monats-Rohbyte wie im Geräte-JS normiert
      year: pl.readUInt16BE(8),
    },
    calibrationDue: pl[10] !== 0,
    todayMlSettings: pl.readUInt32BE(11),
    calibrationCountdownS: pl[15],
    circuitCountdownS: pl[16],
    manualRefillDoneMl: pl.readUInt32BE(17),
    manualRefillTargetMl: pl.readUInt32BE(21),
    ...(pl.length >= 33 ? { temporaryOffRestS: pl.readUInt32BE(29) } : {}),
  };
}

// lkRefresh/status — Kandidaten-Felder nach dem Geräte-JS (BE-Layout):
//   [1-4] u32BE heute nachgefüllte ml   → todayMlBe
//   [5-8] u32BE Restsekunden Refill     → refillRestS
// ACHTUNG: widerspricht dem live-verifizierten Server-Layout (todayMl u32LE@4,
// refillRuntimeS u32BE@8). Beide Lesarten bleiben im State — Verifikation
// live offen (Hexframe während aktivem Refill nötig).
export function parseLkStatusExtra(pl) {
  if (!pl || pl.length < 9) return null;
  return { todayMlBe: pl.readUInt32BE(1), refillRestS: pl.readUInt32BE(5) };
}

// lkRefresh/alert (1 B): 0 = Kalibrierung OK, !=0 = fällig
// (Push-Äquivalent zu settings-Byte 10)
export function parseLkAlert(pl) {
  if (!pl || pl.length < 1) return null;
  return { calibrationDue: pl[0] !== 0 };
}

// lkRefresh/manualRefill (8 B): [0-3] u32BE dosiert, [4-7] u32BE Soll (ml)
export function parseLkManualRefill(pl) {
  if (!pl || pl.length < 8) return null;
  return { manualRefillDoneMl: pl.readUInt32BE(0), manualRefillTargetMl: pl.readUInt32BE(4) };
}

// lkRefresh/circuit (1 B): Countdown (s) der Kreislauf-Befüllung
export function parseLkCircuit(pl) {
  if (!pl || pl.length < 1) return null;
  return { circuitCountdownS: pl[0] };
}

// lkRefresh/calibration (1 B): Countdown (s) der laufenden Kalibrierung
export function parseLkCalibration(pl) {
  if (!pl || pl.length < 1) return null;
  return { calibrationCountdownS: pl[0] };
}

// lkRefresh/temporary (4 B): u32BE Restsekunden Temporary-Off.
// Leerer bzw. NUL-only-Payload bedeutet „Temporary-Off aus" (Geräte-JS §1.10:
// „0/leer -> aus") — dann muss der Restwert im State auf 0 fallen, sonst
// bleibt ein alter Countdown-Badge stehen.
export function parseLkTemporary(pl) {
  if (!pl) return null;
  if (pl.length === 0 || (pl.length === 1 && pl[0] === 0)) return { temporaryOffRestS: 0 };
  if (pl.length < 4) return null;
  return { temporaryOffRestS: pl.readUInt32BE(0) };
}

// LK-Befehls-Payloads (Geräte-JS, Klasse/Methode wählt der Aufrufer):
export const lkSetModePayload = (mode) => u8(mode);             // lkSet/settings, u8 0–5
export const lkSetLightPayload = (on) => u8(on ? 1 : 0);        // lkSet/light, u8
export const lkCalibrateTimePayload = (s) => u8(s);             // lkCalibration/time, u8 0–255
export const lkCalibrateNotifyPayload = (idx) => u8(idx);       // lkCalibration/notification, u8 0–3
// u32BE-Payloads (lkSet/maxRefillTime, lkSet/temporaryOff, lkCalibration/value,
// lkManualRefill/start) direkt mit u32be() bauen.

// ---------- Reef Flare (RFRF, lokale Firmware) ----------

// Name UTF-16BE, 00 00-terminiert, max. 16 Zeichen (Geräte-JS: o=16)
function readUtf16be(pl, off) {
  let name = '';
  let i = off;
  while (i + 1 < pl.length) {
    const code = pl.readUInt16BE(i);
    i += 2;
    if (code === 0) return { name, end: i };
    // max. 16 Zeichen (Geräte-JS: o=16) — danach MUSS der Terminator kommen
    if (name.length >= 16) return null;
    name += String.fromCharCode(code);
  }
  return null; // kein Terminator gefunden / abgeschnitten
}

export function writeUtf16be(name) {
  const out = [];
  for (const ch of String(name).slice(0, 16)) {
    const code = ch.charCodeAt(0) & 0xffff;
    out.push((code >> 8) & 255, code & 255);
  }
  out.push(0, 0); // Terminator 00 00
  return out;
}

// Preset-Liste ab Offset off: u8 Anzahl (1..8), je Preset Name UTF-16BE +
// 00 00, u8 selected, 7 × u8 Kanal-% — danach (fw > 0.6.9) je Preset u8
// Gesamtintensität. Die Intensitäts-Bytes werden nur gelesen, wenn nach den
// Kanaldaten noch mindestens <Anzahl> Bytes übrig sind (fw-Erkennung per
// Länge — der Versionsstring steht dem Parser nicht zur Verfügung).
export function parseRfPresetList(pl, off) {
  if (!pl || off >= pl.length) return null;
  const count = pl[off];
  if (count < 1 || count > 8) return null;
  const presets = [];
  let i = off + 1;
  for (let p = 0; p < count; p++) {
    const nm = readUtf16be(pl, i);
    if (!nm) return null;
    i = nm.end;
    if (i + 8 > pl.length) return null; // selected + 7 Kanäle
    presets.push({
      name: nm.name,
      selected: pl[i] === 1,
      channels: [...pl.subarray(i + 1, i + 8)],
      intensity: null,
    });
    i += 8;
  }
  if (pl.length - i >= count) {
    for (let p = 0; p < count; p++) presets[p].intensity = pl[i + p];
    i += count;
  }
  return { presets, end: i };
}

// rfRefresh/manualTime (2 B): u16BE Restsekunden; 0xFFFF = „Always" → null
export function parseRfManualTime(pl) {
  if (!pl || pl.length < 2) return null;
  const raw = pl.readUInt16BE(0);
  return { manualTimerS: raw === 0xffff ? null : raw };
}

// rfRefresh/manualData (Geräte-JS-Layout der lokalen Firmware):
//   [0] u8 LED-Temperatur °C
//   [1] u8 Low-Nibble = Power-Size-Faktor (PowerMax = 70 × nibble W)
//   [2-3] u16BE Manuell-Timer Restsekunden (0xFFFF = Always → null)
//   [4] u8 Anzahl Presets, ab [5] Preset-Liste (s. parseRfPresetList)
// Zusätzlich abgeleitet: channelsManual (7 × %) + manualIntensity des aktiven
// Presets (selected; fehlt das Flag, gilt das erste Preset — wie im Geräte-JS).
export function parseRfManualData(pl) {
  if (!pl || pl.length < 5) return null;
  const list = parseRfPresetList(pl, 4);
  if (!list) return null;
  const selIdx = list.presets.findIndex((p) => p.selected);
  const sel = selIdx >= 0 ? list.presets[selIdx] : list.presets[0];
  const timerRaw = pl.readUInt16BE(2);
  return {
    ledTempC: pl[0],
    powerSize: pl[1] & 0x0f,
    manualTimerS: timerRaw === 0xffff ? null : timerRaw,
    manualPresets: list.presets,
    manualSelectedPreset: selIdx >= 0 ? selIdx : 0,
    channelsManual: sel.channels,
    manualIntensity: sel.intensity,
  };
}

// rfRefresh/offData (2 B): [0] u8 LED-Temperatur °C, [1] u8 Nibbles wie manualData
export function parseRfOffData(pl) {
  if (!pl || pl.length < 2) return null;
  return { ledTempC: pl[0], powerSize: pl[1] & 0x0f };
}

// rfManual/time: u16BE Sekunden; 0xFFFF = „Always" (seconds null/'always')
export function rfManualTimePayload(seconds) {
  if (seconds === null || seconds === undefined || seconds === 'always') return [0xff, 0xff];
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0 || s > 0xffff) throw new Error('Timer 0–65535 s (oder always) erwartet');
  return [(Math.round(s) >> 8) & 255, Math.round(s) & 255];
}

// rfManual/update: komplette Preset-Liste (Geräte-JS §4.3):
//   u8 count, je Preset: Name UTF-16BE + 00 00, u8 selected, 7 × u8 Kanal-%,
//   danach je Preset u8 intensity (fw > 0.6.9 — die lokale Firmware-Generation
//   ist > 0.6.9, die Intensitäts-Bytes werden immer mitgeschickt).
export function rfManualUpdatePayload(presets) {
  const list = (Array.isArray(presets) ? presets : []).slice(0, 8);
  if (!list.length) throw new Error('mindestens 1 Preset erwartet');
  const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
  const out = [list.length];
  for (const p of list) {
    out.push(...writeUtf16be(p?.name ?? 'Preset'));
    out.push(p?.selected ? 1 : 0);
    for (let ch = 0; ch < 7; ch++) out.push(pct(p?.channels?.[ch]));
  }
  for (const p of list) out.push(pct(p?.intensity ?? 100));
  return out;
}
