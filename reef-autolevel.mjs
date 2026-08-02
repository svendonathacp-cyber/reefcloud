// reef-autolevel — Ablaufschacht-Stabilisierung
// Zwei eigenständige Level-Sensoren im Ablaufschacht (oben „Hoch", unten
// „Tief") regeln die Stärke der Rückförderpumpe (basepump) in kleinen
// Schritten nach — auf Basis der covered-Semantik (Parser reef-cloud-v2,
// live verifiziert 02.08.):
//   Sensor oben covered=true   (Schacht zu voll)  → Speed − stepPercent
//   Sensor unten covered=false (Schacht zu leer)  → Speed + stepPercent
// (RFP pumpt Sump→Becken; der Ablaufschacht entwässert Becken→Sump.)
// Priorisierung: „zu voll" (runter) geht vor „zu leer" (rauf) — im Zweifel
// lieber weniger pumpen. Bei 'unknown' passiert nichts (kein Aktionismus
// auf unklaren Daten). Solange ein Zustand ansteht, wird nach jedem
// Cooldown erneut angepasst — eine einmalige 1-%-Stufe stabilisiert nichts.
//
// Frische-Daten-Gate: die Sensoren pushen nur ca. alle 60–90 s. Vor JEDER
// automatischen Anpassung muss der letzte lsRefresh/data-Frame beider
// Sensoren jünger als maxDataAgeMs sein (Stempel lastLsDataTs im Geräte-Meta,
// gesetzt vom Server-Parser). Sonst: aktiver Refresh per lsConnect/join an
// die betreffenden Sensoren (verifizierter Mechanismus: löst binnen <1 s
// einen frischen lsRefresh/data-Report aus), bis zu refreshWaitMs auf den
// frischen Frame warten, dann erst entscheiden. Bleiben die Daten stale
// (oder ist ein Sensor offline): Anpassung überspringen, History-Eintrag
// 'staleData' („übersprungen — keine frischen Sensordaten"), kein Fehler.
//
// Konfiguration: autolevel.json (Laufzeitdaten, in .gitignore), atomar
// geschrieben (tmp + rename, Muster names.json). History: Ringpuffer der
// letzten 50 Ereignisse, nur im Speicher.
//
// Das Modul ist bewusst entkoppelt: alle Abhängigkeiten werden injiziert,
// damit die Logik isoliert testbar ist (kein Import von reef-cloud-v2,
// Tests: reef-autolevel-test.mjs).

import fs from 'node:fs';
import path from 'node:path';

export const AUTOLEVEL_DEFAULTS = {
  enabled: false,
  pumpSerial: '',
  highSerial: '',
  lowSerial: '',
  stepPercent: 1,      // Schrittweite je Eingriff (%)
  minSpeed: 1,         // Clamp-Untergrenze (%)
  maxSpeed: 100,       // Clamp-Obergrenze (%)
  cooldownS: 60,       // Mindestabstand zwischen zwei Eingriffen je Richtung (s)
  maxDataAgeMs: 90_000, // Frische-Gate: Sensor-Daten älter als das → erst refreshen
  refreshWaitMs: 3_000, // Wartezeit auf frische Frames nach lsConnect/join
};

