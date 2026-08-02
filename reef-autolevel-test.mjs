// Isolierte Tests der Autolevel-Regelung (covered-Semantik, Frische-Gate,
// Priorisierung), OHNE einen Server zu starten. Aufruf:
//   node reef-autolevel-test.mjs
// Alle Abhängigkeiten werden gefakt injiziert (Muster reef-onboarding-test).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutolevel, AUTOLEVEL_DEFAULTS } from './reef-autolevel.mjs';

const PUMP = 'RFBP000000000001';
const HIGH = 'RFLS000000000046'; // Sensor oben
const LOW = 'RFLS000000000020';  // Sensor unten

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

// Welt-Factory: metaFor/devices/encodeFrame gefakt; sent = gesendete Frames
// je Serial, enc = alle encodeFrame-Aufrufe (Reihenfolge = Sendereihenfolge).
function makeWorld() {
  const meta = new Map();
  const metaFor = (serial) => {
    if (!meta.has(serial)) meta.set(serial, { state: {}, lastLsDataTs: 0 });
    return meta.get(serial);
  };
  const sent = [];
  const enc = [];
  const devices = new Map();
  const mkWs = (serial) => ({
    readyState: 1, OPEN: 1,
    send: (buf) => sent.push({ serial, buf: Buffer.from(buf).toString('latin1') }),
  });
  const setOnline = (serial, on = true) => { if (on) devices.set(serial, mkWs(serial)); else devices.delete(serial); };
  const encodeFrame = (cls, method, payload, serial, extra = '') => {
    enc.push({ cls, method, serial, extra });
    return Buffer.from(JSON.stringify({ cls, method, serial, payload }), 'latin1');
  };
  const buildCommandFrame = (serial, action, params) => ['bpSet', action, [...Buffer.from(JSON.stringify(params), 'latin1')]];
  return { metaFor, devices, sent, enc, setOnline, encodeFrame, buildCommandFrame };
}

function makeAutolevel(world, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autolevel-test-'));
  const al = createAutolevel({
    dir, log: () => {},
    metaFor: world.metaFor, devices: world.devices,
    buildCommandFrame: world.buildCommandFrame,
    encodeFrame: world.encodeFrame,
    captureFrame: () => {},
  });
  al.applyConfig({
    enabled: true, pumpSerial: PUMP, highSerial: HIGH, lowSerial: LOW,
    stepPercent: 1, minSpeed: 1, maxSpeed: 100, cooldownS: 60,
    maxDataAgeMs: 1_000, refreshWaitMs: 400, // kleine Werte für schnelle Tests
    ...patch,
  });
  return al;
}

// Standardwelt: beide Sensoren + Pumpe online, frische Daten, Normalbereich
function freshWorld() {
  const w = makeWorld();
  w.setOnline(PUMP); w.setOnline(HIGH); w.setOnline(LOW);
  w.metaFor(PUMP).state = { speed: 50 };
  const now = Date.now();
  w.metaFor(HIGH).lastLsDataTs = now;
  w.metaFor(LOW).lastLsDataTs = now;
  w.metaFor(HIGH).state = { covered: false };
  w.metaFor(LOW).state = { covered: true };
  return w;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1) Normalbereich: unten covered, oben nicht → kein Eingriff ---
{
  const w = freshWorld();
  const al = makeAutolevel(w);
  await al.check();
  check('Normalbereich: kein Frame an die Pumpe', w.enc.filter((e) => e.cls === 'bpSet').length, 0);
  check('Normalbereich: History leer', al.payload().history.length, 0);
}

// --- 2) Schacht zu voll (oben covered=true) → 1 % RUNTER ---
{
  const w = freshWorld();
  w.metaFor(HIGH).state = { covered: true };
  const al = makeAutolevel(w);
  await al.check();
  const sets = w.enc.filter((e) => e.cls === 'bpSet');
  check('zu voll: genau ein setSpeed', sets.length, 1);
  check('zu voll: neuer Speed 49 %', w.metaFor(PUMP).state.speed, 49);
  check('zu voll: History-Grund tooFull', al.payload().history[0]?.reason, 'tooFull');
  check('zu voll: History-Speeds', [al.payload().history[0]?.oldSpeed, al.payload().history[0]?.newSpeed], [50, 49]);
}

