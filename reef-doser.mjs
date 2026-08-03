// Dosing / Dosierpumpe (RFDZ…, Altgerät mit Binärprotokoll): Parser für die
// dzRefresh-Frames und Payloads der dzSet/dzCalibration/dzManualRefill-Befehle.
// 1:1 aus dem Reverse-Engineering des Onboard-Webinterfaces (Modul RfDz01Main)
// abgeleitet; alle Integer Big-Endian, alle ml-Werte u32BE mit Skalierung ×100.
//
// Verifizierte Ankerwerte (Live-Frames + UI-Screenshots, Serial RFDZ012302130061):
//   Pumpe 1 „KH": Füllstand 0,00 / Kapazität 5000,00 ml, heute 13,35 ml,
//     Tagesziel 60,00 ml, nächste Dosis 13,40 ml, Kalibrierdatum 13.12.2025
//     (überfällig, Alert-Flag 1).
//   Pumpe 3 „MG": Füllstand 2375,13 ml (0x0003A1C9), Tagesziel 3,00 ml →
//     Restzeit round(2375,13/3,00) = 792 Tage, Füllstand = 47,5026 %.
//
// Layout dzRefresh/settings (440 B pro Pumpe; Pumpe 0 = Join-Broadcast mit
// 1 B 0x00 + 4×439 B, den Records fehlt das Pumpen-Byte):
//   [0]     u8     Pumpen-Nr. 1..4 (0 = Broadcast)
//   [1-4]   u32BE  Füllstand ml ×100
//   [5-8]   u32BE  Kapazität ml ×100
//   [9]     u8     Modus p: 0=idle, 1=Auto-Dose, 2=man. Refill, 3=Kreislauf, 4=Kalibrierung
//   [10-13] u32BE  wird vom Geräte-JS gelesen, aber verworfen → NICHT interpretiert
//   [14-17] u8,u8,u16BE  Kalibrierdatum Tag/Monat/Jahr
//   [18]    u8     Alert-Flag: 1 = Kalibrierung überfällig
//   [19-22] u32BE  heute dosiert ml ×100
//   [23-26] u32BE  Tagesziel ml ×100
//   [27]    u8     Kalibrier-Countdown s (p=4)
//   [28]    u8     Kreislauf-Countdown s (p=3)
//   [29-36] 2×u32BE man. Refill Ist/Ziel ml ×100 (p=2)
//   [37]    u8     Anzahl Zeitplan-Einträge (fix 24)
//   [38-205] 24×7 B Zeitplan: u32BE Menge ×100, u16BE Minute des Tages, u8 Status
//            (Statusbyte wird vom Geräte-JS gelesen, aber nicht verwendet → ignoriert)
//   [206]   u8     laufende Dosis-Nr. (p=1)
//   [207-214] 2×u32BE laufende Auto-Dosis Ist/Ziel ml ×100
//   [215-222] 2×u32BE man. Refill/Dosis Ist/Ziel ml ×100
//   [223]   u8     Tage-Zähler (mehrtägiger Refill) bzw. Delay-Minuten
//   [224]   u8     man. Status: 0=idle, 8=verzögert wartend, >1=mehrtägig laufend
//   [225]   u8     Anzahl History-Einträge (fix 12)
//   [226-405] 12×15 B History: doseMl, manualMl (je u32BE ×100), Jahr u16BE,
//            Monat/Tag/Stunde/Minute je u8, Typ u8 (0=frei, 1=Auto, 2=manuell,
//            3=beides, 4=Skip %, 5/6=man. verzögert, 7-10=Korrektur ml/%, 11=übersprungen)
//   [406]   u8     Wochentag-Bitmask bit0=So…bit6=Sa + bit7 = Automatik aktiv
//                  (bit7=0 ⇒ nächste Dosis übersprungen)
//   [407]   u8     Skip-Wert (Echo von skipNext, 0..100)
//   [408-439] 32 B Pumpenname UTF-16BE (16 Codeunits, 0 = Ende; leer ⇒ Default „Pump A-D")
//
// Layout dzRefresh/status (261 B): wie settings bis Modus, dann
//   [10-13] heute ml, [14-17] Tagesziel ml (Korrektur der früheren Vermutung
//   um 1 Byte!), [18-21] Refill-Ist (p=2) bzw. im Idle die nächste Dosis ml
//   (live beobachtet 0x53C = 13,40; Geräte-JS nutzt das Feld im Idle nicht),
//   [22-25] Refill-Ziel, [26] laufende Dosis-Nr., [27] Gesamtzahl Dosen,
//   [28-43] Auto-/man.-Ist/Ziel wie settings, [44] Tage-Zähler, [45] man. Status,
//   [46] History-Anzahl, [47-226] History, [227] Wochentag-Bitmask + bit7,
//   [228] Skip-Wert, [229-260] Name UTF-16BE. Kein Kalibrierdatum, kein Zeitplan.
//
// Bekannte, bewusst offene Punkte (aus dem RE-Report):
//   - settings[10-13]: verworfener u32 — wird nicht interpretiert.
//   - alert (44 B): nur [0]=Pumpe, [1]=Kalibrier-Flag bekannt; 42 B unbekannt.
//   - Statusbyte der Zeitplan-Slots: unbekannt — freie Slots werden über
//     ml=0 erkannt (UI-Heuristik, nicht protokollverifiziert).
//   - skipNext-Wert 0..100: vermutlich Prozent, Semantik nicht verifiziert.

