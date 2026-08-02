// Isolierte Tests des Updaters (Status-Parsing, behind=0 vs. >0, Fehlerpfade,
// Install-Guard), OHNE echte git-Kommandos — execFile wird komplett gemockt.
// Aufruf:
//   node reef-updater-test.mjs
// (Muster reef-autolevel-test.mjs: alle Abhängigkeiten werden gefakt injiziert.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater } from './reef-updater.mjs';

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

// Gefaktes execFile: Antworten je Kommandozeile aus einer Map.
//   { 'git fetch --quiet origin': { stdout: '' } }
//   { 'git fetch --quiet origin': { error: new Error('…'), stderr: '…' } }
// Unbekannte Kommandos → Fehler (damit keine stillen Durchläufer entstehen).
// calls = Liste aller aufgerufenen Kommandozeilen (Reihenfolge = Aufrufreihenfolge).
function makeExecFile(responses) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const r = responses[key];
    if (!r) {
      cb(new Error(`nicht gemockt: ${key}`), '', '');
      return;
    }
    if (r.pending) return; // nie zurückrufen → simuliert einen hängenden Prozess
    if (r.error) cb(r.error, r.stdout ?? '', r.stderr ?? '');
    else cb(null, r.stdout ?? '', r.stderr ?? '');
  };
  return { execFile, calls };
}

function makeDir(withGit = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
  if (withGit) fs.mkdirSync(path.join(dir, '.git')); // Existenz genügt (detectSupport prüft nur das)
  return dir;
}

// Standard-Welt: git ok, behind=2, aktueller Hash abc1234
function makeUpdater(responses, opts = {}) {
  const dir = opts.dir ?? makeDir(true);
  const { execFile, calls } = makeExecFile({
    'git --version': { stdout: 'git version 2.43.0' },
    'git fetch --quiet origin': { stdout: '' },
    'git rev-list --count HEAD..origin/main': { stdout: '2\n' },
    'git rev-parse --short HEAD': { stdout: 'abc1234\n' },
    'git log -1 --format=%s origin/main': { stdout: 'Neues Feature\n' },
    'git pull --ff-only': { stdout: 'Updating abc1234..def5678\n' },
    'npm install --omit=dev --no-audit --no-fund': { stdout: 'up to date\n' },
    ...responses,
  });
  const updater = createUpdater({
    dir, log: () => {}, execFile, schedule: false,
    autoRestart: opts.autoRestart ?? false,
    // plattformunabhängig mocken (Windows würde sonst npm-cli.js mit node starten)
    npmCall: { cmd: 'npm', args: ['install', '--omit=dev', '--no-audit', '--no-fund'] },
  });
  return { updater, calls, dir };
}

// --- 1) Status-Parsing: behind > 0 → alle Felder belegt ---
{
  const { updater } = makeUpdater();
  const st = await updater.check();
  check('behind>0: supported/current/behind', [st.supported, st.current, st.behind], [true, 'abc1234', 2]);
  check('behind>0: latestMsg + kein Fehler', [st.latestMsg, st.error], ['Neues Feature', '']);
  check('behind>0: lastCheck gesetzt, nichts läuft', [st.lastCheck > 0, st.checking, st.updating], [true, false, false]);
}

// --- 2) behind = 0 → „aktuell", kein latestMsg ---
{
  const { updater } = makeUpdater({ 'git rev-list --count HEAD..origin/main': { stdout: '0\n' } });
  const st = await updater.check();
  check('behind=0: behind und latestMsg', [st.behind, st.latestMsg], [0, '']);
  check('behind=0: supported bleibt true, kein Fehler', [st.supported, st.error], [true, '']);
}

// --- 3) Fehlerpfad Netz: fetch schlägt fehl → error im Status, kein Wurf ---
{
  const { updater } = makeUpdater({
    'git fetch --quiet origin': { error: new Error('exit 128'), stderr: 'fatal: unable to connect' },
  });
  const st = await updater.check(); // muss durchlaufen, darf nicht werfen
  check('fetch-Fehler: supported true (git prinzipiell da)', st.supported, true);
  check('fetch-Fehler: stderr-Zeile im error', /unable to connect/.test(st.error), true);
  check('fetch-Fehler: behind unverändert 0', st.behind, 0);
}

