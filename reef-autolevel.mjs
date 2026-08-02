// reef-autolevel — Ablaufschacht-Stabilisierung
// Zwei Level-Sensoren im Ablaufschacht (oben „Hoch", unten „Tief") regeln die
// Stärke der Rückförderpumpe (basepump) in kleinen Schritten nach:
//   Hoch-Sensor meldet alarmHigh (Schacht läuft voll)  → Speed − stepPercent
//   Tief-Sensor meldet alarmLow  (Schacht läuft leer)  → Speed + stepPercent
// Solange ein Alarm ansteht, wird nach jedem Cooldown erneut angepasst —
// eine einmalige 1-%-Stufe stabilisiert nichts. Bei 'ok'/'unknown' passiert
// nichts (kein Aktionismus auf unklaren Daten).
//
// Konfiguration: autolevel.json (Laufzeitdaten, in .gitignore), atomar
// geschrieben (tmp + rename, Muster names.json). History: Ringpuffer der
// letzten 50 Eingriffe, nur im Speicher.
//
// Das Modul ist bewusst entkoppelt: alle Abhängigkeiten werden injiziert,
// damit die Logik isoliert testbar ist (kein Import von reef-cloud-v2).

import fs from 'node:fs';
import path from 'node:path';

export const AUTOLEVEL_DEFAULTS = {
  enabled: false,
  pumpSerial: '',
  highSerial: '',
  lowSerial: '',
  stepPercent: 1,   // Schrittweite je Eingriff (%)
  minSpeed: 1,      // Clamp-Untergrenze (%)
  maxSpeed: 100,    // Clamp-Obergrenze (%)
  cooldownS: 60,    // Mindestabstand zwischen zwei Eingriffen je Richtung (s)
};

const HISTORY_MAX = 50;
const CHECK_INTERVAL_MS = 15_000; // periodischer Re-Check, solange ein Alarm ansteht
const SERIAL_RE = /^[\w-]{1,32}$/;