const HISTORY_MAX = 50;
const CHECK_INTERVAL_MS = 15_000; // periodischer Re-Check, solange ein Zustand ansteht
const SERIAL_RE = /^[\w-]{1,32}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAutolevel({ dir, log, metaFor, devices, buildCommandFrame, encodeFrame, captureFrame }) {
  const FILE = path.join(dir, 'autolevel.json');
  const config = { ...AUTOLEVEL_DEFAULTS };
  // { ts, reason: 'tooFull'|'tooEmpty', sensorSerial, oldSpeed, newSpeed }
  // { ts, reason: 'staleData', sensorSerial } — übersprungene Anpassung
  const history = [];
  let lastActionTs = 0;
  const lastAdjustAt = { up: 0, down: 0 }; // Cooldown pro Richtung
  let checking = false; // Reentrancy-Guard (check ist seit Frische-Gate async)

  // Tolerant laden: fehlende/defekte Datei → Defaults; ungültige Felder
  // werden einzeln verworfen (nie die ganze Config). Bestehende autolevel.json
  // ohne die neuen Frische-Felder wird so sanft auf die Defaults migriert.
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
      for (const k of ['pumpSerial', 'highSerial', 'lowSerial']) {
        if (typeof raw[k] === 'string' && (raw[k] === '' || SERIAL_RE.test(raw[k]))) config[k] = raw[k];
      }
      for (const k of ['stepPercent', 'minSpeed', 'maxSpeed', 'cooldownS', 'maxDataAgeMs', 'refreshWaitMs']) {
        if (Number.isFinite(raw[k])) config[k] = Number(raw[k]);
      }
      if (!(config.minSpeed < config.maxSpeed)) {
        config.minSpeed = AUTOLEVEL_DEFAULTS.minSpeed;
        config.maxSpeed = AUTOLEVEL_DEFAULTS.maxSpeed;
      }
    }
    if (config.enabled) log(`Autolevel aktiv: Pumpe ${config.pumpSerial || '?'}, Schritt ${config.stepPercent} %, Cooldown ${config.cooldownS} s, maxDatenalter ${config.maxDataAgeMs} ms`);
    else log('Autolevel geladen (deaktiviert)');
  } catch { /* Datei optional oder defekt → mit Defaults starten (deaktiviert) */ }

  function saveConfig() {
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
      fs.renameSync(tmp, FILE);
    } catch (e) { log(`!! autolevel.json nicht geschrieben: ${e.message}`); }
  }

  // covered-Wert eines Sensors: true (Wasser über Sensor) | false (unter
  // Sensor) | 'unknown' (unbekannter Code oder noch keine Daten)
  function coveredOf(serial) {
    const c = metaFor(serial)?.state?.covered;
    return c === true || c === false ? c : 'unknown';
  }

  // Zeitstempel des letzten lsRefresh/data-Frames (0 = noch nie)
  function lastDataTs(serial) {
    const ts = metaFor(serial)?.lastLsDataTs;
    return typeof ts === 'number' && ts > 0 ? ts : 0;
  }

  function dataAgeMs(serial) {
    const ts = lastDataTs(serial);
    return ts ? Date.now() - ts : Infinity;
  }

  function deviceOnline(serial) {
    const d = serial && devices.get(serial);
    return !!(d && d.readyState === d.OPEN);
  }

  function pumpOnline() {
    return deviceOnline(config.pumpSerial);
  }

  function currentSpeed() {
    if (!config.pumpSerial) return null;
    const v = Number(metaFor(config.pumpSerial)?.state?.speed);
    return Number.isFinite(v) ? v : null;
  }

  function pushHistory(entry) {
    history.push(entry);
    if (history.length > HISTORY_MAX) history.shift();
  }

  // Übersprungene Anpassung protokollieren — gedrosselt, damit der Ringpuffer
  // bei dauerhaft offline/stale Sensoren nicht mit Duplikaten vollläuft.
  function skipStale(staleSerials) {
    const last = history[history.length - 1];
    if (last?.reason === 'staleData' && Date.now() - last.ts < config.cooldownS * 1000) return;
    pushHistory({ ts: Date.now(), reason: 'staleData', sensorSerial: staleSerials[0] || '' });
    log(`  [autolevel] Anpassung übersprungen — keine frischen Sensordaten (${staleSerials.join(', ') || 'keine Sensordaten'})`);
  }

  // Aktiver Refresh: lsConnect/join an die stale Sensoren (Payload = serial +
  // NUL, extra = join_-Tag — exakt das Login-Priming aus reef-cloud-v2; live
  // verifiziert: löst binnen <1 s einen frischen lsRefresh/data-Report aus).
  // Danach bis zu refreshWaitMs auf wirklich NEUE Datenframes warten
  // (Baseline = Stand vor dem Join). true = alle angeforderten Sensoren frisch.
  async function refreshSensors(staleSerials) {
    const baseline = new Map(staleSerials.map((s) => [s, lastDataTs(s)]));
    let requested = 0;
    for (const serial of staleSerials) {
      const dev = devices.get(serial);
      if (!dev || dev.readyState !== dev.OPEN) continue; // offline → kein Refresh möglich
      const buf = encodeFrame('lsConnect', 'join', [...Buffer.from(serial, 'latin1'), 0], serial, `join_${Date.now()}`);
      captureFrame?.(buf, 'out', serial);
      dev.send(buf);
      requested++;
      log(`  [autolevel] aktiver Refresh: lsConnect/join → ${serial}`);
    }
    if (!requested) return false; // alle stale Sensoren offline
    const fresh = () => staleSerials.every((s) => lastDataTs(s) > baseline.get(s));
    const deadline = Date.now() + config.refreshWaitMs;
    while (Date.now() < deadline) {
      if (fresh()) return true;
      await sleep(100);
    }
    return fresh();
  }

  // Ein Regel-Eingriff. reason: 'tooFull' (Speed senken) | 'tooEmpty' (heben).
  // Wirft niemals — der Aufrufer liegt im Geräte-Frame-Pfad.
  function adjust(reason) {
    try {
      if (!config.enabled || !config.pumpSerial) return false;
      const dir = reason === 'tooFull' ? 'down' : 'up';
      const now = Date.now();
      if (now - lastAdjustAt[dir] < config.cooldownS * 1000) return false;
      const dev = devices.get(config.pumpSerial);
      if (!dev || dev.readyState !== dev.OPEN) return false;
      const cur = currentSpeed();
      if (cur === null) return false; // Speed der Pumpe noch unbekannt
      const delta = reason === 'tooFull' ? -config.stepPercent : +config.stepPercent;
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
      pushHistory({
        ts: now, reason,
        sensorSerial: reason === 'tooFull' ? config.highSerial : config.lowSerial,
        oldSpeed: cur, newSpeed: target,
      });
      log(`  [autolevel] ${reason}: RFP-Speed ${cur} → ${target} % (Schritt ${config.stepPercent} %, Sensor ${reason === 'tooFull' ? 'oben' : 'unten'})`);
      return true;
    } catch (e) {
      log(`!! [autolevel] Eingriff fehlgeschlagen: ${e.message}`);
      return false;
    }
  }

  // Zustand prüfen und ggf. eingreifen (periodisch + bei Sensor-Updates).
  // „Zu voll" (runter) hat Vorrang vor „zu leer" (rauf) — Vollaufen ist
  // kritischer; im Zweifel lieber weniger pumpen.
  async function check() {
    if (checking) return; // kein überlappender Lauf (Frische-Gate wartet async)
    checking = true;
    try {
      if (!config.enabled || !config.pumpSerial) return;
      const sensors = [config.highSerial, config.lowSerial].filter(Boolean);
      if (!sensors.length) return;
      // Frische-Daten-Gate vor JEDER automatischen Anpassung: Daten älter als
      // maxDataAgeMs (oder Sensor offline) → erst aktiv refreshen, dann
      // entscheiden; bleibt es stale → überspringen statt auf Alt-Daten regeln.
      const stale = sensors.filter((s) => dataAgeMs(s) > config.maxDataAgeMs);
      if (stale.length) {
        const refreshable = stale.filter((s) => deviceOnline(s));
        if (refreshable.length) await refreshSensors(refreshable);
        const stillStale = sensors.filter((s) => dataAgeMs(s) > config.maxDataAgeMs);
        if (stillStale.length) { skipStale(stillStale); return; }
      }
      if (config.highSerial && coveredOf(config.highSerial) === true) {
        adjust('tooFull'); // Schacht zu voll — Wasser über Sensor oben
        return;
      }
      if (config.lowSerial && coveredOf(config.lowSerial) === false) {
        adjust('tooEmpty'); // Schacht zu leer — Wasser unter Sensor unten
      }
    } catch (e) {
      log(`!! [autolevel] Prüffehler: ${e.message}`);
    } finally {
      checking = false;
    }
  }

  // Hook nach updateState(): nur reagieren, wenn das aktualisierte Gerät
  // einer der konfigurierten Sensoren ist. Niemals Exceptions werfen.
  function onStateUpdate(serial) {
    try {
      if (!config.enabled) return;
      if (serial && (serial === config.highSerial || serial === config.lowSerial)) void check();
    } catch { /* defensiv: nie in den Frame-Pfad werfen */ }
  }

  // Periodischer Re-Check: solange ein Zustand ansteht, nach jedem Cooldown
  // erneut schrittweise anpassen. unref'd — hält den Prozess nicht offen.
  const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  timer.unref();

  function status() {
    const ageS = (serial) => {
      const ts = serial && lastDataTs(serial);
      return ts ? Math.round((Date.now() - ts) / 1000) : null;
    };
    return {
      running: !!(config.enabled && config.pumpSerial),
      lastActionTs,
      currentSpeed: currentSpeed(),
      pumpOnline: pumpOnline(),
      highCovered: config.highSerial ? coveredOf(config.highSerial) : 'unknown',
      lowCovered: config.lowSerial ? coveredOf(config.lowSerial) : 'unknown',
      highDataAgeS: ageS(config.highSerial),
      lowDataAgeS: ageS(config.lowSerial),
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
    numField('maxDataAgeMs', 15_000, 600_000, 'maxDataAgeMs');
    numField('refreshWaitMs', 500, 15_000, 'refreshWaitMs');
    const nextMin = patch.minSpeed ?? config.minSpeed;
    const nextMax = patch.maxSpeed ?? config.maxSpeed;
    if (!(nextMin < nextMax)) throw new Error(`minSpeed (${nextMin}) muss kleiner als maxSpeed (${nextMax}) sein`);
    // Dasselbe Gerät darf nicht Hoch- UND Tief-Sensor sein: die zwei
    // Regelrichtungen bräuchten dann widersprüchliche Zustände desselben
    // Sensors — die Voll-Schutzrichtung wäre still tot.
    const nextHigh = patch.highSerial ?? config.highSerial;
    const nextLow = patch.lowSerial ?? config.lowSerial;
    if (nextHigh && nextLow && nextHigh === nextLow) {
      throw new Error('Hoch- und Tief-Sensor müssen zwei verschiedene Geräte sein');
    }
    if (patch.enabled === true && !(patch.pumpSerial ?? config.pumpSerial)) {
      throw new Error('Zum Aktivieren muss eine Pumpe (pumpSerial) konfiguriert sein');
    }
    return patch;
  }

  // Änderungen wirken sofort: check()/adjust() lesen die Config bei jedem Lauf.
  function applyConfig(patch) {
    Object.assign(config, patch);
    saveConfig();
    log(`  [autolevel] Konfiguration gespeichert: enabled=${config.enabled}, Pumpe=${config.pumpSerial || '—'}, Hoch=${config.highSerial || '—'}, Tief=${config.lowSerial || '—'}, Schritt=${config.stepPercent} %, Bereich=${config.minSpeed}–${config.maxSpeed} %, Cooldown=${config.cooldownS} s, maxDatenalter=${config.maxDataAgeMs} ms, Refresh-Warte=${config.refreshWaitMs} ms`);
    return { ...config };
  }

  return { onStateUpdate, check, payload, validateSubset, applyConfig };
}