// --- 3) Schacht zu leer (unten covered=false) → 1 % RAUF ---
{
  const w = freshWorld();
  w.metaFor(LOW).state = { covered: false };
  const al = makeAutolevel(w);
  await al.check();
  check('zu leer: neuer Speed 51 %', w.metaFor(PUMP).state.speed, 51);
  check('zu leer: History-Grund tooEmpty', al.payload().history[0]?.reason, 'tooEmpty');
}

// --- 4) Priorisierung: beide Alarmlagen gleichzeitig → „zu voll" gewinnt ---
{
  const w = freshWorld();
  w.metaFor(HIGH).state = { covered: true };  // zu voll
  w.metaFor(LOW).state = { covered: false };  // UND zu leer (widersprüchlich)
  const al = makeAutolevel(w);
  await al.check();
  check('Priorisierung: runter vor rauf', w.metaFor(PUMP).state.speed, 49);
  check('Priorisierung: History-Grund tooFull', al.payload().history[0]?.reason, 'tooFull');
}

// --- 5) Unbekannte Codes → kein Aktionismus ---
{
  const w = freshWorld();
  w.metaFor(HIGH).state = { covered: 'unknown' };
  w.metaFor(LOW).state = { covered: 'unknown' };
  const al = makeAutolevel(w);
  await al.check();
  check('unknown: kein Eingriff', w.enc.filter((e) => e.cls === 'bpSet').length, 0);
}

// --- 6) Frische-Gate: stale → lsConnect/join → frische Frames → entscheiden ---
{
  const w = freshWorld();
  // Beide Sensoren stale (letzter Datenframe 60 s alt)
  w.metaFor(HIGH).lastLsDataTs = Date.now() - 60_000;
  w.metaFor(LOW).lastLsDataTs = Date.now() - 60_000;
  const al = makeAutolevel(w);
  // Frische Frames kommen 150 ms nach dem Join herein (live: <1 s)
  setTimeout(() => {
    w.metaFor(HIGH).lastLsDataTs = Date.now();
    w.metaFor(LOW).lastLsDataTs = Date.now();
    w.metaFor(HIGH).state = { covered: true }; // Schacht läuft voll
  }, 150);
  await al.check();
  const joins = w.enc.filter((e) => e.cls === 'lsConnect' && e.method === 'join');
  check('Gate: lsConnect/join an beide stale Sensoren', joins.map((j) => j.serial).sort(), [HIGH, LOW].sort());
  check('Gate: join_-Tag im extra-Feld', joins.every((j) => /^join_\d+$/.test(j.extra)), true);
  const firstSet = w.enc.findIndex((e) => e.cls === 'bpSet');
  const lastJoin = w.enc.map((e, i) => (e.cls === 'lsConnect' ? i : -1)).filter((i) => i >= 0).pop();
  check('Gate: Refresh VOR dem Eingriff', firstSet > lastJoin && firstSet >= 0, true);
  check('Gate: nach frischen Daten wird entschieden (49 %)', w.metaFor(PUMP).state.speed, 49);
}

// --- 7) Frische-Gate: stale, keine Antwort → überspringen, kein Fehler ---
{
  const w = freshWorld();
  w.metaFor(HIGH).lastLsDataTs = Date.now() - 60_000;
  w.metaFor(LOW).lastLsDataTs = Date.now() - 60_000;
  const al = makeAutolevel(w);
  await al.check(); // wartet refreshWaitMs (400 ms), dann Skip
  check('stale: kein Eingriff', w.enc.filter((e) => e.cls === 'bpSet').length, 0);
  check('stale: Refresh wurde trotzdem versucht', w.enc.filter((e) => e.cls === 'lsConnect').length, 2);
  check('stale: History-Grund staleData', al.payload().history[0]?.reason, 'staleData');
}