export function createAutolevel({ dir, log, metaFor, devices, buildCommandFrame, encodeFrame, captureFrame }) {
  const FILE = path.join(dir, 'autolevel.json');
  const config = { ...AUTOLEVEL_DEFAULTS };
  const history = []; // { ts, reason: 'alarmHigh'|'alarmLow', sensorSerial, oldSpeed, newSpeed }
  let lastActionTs = 0;
  const lastAdjustAt = { up: 0, down: 0 }; // Cooldown pro Richtung

  // Tolerant laden: fehlende/defekte Datei → Defaults; ungültige Felder
  // werden einzeln verworfen (nie die ganze Config).
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
      for (const k of ['pumpSerial', 'highSerial', 'lowSerial']) {
        if (typeof raw[k] === 'string' && (raw[k] === '' || SERIAL_RE.test(raw[k]))) config[k] = raw[k];
      }
      for (const k of ['stepPercent', 'minSpeed', 'maxSpeed', 'cooldownS']) {
        if (Number.isFinite(raw[k])) config[k] = Number(raw[k]);
      }
      if (!(config.minSpeed < config.maxSpeed)) {
        config.minSpeed = AUTOLEVEL_DEFAULTS.minSpeed;
        config.maxSpeed = AUTOLEVEL_DEFAULTS.maxSpeed;
      }
    }
    if (config.enabled) log(`Autolevel aktiv: Pumpe ${config.pumpSerial || '?'}, Schritt ${config.stepPercent} %, Cooldown ${config.cooldownS} s`);
    else log('Autolevel geladen (deaktiviert)');
  } catch { /* Datei optional oder defekt → mit Defaults starten (deaktiviert) */ }

  function saveConfig() {
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
      fs.renameSync(tmp, FILE);
    } catch (e) { log(`!! autolevel.json nicht geschrieben: ${e.message}`); }
  }

  // Sensorzustand: primär sensor0 (eigene Sonde des Geräts), sensor1 nur
  // als Fallback, falls das Gerät zwei Sonden meldet.
  function sensorState(serial) {
    const s = metaFor(serial)?.state;
    if (!s) return 'unknown';
    if (typeof s.sensor0 === 'string' && s.sensor0 !== 'unknown') return s.sensor0;
    if (typeof s.sensor1 === 'string') return s.sensor1;
    return typeof s.sensor0 === 'string' ? s.sensor0 : 'unknown';
  }

  function pumpOnline() {
    const d = config.pumpSerial && devices.get(config.pumpSerial);
    return !!(d && d.readyState === d.OPEN);
  }

  function currentSpeed() {
    if (!config.pumpSerial) return null;
    const v = Number(metaFor(config.pumpSerial)?.state?.speed);
    return Number.isFinite(v) ? v : null;
  }

  // Ein Regel-Eingriff. reason: 'alarmHigh' (Speed senken) | 'alarmLow' (heben).
  // Wirft niemals — der Aufrufer liegt im Geräte-Frame-Pfad.
  function adjust(reason) {
    try {
      if (!config.enabled || !config.pumpSerial) return false;
      const dir = reason === 'alarmHigh' ? 'down' : 'up';
      const now = Date.now();
      if (now - lastAdjustAt[dir] < config.cooldownS * 1000) return false;
      const dev = devices.get(config.pumpSerial);
      if (!dev || dev.readyState !== dev.OPEN) return false;
      const cur = currentSpeed();
      if (cur === null) return false; // Speed der Pumpe noch unbekannt
      const delta = reason === 'alarmHigh' ? -config.stepPercent : +config.stepPercent;
      const target = Math.round(Math.min(config.maxSpeed, Math.max(config.minSpeed, cur + delta)));
      if (target === cur) return false; // schon am Clamp-Anschlag
      const [cls, mth, payload] = buildCommandFrame(config.pumpSerial, 'setSpeed', { speed: target });
      const buf = encodeFrame(cls, mth, payload, config.pumpSerial);
      captureFrame?.(buf, 'out', config.pumpSerial);
      dev.send(buf);
      // Optimistisch spiegeln — die Pumpe reportet den neuen Wert ohnehin zurück
      const m = metaFor(config.pumpSerial);
      m.state = { ...m.state, speed: target };
      lastAdjustAt[dir] = now;
      lastActionTs = now;
      history.push({
        ts: now, reason,
        sensorSerial: reason === 'alarmHigh' ? config.highSerial : config.lowSerial,
        oldSpeed: cur, newSpeed: target,
      });
      if (history.length > HISTORY_MAX) history.shift();
      log(`  [autolevel] ${reason}: RFP-Speed ${cur} → ${target} % (Schritt ${config.stepPercent} %, Sensor ${reason === 'alarmHigh' ? 'oben' : 'unten'})`);
      return true;
    } catch (e) {
      log(`!! [autolevel] Eingriff fehlgeschlagen: ${e.message}`);
      return false;
    }
  }

  // Zustand prüfen und ggf. eingreifen (periodisch + bei Sensor-Updates).
  // Hoch-Alarm hat Vorrang vor Tief-Alarm (Vollaufen ist kritischer).
  function check() {
    try {
      if (!config.enabled || !config.pumpSerial) return;
      if (config.highSerial && sensorState(config.highSerial) === 'alarmHigh') {
        adjust('alarmHigh');
        return;
      }
      if (config.lowSerial && sensorState(config.lowSerial) === 'alarmLow') {
        adjust('alarmLow');
      }
    } catch (e) { log(`!! [autolevel] Prüffehler: ${e.message}`); }
  }

  // Hook nach updateState(): nur reagieren, wenn das aktualisierte Gerät
  // einer der konfigurierten Sensoren ist. Niemals Exceptions werfen.
  function onStateUpdate(serial) {
    try {
      if (!config.enabled) return;
      if (serial && (serial === config.highSerial || serial === config.lowSerial)) check();
    } catch { /* defensiv: nie in den Frame-Pfad werfen */ }
  }

  // Periodischer Re-Check: solange ein Alarm ansteht, nach jedem Cooldown
  // erneut schrittweise anpassen. unref'd — hält den Prozess nicht offen.
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();

  function status() {
    return {
      running: !!(config.enabled && config.pumpSerial),
      lastActionTs,
      currentSpeed: currentSpeed(),
      pumpOnline: pumpOnline(),
      highState: config.highSerial ? sensorState(config.highSerial) : 'unknown',
      lowState: config.lowSerial ? sensorState(config.lowSerial) : 'unknown',
      cooldownS: config.cooldownS,
      cooldownRemainingS: {
        up: Math.max(0, Math.ceil((lastAdjustAt.up + config.cooldownS * 1000 - Date.now()) / 1000)),
        down: Math.max(0, Math.ceil((lastAdjustAt.down + config.cooldownS * 1000 - Date.now()) / 1000)),
      },
    };
  }

  function payload() {
    // History: neueste zuerst
    return { config: { ...config }, status: status(), history: history.slice().reverse() };
  }

  // Config-Teilmenge aus POST /api/autolevel validieren.
  // Wirft Error mit verständlicher Meldung; liefert den validierten Patch.
  function validateSubset(body, knownFamily) {
    if (!body || typeof body !== 'object') throw new Error('Body fehlt');
    const patch = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled muss true/false sein');
      patch.enabled = body.enabled;
    }
    const serialField = (key, wantFamily, label) => {
      if (body[key] === undefined) return;
      const v = String(body[key]).trim();
      if (v !== '') {
        if (!SERIAL_RE.test(v)) throw new Error(`${label}: ungültige Serial (1–32 Zeichen: Buchstaben, Ziffern, _, -)`);
        const fam = knownFamily(v);
        if (fam === null) throw new Error(`${label}: Gerät ${v} ist unbekannt`);
        if (fam !== wantFamily) throw new Error(`${label}: ${v} ist vom Typ "${fam}", erwartet wird "${wantFamily}"`);
      }
      patch[key] = v;
    };
    serialField('pumpSerial', 'basepump', 'pumpSerial');
    serialField('highSerial', 'levelSensor', 'highSerial');
    serialField('lowSerial', 'levelSensor', 'lowSerial');
    const numField = (key, min, max, label) => {
      if (body[key] === undefined) return;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < min || v > max || !Number.isInteger(v)) {
        throw new Error(`${label} muss eine ganze Zahl von ${min} bis ${max} sein`);
      }
      patch[key] = v;
    };
    numField('stepPercent', 1, 10, 'stepPercent');
    numField('minSpeed', 0, 50, 'minSpeed');
    numField('maxSpeed', 50, 100, 'maxSpeed');
    numField('cooldownS', 10, 600, 'cooldownS');
    const nextMin = patch.minSpeed ?? config.minSpeed;
    const nextMax = patch.maxSpeed ?? config.maxSpeed;
    if (!(nextMin < nextMax)) throw new Error(`minSpeed (${nextMin}) muss kleiner als maxSpeed (${nextMax}) sein`);
    if (patch.enabled === true && !(patch.pumpSerial ?? config.pumpSerial)) {
      throw new Error('Zum Aktivieren muss eine Pumpe (pumpSerial) konfiguriert sein');
    }
    return patch;
  }

  // Änderungen wirken sofort: check()/adjust() lesen die Config bei jedem Lauf.
  function applyConfig(patch) {
    Object.assign(config, patch);
    saveConfig();
    log(`  [autolevel] Konfiguration gespeichert: enabled=${config.enabled}, Pumpe=${config.pumpSerial || '—'}, Hoch=${config.highSerial || '—'}, Tief=${config.lowSerial || '—'}, Schritt=${config.stepPercent} %, Bereich=${config.minSpeed}–${config.maxSpeed} %, Cooldown=${config.cooldownS} s`);
    return { ...config };
  }

  return { onStateUpdate, check, payload, validateSubset, applyConfig };
}