import { u32be, writeUtf16be } from './reef-onboard.mjs';

const SETTINGS_LEN = 440;         // settings Einzelpumpe
const SETTINGS_BROADCAST_LEN = 1757; // 1 B 0x00 + 4×439 B (Records ohne Pumpen-Byte)
const STATUS_LEN = 261;
const SCHEDULE_SLOTS = 24;
const HISTORY_ENTRIES = 12;
const PUMP_COUNT = 4;

// Pumpen-Modi p (Geräte-JS) — nur dokumentarisch; die UI mappt per i18n.
export const DZ_MODE = { idle: 0, autoDose: 1, manualRefill: 2, circuit: 3, calibration: 4 };

// History-Typen (Geräte-JS): 0=frei, 1=Auto-Dosis, 2=man. Dosis, 3=beides,
// 4=SkipNext (%), 5/6=man. Dosis verzögert, 7=Erhöhung ml, 8=Erhöhung %,
// 9=Senkung ml, 10=Senkung %, 11=übersprungen.

// ---------- Abgeleitete Werte (Formeln aus dem Geräte-JS, §3/§4 des Reports) ----------

// Restzeit in Tagen: round(Füllstand / Tagesziel); null ohne Tagesziel
export function dzRemainingDays(fillMl, targetMl) {
  const t = Number(targetMl);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.round(Number(fillMl) / t);
}

// Füllstand in %: 100 × Füllstand / Kapazität; null ohne Kapazität
export function dzFillPercent(fillMl, capacityMl) {
  const c = Number(capacityMl);
  if (!Number.isFinite(c) || c <= 0) return null;
  return (100 * Number(fillMl)) / c;
}

// ---------- Lesen ----------

// ml-Rohwert (u32BE, ×100) an Offset o — Längen-Gate obliegt dem Aufrufer
const mlAt = (pl, o) => pl.readUInt32BE(o) / 100;

// Name UTF-16BE aus einem festen 32-B-Feld (16 Codeunits, 0-Codeunit = Ende).
// Leeres Feld ⇒ Default-Name „Pump A/B/C/D" (Geräte-JS-Verhalten).
function readPumpName(pl, off, pumpIndex) {
  let name = '';
  for (let i = 0; i < 16; i++) {
    const code = pl.readUInt16BE(off + i * 2);
    if (code === 0) break;
    name += String.fromCharCode(code);
  }
  return name || `Pump ${'ABCD'[pumpIndex - 1] ?? pumpIndex}`;
}