// --- 4) Kein .git-Verzeichnis → supported:false mit Grund ---
{
  const { updater } = makeUpdater({}, { dir: makeDir(false) });
  const st = await updater.check();
  check('kein .git: supported false', st.supported, false);
  check('kein .git: Grund im Status', /\.git/.test(st.reason), true);
}

// --- 5) git nicht im PATH → supported:false ---
{
  const { updater, calls } = makeUpdater({
    'git --version': { error: new Error('spawn git ENOENT') },
  });
  const st = await updater.check();
  check('git fehlt: supported false', st.supported, false);
  check('git fehlt: Grund benennt git', /git/.test(st.reason), true);
  check('git fehlt: kein fetch versucht', calls.includes('git fetch --quiet origin'), false);
}

// --- 6) Install-Guard: behind = 0 → Fehler, kein pull ---
{
  const { updater, calls } = makeUpdater({ 'git rev-list --count HEAD..origin/main': { stdout: '0\n' } });
  await updater.check();
  let msg = '';
  try { await updater.install(); } catch (e) { msg = e.message; }
  check('install behind=0: Fehler „kein Update"', /behind = 0/.test(msg), true);
  check('install behind=0: kein git pull aufgerufen', calls.includes('git pull --ff-only'), false);
}

// --- 7) Install-Guard: paralleler install → „läuft bereits" ---
{
  const { updater } = makeUpdater({ 'git pull --ff-only': { pending: true } });
  await updater.check();
  const first = updater.install(); // hängt im gemockten pull
  await new Promise((r) => setTimeout(r, 0)); // eine Runde warten, bis updating gesetzt ist
  check('install parallel: updating-Flag gesetzt', updater.status().updating, true);
  let msg = '';
  try { await updater.install(); } catch (e) { msg = e.message; }
  check('install parallel: zweiter Aufruf abgelehnt', /läuft bereits/.test(msg), true);
  void first.catch(() => {}); // hängender Mock — nie auflösen, nur Fehler schlucken
}

// --- 8) Install-Erfolg: pull + npm in Reihenfolge, restarting/antwort ---
{
  const { updater, calls } = makeUpdater({}, { autoRestart: true });
  await updater.check();
  const res = await updater.install();
  check('install ok: Antwort', res, { ok: true, restarting: true, autoRestart: true });
  const pullIdx = calls.indexOf('git pull --ff-only');
  const npmIdx = calls.indexOf('npm install --omit=dev --no-audit --no-fund');
  check('install ok: pull vor npm', pullIdx >= 0 && npmIdx > pullIdx, true);
  check('install ok: behind danach 0', updater.status().behind, 0);
}

// --- 9) pull schlägt fehl (lokaler Dreck) → Fehler durchgereicht, npm NICHT ---
{
  const { updater, calls } = makeUpdater({
    'git pull --ff-only': { error: new Error('exit 1'), stderr: 'error: Your local changes would be overwritten by merge.' },
  });
  await updater.check();
  let msg = '';
  try { await updater.install(); } catch (e) { msg = e.message; }
  check('pull-Fehler: Meldung durchgereicht', /local changes/.test(msg), true);
  check('pull-Fehler: npm nicht aufgerufen', calls.includes('npm install --omit=dev --no-audit --no-fund'), false);
  check('pull-Fehler: updating zurückgesetzt', updater.status().updating, false);
}

// --- 10) autoRestart-Flag: injiziert statt aus env ---
{
  const a = makeUpdater({}, { autoRestart: true });
  const b = makeUpdater({}, { autoRestart: false });
  check('autoRestart injiziert', [a.updater.status().autoRestart, b.updater.status().autoRestart], [true, false]);
}

// --- 11) Timeout-Fehler (err.killed) → verständliche Meldung ---
{
  const { updater } = makeUpdater({
    'git fetch --quiet origin': { error: Object.assign(new Error('killed'), { killed: true }) },
  });
  const st = await updater.check();
  check('Timeout: Timeout-Meldung im error', /Timeout nach 30 s/.test(st.error), true);
}

console.log(failures ? `\n${failures} Test(s) FEHLGESCHLAGEN` : '\nAlle Updater-Tests bestanden');
process.exit(failures ? 1 : 0);
