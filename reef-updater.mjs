// reef-updater — Auto-Update über das Git-Repo.
//
// Konzept: der Server prüft täglich, ob origin/main neuer ist als der lokale
// Stand. Ein Update wird NIE automatisch installiert — die UI zeigt
// „Update verfügbar" und fragt „Update installieren?".
//
// Update-Check: git fetch --quiet origin (Timeout 30 s), dann
//   git rev-list --count HEAD..origin/main   → behind
//   git rev-parse --short HEAD               → current
//   git log -1 --format=%s origin/main       → latestMsg
// Alle Kommandos laufen über execFile OHNE shell und mit statischen Args
// (keine String-Interpolation → keine Command-Injection-Fläche), cwd ist das
// Server-Verzeichnis (injiziert als dir).
//
// Taktung: einmal ~2 min nach Serverstart, dann alle 24 h (Timer unref'd).
// Zusätzlich manuell per POST /api/update/check triggerbar.
//
// Fehlertolerant: kein git, kein .git, kein Netz → Status mit
// supported:false bzw. gesetztem error statt Exception; Fehler werden
// geloggt, aber nie geworfen (check() gibt immer den Status zurück).
//
// install(): NUR wenn behind > 0: git pull --ff-only (schlägt bei lokalem
// Dreck fehl → Fehlermeldung wird durchgereicht, NIEMALS reset/checkout
// --force), dann npm install --omit=dev --no-audit --no-fund (webui/dist ist
// committed, kein Build nötig). Danach antwortet der Endpoint
// { ok:true, restarting:true, autoRestart } und beendet den Prozess ~1 s
// später — unter systemd (Restart=always in deploy/reef-cloud.service)
// kommt der Server mit neuem Code zurück. Das Modul selbst ruft
// process.exit NICHT auf (bleibt isoliert testbar); das übernimmt der
// Endpoint in reef-cloud-v2.mjs.
//
// autoRestart-Erkennung: process.env.INVOCATION_ID wird nur von systemd
// gesetzt → false auf Windows-Dev (die UI sagt dann „bitte manuell neu
// starten"). Für Tests injizierbar.
//
// Das Modul ist bewusst entkoppelt: alle Abhängigkeiten werden injiziert,
// damit die Logik isoliert testbar ist (kein Import von reef-cloud-v2,
// Tests: reef-updater-test.mjs — execFile wird dort gemockt, es laufen
// KEINE echten git-Kommandos).

import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';

export const UPDATER_DEFAULTS = {
  startDelayMs: 2 * 60_000,       // erster Check ~2 min nach Serverstart
  intervalMs: 24 * 3_600_000,     // danach alle 24 h
  cmdTimeoutMs: 30_000,           // fetch/rev-list/rev-parse/log
  pullTimeoutMs: 60_000,          // git pull --ff-only
  npmTimeoutMs: 120_000,          // npm install --omit=dev …
};