// Zeitplan: 24 Slots à 7 B ab Offset off. Das Statusbyte (+6) wird vom
// Geräte-JS nicht verwendet — wir lesen es bewusst nicht aus.
function readSchedule(pl, off) {
  const slots = [];
  for (let i = 0; i < SCHEDULE_SLOTS; i++) {
    const o = off + i * 7;
    slots.push({ ml: mlAt(pl, o), minutes: pl.readUInt16BE(o + 4) % 1440 });
  }
  return slots;
}

// History: 12 Einträge à 15 B ab Offset off. Freie Einträge (Typ 0) werden
// übersprungen. ts = Epoch-ms aus den Gerätefeldern (Server-Lokalzeit — die
// Gerätezeitzone ist unbekannt, für „letzte Aktivität" ausreichend).
function readHistory(pl, off) {
  const out = [];
  for (let i = 0; i < HISTORY_ENTRIES; i++) {
    const o = off + i * 15;
    const type = pl[o + 14];
    if (type === 0) continue;
    const year = pl.readUInt16BE(o + 8);
    const month = ((pl[o + 10] - 1) % 12) + 1; // Monats-Rohbyte wie im Geräte-JS normiert
    const ts = new Date(year, month - 1, pl[o + 11], pl[o + 12], pl[o + 13]).getTime();
    out.push({
      doseMl: mlAt(pl, o),
      manualMl: mlAt(pl, o + 4),
      ts: Number.isFinite(ts) ? ts : 0,
      type,
    });
  }
  return out;
}

// Gemeinsamer Tail ab dem History-Block (settings und status teilen das
// Layout ab dort — nur die Start-Offsets unterscheiden sich).
function readTail(pl, histOff, maskOff, skipOff, nameOff, pump) {
  return {
    history: readHistory(pl, histOff),
    weekdayMask: pl[maskOff] & 0x7f,
    autoActive: (pl[maskOff] & 0x80) !== 0,
    skipValue: pl[skipOff],
    name: readPumpName(pl, nameOff, pump),
  };
}

// settings-Record (440 B inkl. Pumpen-Byte) → Pumpen-Patch (null bei falscher Länge)
function parseSettingsRecord(pl) {
  if (!pl || pl.length !== SETTINGS_LEN) return null;
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return {
    index: pump,
    fillMl: mlAt(pl, 1),
    capacityMl: mlAt(pl, 5),
    mode: pl[9],
    // [10-13] verworfener Firmware-u32 — bewusst nicht interpretiert
    calDate: { day: pl[14], month: pl[15], year: pl.readUInt16BE(16) },
    calOverdue: pl[18] === 1,
    todayMl: mlAt(pl, 19),
    targetMl: mlAt(pl, 23),
    calCountdownS: pl[27],
    circuitCountdownS: pl[28],
    refillDoneMl: mlAt(pl, 29),
    refillTargetMl: mlAt(pl, 33),
    schedule: readSchedule(pl, 38),
    autoDoseNr: pl[206],
    autoDoseDoneMl: mlAt(pl, 207),
    autoDoseTargetMl: mlAt(pl, 211),
    manualDoneMl: mlAt(pl, 215),
    manualTargetMl: mlAt(pl, 219),
    dayCounter: pl[223],
    manualStatus: pl[224],
    ...readTail(pl, 226, 406, 407, 408, pump),
  };
}

// dzRefresh/settings: 440 B (Einzelpumpe) oder 1757 B (Join-Broadcast,
// Pumpe 0 → 4×439-B-Records ohne Pumpen-Byte, Position = Pumpe 1..4).
export function parseDzSettings(pl) {
  if (!pl) return null;
  if (pl.length === SETTINGS_LEN) {
    const p = parseSettingsRecord(pl);
    return p ? { pumps: [p] } : null;
  }
  if (pl.length === SETTINGS_BROADCAST_LEN && pl[0] === 0) {
    const pumps = [];
    for (let i = 0; i < PUMP_COUNT; i++) {
      // Record um das implizite Pumpen-Byte ergänzen → 440-B-Einzellayout
      const rec = Buffer.concat([Buffer.from([i + 1]), pl.subarray(1 + i * 439, 1 + (i + 1) * 439)]);
      const p = parseSettingsRecord(rec);
      if (!p) return null;
      pumps.push(p);
    }
    return { pumps };
  }
  return null;
}

