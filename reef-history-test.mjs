// reef-history-test.mjs — Tests für das SQLite-Zeitreihen-Modul.
// Läuft mit: node reef-history-test.mjs   (Test-DB im Temp-Verzeichnis)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openHistory, sqliteAvailable } from './reef-history.mjs';

if (!sqliteAvailable) {
  console.error('node:sqlite nicht verfügbar — History-Tests übersprungen (Node zu alt?)');
  process.exit(2);
}

const tmp = path.join(os.tmpdir(), `reef-history-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + suffix); } catch {} }

let passed = 0;
function ok(name) { passed++; console.log(`OK   ${name}`); }

const T0 = 1_800_000_000_000; // fester Zeitanker (ms)
const h = openHistory(tmp, { minIntervalMs: 60_000 });

// ---------- record: Dedupe & Drosselung ----------
assert.equal(h.record('RFTEST1', 'temperatureC', 25.4, { ts: T0 }), true);
ok('record: erster Punkt wird geschrieben');

assert.equal(h.record('RFTEST1', 'temperatureC', 25.5, { ts: T0 + 5_000 }), false);
ok('record: kontinuierlich < minInterval wird gedrosselt');

assert.equal(h.record('RFTEST1', 'temperatureC', 25.6, { ts: T0 + 60_000 }), true);
ok('record: nach minInterval wird wieder geschrieben');

assert.equal(h.record('RFTEST1', 'covered', 1, { discrete: true, ts: T0 + 10_000 }), true);
assert.equal(h.record('RFTEST1', 'covered', 1, { discrete: true, ts: T0 + 20_000 }), false);
assert.equal(h.record('RFTEST1', 'covered', 0, { discrete: true, ts: T0 + 30_000 }), true);
ok('record: diskret speichert nur Wertänderungen (Flanken)');

assert.equal(h.record('RFTEST1', 'covered', 0, { discrete: true, ts: T0 + 30_000 + 3_600_000 }), true);
ok('record: diskret schreibt spätestens nach Heartbeat-Zeit erneut');

assert.equal(h.record('RFTEST1', 'bad', null, { ts: T0 }), false);
assert.equal(h.record('RFTEST1', 'bad', NaN, { ts: T0 }), false);
assert.equal(h.record('RFTEST1', 'bad', 'abc', { ts: T0 }), false);
ok('record: ungültige Werte (null/NaN/String) werden verworfen');

// ---------- query: Rohpunkte ----------
const raw = h.query('RFTEST1', 'temperatureC', T0, T0 + 60_000);
assert.equal(raw.length, 2);
assert.equal(raw[0].value, 25.4);
assert.equal(raw[1].value, 25.6);
ok('query: Rohpunkte in Reihenfolge mit Werten');

// ---------- query: Bucket-Aggregation ----------
for (let i = 0; i < 10; i++) h.record('RFTEST2', 'speed', i * 10, { ts: T0 + i * 60_000 });
const buckets = h.query('RFTEST2', 'speed', T0, T0 + 600_000, 300);
assert.ok(buckets.length >= 2 && buckets.length <= 3);
const all = h.query('RFTEST2', 'speed', T0, T0 + 600_000);
const avgAll = all.reduce((a, p) => a + p.value, 0) / all.length;
const avgBuckets = buckets.reduce((a, p) => a + p.value, 0) / buckets.length;
assert.ok(Math.abs(avgAll - avgBuckets) < 5, `Mittelwerte driftet: ${avgAll} vs ${avgBuckets}`);
ok(`query: ${all.length} Rohpunkte → ${buckets.length} AVG-Buckets (Mittelwert stimmt)`);

// ---------- metrics ----------
const met = h.metrics();
const t1 = met.find((m) => m.serial === 'RFTEST1' && m.metric === 'temperatureC');
assert.ok(t1 && t1.points >= 2 && t1.firstTs === T0);
ok('metrics: Übersicht mit Punktzahl und Zeitspanne');

// ---------- events: Ereignis-Log (Autolevel-Muster) ----------
assert.equal(h.recordEvent({ ts: T0, kind: 'autolevel', serial: 'RFLS01', reason: 'tooFull', oldValue: 60, newValue: 59 }), true);
assert.equal(h.recordEvent({ ts: T0 + 60_000, kind: 'autolevel', serial: 'RFLS02', reason: 'staleData' }), true);
assert.equal(h.recordEvent({ ts: T0 + 120_000, kind: 'other', reason: 'x' }), true);
assert.equal(h.recordEvent({ kind: 'autolevel' }), false); // ohne ts
assert.equal(h.recordEvent(null), false);
ok('events: recordEvent validiert und speichert');

const evts = h.queryEvents('autolevel', { fromMs: 0, toMs: T0 + 700_000, limit: 50 });
assert.equal(evts.length, 2);
assert.equal(evts[0].reason, 'staleData'); // neueste zuerst
assert.equal(evts[0].oldValue, null);
assert.equal(evts[1].reason, 'tooFull');
assert.equal(evts[1].oldValue, 60);
assert.equal(evts[1].newValue, 59);
assert.equal(evts[1].serial, 'RFLS01');
ok('events: queryEvents liefert neueste zuerst mit alt/neu-Werten');

const evtsRange = h.queryEvents('autolevel', { fromMs: T0 + 30_000, toMs: T0 + 90_000 });
assert.equal(evtsRange.length, 1);
ok('events: Zeitfilter greift');

// ---------- prune ----------
const old = h.query('RFTEST2', 'speed', 0, T0 + 700_000).length;
assert.ok(old > 0);
const evBefore = h.queryEvents('autolevel', { fromMs: 0, toMs: T0 + 700_000 }).length;
const deleted = h.prune(T0 + 300_000);
assert.ok(deleted > 0);
const remaining = h.query('RFTEST2', 'speed', 0, T0 + 700_000);
assert.ok(remaining.length < old);
assert.ok(remaining.every((p) => p.ts >= T0 + 300_000));
const evAfter = h.queryEvents('autolevel', { fromMs: 0, toMs: T0 + 700_000 }).length;
assert.equal(evAfter, 0); // beide Events (T0, T0+60 s) sind älter als die Grenze
ok(`prune: ${deleted} Zeilen gelöscht (samples + events), Grenze eingehalten`);

// ---------- Reopen: Daten überleben ----------
h.close();
const h2 = openHistory(tmp, { minIntervalMs: 60_000 });
const after = h2.query('RFTEST2', 'speed', 0, T0 + 700_000);
assert.equal(after.length, remaining.length);
ok('persistenz: Punkte überleben close/open (SQLite-Datei)');
h2.close();

for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + suffix); } catch {} }
console.log(`\nAlle History-Tests bestanden (${passed} Gruppen)`);