export function createUpdater({
  dir, log, execFile = nodeExecFile,
  schedule = true, defaults = UPDATER_DEFAULTS,
  autoRestart = !!process.env.INVOCATION_ID, // systemd-Setzung; Dev: false
  npmCall = null, // { cmd, args } — injizierbar für Tests; null = Auto-Erkennung
}) {
  const cfg = { ...defaults };
  // npm OHNE shell aufrufen. Auf Windows ist npm ein .cmd-Wrapper, den Node
  // (≥ 18.20.2 / 20.12.2, Batch-Datei-CVE-Härtung) per execFile nicht mehr
  // starten darf (spawn EINVAL) → dort npm-cli.js direkt mit dem laufenden
  // node-Binary ausführen. Auf dem Pi (Linux) heißt es schlicht „npm".
  const NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  const npm = npmCall ?? (() => {
    if (process.platform !== 'win32') return { cmd: 'npm', args: NPM_ARGS };
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return fs.existsSync(cli)
      ? { cmd: process.execPath, args: [cli, ...NPM_ARGS] }
      : { cmd: 'npm.cmd', args: NPM_ARGS }; // Fallback — klare Fehlermeldung
  })();
  // supported: null = noch unbekannt, true/false nach detectSupport()
  let supported = null;
  let unsupportedReason = '';
  let current = '';      // Short-Hash des lokalen HEAD
  let behind = 0;        // Commits, die origin/main voraus ist
  let latestMsg = '';    // Betreff des neuesten Commits auf origin/main
  let lastCheck = 0;     // Zeitstempel des letzten Check-Versuchs
  let lastError = '';    // Fehlermeldung des letzten Checks ('' = ok)
  let checking = false;  // Reentrancy-Guard
  let updating = false;  // Install-Guard (409-artig)

  // Ein Kommando ausführen: execFile ohne shell, cwd=dir, Timeout.
  // Fehler werden auf die erste stderr-Zeile gekürzt (verständliche UI-Texte).
  function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd: dir, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || '').trim().split('\n')[0]
            || (err.killed ? `Timeout nach ${timeoutMs / 1000} s` : err.message);
          reject(new Error(`${cmd} ${args.join(' ')} fehlgeschlagen: ${detail}`));
          return;
        }
        resolve(String(stdout).trim());
      });
    });
  }

  // Einmalig prüfen, ob Auto-Update hier überhaupt möglich ist:
  // .git-Verzeichnis vorhanden UND git im PATH. Ergebnis wird gecacht.
  async function detectSupport(force = false) {
    if (supported !== null && !force) return supported;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      supported = false;
      unsupportedReason = 'kein .git-Verzeichnis im Server-Verzeichnis';
      return supported;
    }
    try {
      await run('git', ['--version'], cfg.cmdTimeoutMs);
      supported = true;
      unsupportedReason = '';
    } catch {
      supported = false;
      unsupportedReason = 'git nicht gefunden (nicht installiert oder nicht im PATH)';
    }
    return supported;
  }

  // Update-Status gegen origin/main ermitteln. Wirft NIEMALS — Fehler landen
  // im Status (error) und im Log. Gibt immer den aktuellen Status zurück.
  async function check() {
    // Der 24-h-Timer darf einen laufenden Pull nicht stören (Race check↔install)
    if (updating) return status();
    if (checking) return status(); // kein überlappender Lauf (manuell + Timer)
    checking = true;
    try {
      if (!(await detectSupport())) {
        lastCheck = Date.now();
        lastError = unsupportedReason;
        log(`  [updater] Update-Check übersprungen: ${unsupportedReason}`);
        return status();
      }
      await run('git', ['fetch', '--quiet', 'origin'], cfg.cmdTimeoutMs);
      const behindOut = await run('git', ['rev-list', '--count', 'HEAD..origin/main'], cfg.cmdTimeoutMs);
      behind = Number.parseInt(behindOut, 10);
      if (!Number.isFinite(behind) || behind < 0) behind = 0;
      current = await run('git', ['rev-parse', '--short', 'HEAD'], cfg.cmdTimeoutMs);
      latestMsg = behind > 0
        ? await run('git', ['log', '-1', '--format=%s', 'origin/main'], cfg.cmdTimeoutMs)
        : '';
      lastCheck = Date.now();
      lastError = '';
      log(behind > 0
        ? `  [updater] Update verfügbar: ${behind} Commit(s) hinter origin/main — ${latestMsg}`
        : '  [updater] Update-Check: auf dem neuesten Stand');
    } catch (e) {
      lastCheck = Date.now();
      lastError = e.message;
      log(`!! [updater] Update-Check fehlgeschlagen: ${e.message}`);
    } finally {
      checking = false;
    }
    return status();
  }

  // Update installieren: git pull --ff-only + npm install --omit=dev.
  // Wirft bei Fehlern (Endpoint reicht die Meldung an die UI durch).
  // Ruft bewusst NICHT process.exit() auf — der Endpoint antwortet erst
  // und beendet den Prozess dann selbst (systemd zieht ihn wieder hoch).
  async function install() {
    if (updating) throw new Error('Update läuft bereits');
    if (!(await detectSupport())) throw new Error(`Update nicht möglich: ${unsupportedReason}`);
    if (!(behind > 0)) throw new Error('Kein Update verfügbar (behind = 0)');
    updating = true;
    try {
      log(`  [updater] installiere Update (${behind} Commit(s) von origin/main)…`);
      // Explizit origin/main: exakt das ziehen, was der Check misst —
      // unabhängig vom konfigurierten Upstream des lokalen Branches.
      await run('git', ['pull', '--ff-only', 'origin', 'main'], cfg.pullTimeoutMs);
      log('  [updater] git pull ok — npm install läuft…');
      await run(npm.cmd, npm.args, cfg.npmTimeoutMs);
      log('  [updater] npm install ok — Neustart folgt (systemd: automatisch)');
      behind = 0; // Stand entspricht jetzt origin/main (bis zum Neustart)
      return { ok: true, restarting: true, autoRestart };
    } catch (e) {
      updating = false; // nur bei Fehler zurücksetzen — nach Erfolg endet der Prozess
      log(`!! [updater] Installation fehlgeschlagen: ${e.message}`);
      throw e;
    }
  }

  function status() {
    return {
      supported: supported === true,
      supportedKnown: supported !== null,
      reason: supported === false ? unsupportedReason : '',
      current,
      behind,
      latestMsg,
      lastCheck,
      checking,
      updating,
      autoRestart,
      error: lastError,
    };
  }

  // Taktung: erster Check ~2 min nach Start (Netzwerk/Dienste stehen dann),
  // danach alle 24 h. Beide Timer unref'd — sie halten den Prozess nicht
  // offen. Im Test (schedule:false) wird nichts getaktet.
  if (schedule) {
    const first = setTimeout(() => {
      void check();
      const iv = setInterval(() => void check(), cfg.intervalMs);
      iv.unref();
    }, cfg.startDelayMs);
    first.unref();
  }
  // Support-Erkennung sofort anstoßen, damit GET /api/update/status schon
  // vor dem ersten Check eine belastbare supported-Auskunft liefern kann.
  void detectSupport();

  return { check, install, status };
}