// dzRefresh/status (261 B) — kompakter Status-Push ohne Kalibrierdatum/Zeitplan
export function parseDzStatus(pl) {
  if (!pl || pl.length !== STATUS_LEN) return null;
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return {
    index: pump,
    fillMl: mlAt(pl, 1),
    capacityMl: mlAt(pl, 5),
    mode: pl[9],
    todayMl: mlAt(pl, 10),
    targetMl: mlAt(pl, 14),
    // [18-21]: Refill-Ist (p=2); im Idle trägt die Firmware hier offenbar die
    // nächste Dosis (0x53C = 13,40 ml live beobachtet). Geräte-JS nutzt es
    // dann nicht — wir legen es neutral als nextDoseMl ab.
    nextDoseMl: mlAt(pl, 18),
    refillTargetMl: mlAt(pl, 22),
    autoDoseNr: pl[26],
    autoDoseTotal: pl[27],
    autoDoseDoneMl: mlAt(pl, 28),
    autoDoseTargetMl: mlAt(pl, 32),
    manualDoneMl: mlAt(pl, 36),
    manualTargetMl: mlAt(pl, 40),
    dayCounter: pl[44],
    manualStatus: pl[45],
    ...readTail(pl, 47, 227, 228, 229, pump),
  };
}

// dzRefresh/alert (44 B): nur [0]=Pumpe und [1]=Kalibrier-Flag sind bekannt;
// die restlichen 42 B liest auch das Geräte-JS nicht → nicht interpretiert.
export function parseDzAlert(pl) {
  if (!pl || pl.length < 44) return null; // spezifizierte Länge 44 B (gelesen werden nur [0]/[1])
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return { index: pump, calOverdue: pl[1] === 1 };
}

// dzRefresh/dose (5 B): Dosier-Event [pump][u32BE Menge ×100]. Das Geräte-JS
// verwirft diese Methode — auf dem Draht existiert sie (live verifiziert).
export function parseDzDose(pl, now = Date.now()) {
  if (!pl || pl.length !== 5) return null;
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return { index: pump, lastDoseMl: mlAt(pl, 1), lastDoseTs: now };
}

// Kurz-Events (Push während laufender Vorgänge), Layouts §1.4 des Reports.
function parseDzManualRefill(pl) {
  if (!pl || pl.length !== 9) return null;
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return { index: pump, mode: DZ_MODE.manualRefill, refillDoneMl: mlAt(pl, 1), refillTargetMl: mlAt(pl, 5) };
}

function parseDzCountdown(pl, mode, key) {
  if (!pl || pl.length !== 2) return null;
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return { index: pump, mode, [key]: pl[1] };
}

function parseDzStop(pl, clear) {
  if (!pl || pl.length !== 1) return null;
  const pump = pl[0];
  if (pump < 1 || pump > PUMP_COUNT) return null;
  return { index: pump, mode: DZ_MODE.idle, ...clear };
}