// --- 8) Offline-Sensoren: direkt überspringen, kein Join ---
{
  const w = freshWorld();
  w.setOnline(HIGH, false);
  w.setOnline(LOW, false);
  w.metaFor(HIGH).lastLsDataTs = Date.now() - 60_000;
  w.metaFor(LOW).lastLsDataTs = Date.now() - 60_000;
  const t0 = Date.now();
  const al = makeAutolevel(w);
  await al.check();
  check('offline: sofort übersprungen (<200 ms)', Date.now() - t0 < 200, true);
  check('offline: kein lsConnect/join gesendet', w.enc.filter((e) => e.cls === 'lsConnect').length, 0);
  check('offline: History-Grund staleData', al.payload().history[0]?.reason, 'staleData');
}

// --- 9) Cooldown: zweiter Lauf direkt danach passt nicht erneut an ---
{
  const w = freshWorld();
  w.metaFor(HIGH).state = { covered: true };
  const al = makeAutolevel(w);
  await al.check();
  await al.check();
  check('Cooldown: nur ein Eingriff', w.enc.filter((e) => e.cls === 'bpSet').length, 1);
  check('Cooldown: Speed bleibt 49 %', w.metaFor(PUMP).state.speed, 49);
}

// --- 10) Clamp am Anschlag: kein Eingriff, keine History ---
{
  const w = freshWorld();
  w.metaFor(PUMP).state = { speed: 1 }; // minSpeed
  w.metaFor(HIGH).state = { covered: true };
  const al = makeAutolevel(w);
  await al.check();
  check('Clamp: kein Eingriff am Anschlag', w.enc.filter((e) => e.cls === 'bpSet').length, 0);
  check('Clamp: Speed bleibt 1 %', w.metaFor(PUMP).state.speed, 1);
}

// --- 11) Config-Migration: alte autolevel.json ohne Frische-Felder → Defaults ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autolevel-test-'));
  fs.writeFileSync(path.join(dir, 'autolevel.json'), JSON.stringify({
    enabled: true, pumpSerial: PUMP, highSerial: HIGH, lowSerial: LOW, stepPercent: 2,
  }));
  const w = makeWorld();
  const al = createAutolevel({
    dir, log: () => {}, metaFor: w.metaFor, devices: w.devices,
    buildCommandFrame: w.buildCommandFrame, encodeFrame: w.encodeFrame, captureFrame: () => {},
  });
  const cfg = al.payload().config;
  check('Migration: maxDataAgeMs-Default', cfg.maxDataAgeMs, AUTOLEVEL_DEFAULTS.maxDataAgeMs);
  check('Migration: refreshWaitMs-Default', cfg.refreshWaitMs, AUTOLEVEL_DEFAULTS.refreshWaitMs);
  check('Migration: alte Felder übernommen', [cfg.stepPercent, cfg.pumpSerial], [2, PUMP]);
}

// --- 12) validateSubset: neue Felder validiert ---
{
  const w = makeWorld();
  const al = makeAutolevel(w);
  const fam = () => 'levelSensor';
  check('validate: maxDataAgeMs ok', al.validateSubset({ maxDataAgeMs: 120_000 }, fam), { maxDataAgeMs: 120_000 });
  let threw = '';
  try { al.validateSubset({ maxDataAgeMs: 5_000 }, fam); } catch (e) { threw = e.message; }
  check('validate: maxDataAgeMs zu klein → Fehler', /maxDataAgeMs/.test(threw), true);
  threw = '';
  try { al.validateSubset({ refreshWaitMs: 100 }, fam); } catch (e) { threw = e.message; }
  check('validate: refreshWaitMs zu klein → Fehler', /refreshWaitMs/.test(threw), true);
}

// --- 13) status(): covered-Sicht + Datenalter ---
{
  const w = freshWorld();
  w.metaFor(HIGH).state = { covered: true };
  const al = makeAutolevel(w);
  const st = al.payload().status;
  check('status: highCovered/lowCovered', [st.highCovered, st.lowCovered], [true, true]);
  check('status: Datenalter in Sekunden vorhanden', typeof st.highDataAgeS === 'number' && st.highDataAgeS >= 0, true);
}

console.log(failures ? `\n${failures} Test(s) FEHLGESCHLAGEN` : '\nAlle Autolevel-Tests bestanden');
process.exit(failures ? 1 : 0);
