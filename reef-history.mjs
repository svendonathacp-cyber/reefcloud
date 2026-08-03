// reef-history.mjs — Zeitreihen-History aller Geräte-Metriken in SQLite
// (node:sqlite, eingebaut seit Node 22.5 — keine native Dependency, ideal
// für den Pi: eine Datei, WAL-Modus, kein Dienst).
//
// Datenmodell: samples(ts INTEGER ms, serial TEXT, metric TEXT, value REAL).
// Metriken kommen aus dem Geräte-State (Temperatur, Salinität, Doser-Füllstände,
// Pumpen-Speeds, Sensor-Zustände …) — die Zuordnung State→Metrik steht im
// Server (HISTORY_EXTRACTORS), nicht hier.
//
// Schreib-Drosselung: kontinuierliche Metriken (Temperatur …) werden höchstens
// alle minIntervalMs gespeichert; diskrete Metriken (Sensor-Zustände,
// Alarme, Status-Codes) zusätzlich sofort bei jeder Wertänderung (Flanken
// sind das eigentlich Interessante). Abruf mit serverseitiger Bucket-
// Aggregation (AVG), damit die UI auch über 30 Tage performant bleibt.

import { createRequire } from 'node:module';

// node:sqlite ist in Node ≥ 22.13 ohne Flag verfügbar (22.5–22.12 brauchen
// --experimental-sqlite). Fehlt das Modul, ist die History deaktiviert —
// der Server läuft dann einfach ohne Aufzeichnung weiter (klare Log-Meldung).
const require = createRequire(import.meta.url);
let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { /* nicht verfügbar */ }
export const sqliteAvailable = DatabaseSync !== null;

const DEFAULT_MIN_INTERVAL_MS = 60_000;   // 1 Punkt/Minute je kontinuierlicher Metrik
const HEARTBEAT_MS = 3_600_000;           // diskrete Metriken: spätestens 1 Punkt/Stunde

export class HistoryUnavailableError extends Error {
  constructor() {
    super('node:sqlite nicht verfügbar (Node < 22.5? SQLite-Support fehlt) — History deaktiviert');
    this.code = 'SQLITE_UNAVAILABLE';
  }
}