// Dispatcher für updateState: Methode → { pumps: [Patch, …] } oder null.
// Jeder Patch trägt index (1..4); der Server mergt flach pro Pumpe.
export function parseDzRefresh(method, pl, now = Date.now()) {
  const one = (p) => (p ? { pumps: [p] } : null);
  switch (method) {
    case 'settings': return parseDzSettings(pl);
    case 'status': return one(parseDzStatus(pl));
    case 'alert': return one(parseDzAlert(pl));
    case 'dose': return one(parseDzDose(pl, now));
    case 'manualRefill': return one(parseDzManualRefill(pl));
    case 'manualRefillStop':
      return one(parseDzStop(pl, { refillDoneMl: 0, refillTargetMl: 0, manualStatus: 0 }));
    case 'calibration': return one(parseDzCountdown(pl, DZ_MODE.calibration, 'calCountdownS'));
    case 'calibrationStop': return one(parseDzStop(pl, { calCountdownS: 0 }));
    case 'circuit': return one(parseDzCountdown(pl, DZ_MODE.circuit, 'circuitCountdownS'));
    case 'circuitStop': return one(parseDzStop(pl, { circuitCountdownS: 0 }));
    default: return null;
  }
}

// ---------- Schreiben (Payload-Bausteine; Klasse/Methode wählt der Aufrufer) ----------

// ml ×100 als u32BE
export function ml100(ml) {
  return u32be(Math.round(Number(ml) * 100));
}

// dzSet/name: [pump][Name UTF-16BE][00 00] (max. 16 Zeichen — Aufrufer validiert)
export function dzSetNamePayload(pump, name) {
  return [pump & 255, ...writeUtf16be(name)];
}

// dzSet/container: [pump][u32BE Füllstand ×100][u32BE Kapazität ×100] (9 B)
export function dzSetContainerPayload(pump, currentMl, capacityMl) {
  return [pump & 255, ...ml100(currentMl), ...ml100(capacityMl)];
}

// dzSet/doses: [pump][count][je Slot u32BE ml ×100 + u16BE Minute][K u8].
// K = Wochentag-Maske (bit0=So…bit6=Sa) mit gesetztem bit7 = Automatik aktiv
// (das Geräte-JS setzt bit7 beim Speichern immer; die Firmware löscht es bei
// aktivem Skip-Next selbst).
export function dzSetDosesPayload(pump, slots, weekdayMask) {
  const out = [pump & 255, slots.length & 255];
  for (const s of slots) {
    out.push(...ml100(s.ml));
    const min = Math.round(Number(s.minutes)) % 1440;
    out.push((min >> 8) & 255, min & 255);
  }
  out.push((weekdayMask & 0x7f) | 0x80);
  return out;
}

// dzSet/skipNext: [pump][Wert u8, 0..100]
export function dzSkipNextPayload(pump, value) {
  return [pump & 255, value & 255];
}

// Ein-Byte-Pumpen-Payload: dzSet/cancelSkip, dzCalibration start/stop/
// circuitStart/circuitStop, dzManualRefill/stop, dzGet/settings
export function dzPumpPayload(pump) {
  return [pump & 255];
}

// dzGet/settings: [pump] (0 = alle)
export function dzGetSettingsPayload(pump) {
  return [pump & 255];
}

// dzCalibration/value: [pump][u32BE gemessene Menge ×100] (5 B)
export function dzCalibrateValuePayload(pump, ml) {
  return [pump & 255, ...ml100(ml)];
}

// dzCalibration/notification: [pump][Intervall u8: 0=1 W, 1=2 W, 2=1 M, 3=3 M]
export function dzCalibrateNotifyPayload(pump, interval) {
  return [pump & 255, interval & 255];
}

// dzManualRefill/start (11 B): [pump][Vorzeichen u8][u32BE |Menge| ×100]
// [Modus V u8][u32BE Delay-Minuten, nur bei V=8]. V: 0=sofort, 1..7=in N
// Tagen, 8=verzögert um N Minuten. Negative Mengen (Vorzeichen 1) existieren
// im Protokoll, werden aber weder vom Geräte-JS noch von uns genutzt.
export function dzManualRefillStartPayload(pump, ml, mode = 0, delayMin = 0) {
  const abs = Math.abs(Number(ml));
  return [
    pump & 255,
    Number(ml) < 0 ? 1 : 0,
    ...ml100(abs),
    mode & 255,
    ...u32be(mode === 8 ? Math.round(Number(delayMin)) : 0),
  ];
}