// openHistory(dbPath, { minIntervalMs }) → History-Instanz.
// Wirft HistoryUnavailableError, wenn node:sqlite fehlt.
export function openHistory(dbPath, { minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
  if (!DatabaseSync) throw new HistoryUnavailableError();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER NOT NULL,
    serial TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_samples ON samples (serial, metric, ts)');
  // Ereignisse (diskrete Aktionen mit Grund, z. B. Autolevel-Eingriffe):
  // passt nicht ins Metrik-Schema (Grund + alt/neu), aber unter dieselbe
  // Retention-Regel (prune löscht beide Tabellen).
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    serial TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    oldValue REAL,
    newValue REAL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_events ON events (kind, ts)');

  const ins = db.prepare('INSERT INTO samples (ts, serial, metric, value) VALUES (?, ?, ?, ?)');
  const del = db.prepare('DELETE FROM samples WHERE ts < ?');
  const delEvents = db.prepare('DELETE FROM events WHERE ts < ?');
  const insEvent = db.prepare('INSERT INTO events (ts, kind, serial, reason, oldValue, newValue) VALUES (?, ?, ?, ?, ?, ?)');
  const eventsStmt = db.prepare(
    'SELECT ts, kind, serial, reason, oldValue, newValue FROM events WHERE kind = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?');
  const rawStmt = db.prepare(
    'SELECT ts, value FROM samples WHERE serial = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 20000');
  const bucketStmt = db.prepare(
    `SELECT (ts - (ts % ?)) AS b, AVG(value) AS v FROM samples
     WHERE serial = ? AND metric = ? AND ts >= ? AND ts <= ?
     GROUP BY b ORDER BY b`);
  const metricsStmt = db.prepare(
    `SELECT serial, metric, COUNT(*) AS points, MIN(ts) AS firstTs, MAX(ts) AS lastTs
     FROM samples GROUP BY serial, metric ORDER BY serial, metric`);

  // Schreib-Dedupe: serial|metric → letzter geschriebener Punkt
  const lastWritten = new Map();

  // record(serial, metric, value, { discrete, ts }): value muss eine endliche
  // Zahl sein (Booleans vorher in 0/1 wandeln; null/NaN/Strings werden
  // verworfen — Number(null) wäre sonst irreführend 0). discrete=true →
  // sofort bei Wertänderung schreiben (Heartbeat HEARTBEAT_MS), sonst
  // minIntervalMs.
  function record(serial, metric, value, { discrete = false, ts = Date.now() } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const v = value;
    const key = `${serial}|${metric}`;
    const last = lastWritten.get(key);
    if (last) {
      const due = ts - last.ts >= (discrete ? HEARTBEAT_MS : minIntervalMs);
      const changed = v !== last.value;
      if (!due && !(discrete && changed)) return false;
    }
    ins.run(ts, serial, metric, v);
    lastWritten.set(key, { ts, value: v });
    return true;
  }

  // query(serial, metric, fromMs, toMs, bucketSec = 0):
  // bucketSec > 0 → AVG-Buckets (ts = Bucket-Start via ts - ts%step, weil
  // gebundene REAL-Parameter die Ganzzahl-Division unterlaufen würden);
  // 0 → Rohpunkte.
  function query(serial, metric, fromMs, toMs, bucketSec = 0) {
    if (bucketSec > 0) {
      const step = Math.round(bucketSec) * 1000;
      return bucketStmt.all(step, serial, metric, fromMs, toMs)
        .map((r) => ({ ts: Number(r.b), value: Math.round(Number(r.v) * 1000) / 1000 }));
    }
    return rawStmt.all(serial, metric, fromMs, toMs)
      .map((r) => ({ ts: Number(r.ts), value: Number(r.value) }));
  }

  // metrics(): Übersicht aller aufgezeichneten Seriennummern/Metriken
  function metrics() {
    return metricsStmt.all().map((r) => ({
      serial: r.serial, metric: r.metric,
      points: Number(r.points), firstTs: Number(r.firstTs), lastTs: Number(r.lastTs),
    }));
  }

  // recordEvent({ ts, kind, serial, reason, oldValue, newValue }): diskretes
  // Ereignis speichern (z. B. Autolevel-Eingriff). oldValue/newValue optional.
  function recordEvent(evt) {
    if (!evt || !Number.isFinite(evt.ts) || typeof evt.kind !== 'string' || !evt.kind) return false;
    const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    insEvent.run(
      Math.round(evt.ts), evt.kind,
      typeof evt.serial === 'string' ? evt.serial : '',
      typeof evt.reason === 'string' ? evt.reason : '',
      numOrNull(evt.oldValue), numOrNull(evt.newValue),
    );
    return true;
  }

  // queryEvents(kind, { fromMs, toMs, limit }): neueste zuerst
  function queryEvents(kind, { fromMs = 0, toMs = Date.now(), limit = 100 } = {}) {
    return eventsStmt.all(kind, fromMs, toMs, Math.max(1, Math.min(1000, Math.round(limit))))
      .map((r) => ({
        ts: Number(r.ts), kind: r.kind, serial: r.serial, reason: r.reason,
        oldValue: r.oldValue === null ? null : Number(r.oldValue),
        newValue: r.newValue === null ? null : Number(r.newValue),
      }));
  }

  // prune(olderThanMs) → Anzahl gelöschter Zeilen (samples + events)
  function prune(olderThanMs) {
    return Number(del.run(olderThanMs).changes) + Number(delEvents.run(olderThanMs).changes);
  }

  function close() { db.close(); }

  return { record, query, metrics, recordEvent, queryEvents, prune, close };
}
