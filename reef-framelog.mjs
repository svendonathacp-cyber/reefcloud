// reef-framelog — immer-aktives, persistentes Frame-Log mit Rotation plus
// Auto-Dumps für Live-Frames. Motivation: Debugging bisher über journalctl +
// Konsolen-Throttling — periodische Frames wurden zusammengefasst, Payloads
// gar nicht geloggt, und nach einem Restart war alles weg. Hier landet JEDER
// Frame (außer pingTime-Rauschen) als eigene Zeile mit vollem Hex-Payload in
// einer rotierenden Datei — lesbar für Mensch und Kimi, ohne Raten.
//
//   logs/frames.log        aktuelles Log (eine Zeile pro Frame)
//   logs/frames.1.log ..   ältere Rotationen (maxFiles, älteste fällt weg)
//   dumps/live/GERAET_<cls>_<method>_<serial>.bin
//                          neuester Rohframe je (cls, method, serial) — baut
//                          das Replay-/Parser-Wissen automatisch auf, statt
//                          manuelle Capture-Sessions zu brauchen
//
// Sicherheit: Login-Frames (user/login, geConnect/login) werden weder gedumpt
// noch mit Hex-Payload geloggt — sie enthalten Account-E-Mail + Key. Das
// Konsolen-Log maskiert den Key bereits; Log und Dumps halten dasselbe Niveau.
//
// Schreibweise: synchron (appendFileSync/renameSync) — Frames sind klein und
// das Volumen moderat; dafür kein verlorener Frame beim Crash und kein
// async-Aufräumproblem beim Shutdown.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB je Datei
const DEFAULT_MAX_FILES = 3;                // frames.log + 2 Rotationen
const DUMP_MAX_BYTES = 256 * 1024;          // Riesenframes nicht dumpen

// Zeilenformat (Tab-getrennt, maschinenlesbar):
//   <iso-ts>\t<dir>\t<role>\t<peer>\t<cls>/<method>\tserial="<s>"\textra="<e>"\t<frameLen> B\t<hex>
export function createFrameLog({ dir, dumpDir = null, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES } = {}) {
  if (!dir) throw new Error('createFrameLog: dir fehlt');
  fs.mkdirSync(dir, { recursive: true });
  const liveDir = dumpDir ? path.join(dumpDir, 'live') : null;
  if (liveDir) fs.mkdirSync(liveDir, { recursive: true });
  const logFile = path.join(dir, 'frames.log');

  function rotate() {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? logFile : path.join(dir, `frames.${i - 1}.log`);
      const to = path.join(dir, `frames.${i}.log`);
      try { fs.renameSync(from, to); } catch { /* Datei existiert (noch) nicht */ }
    }
  }

  function logFrame({ ts = new Date(), direction, role, peer = '-', cls, method, serial = '', extra = '', frameBytes = 0, payload = null }) {
    if (cls === 'set' && method === 'pingTime') return; // 30-s-Rauschen aller Verbindungen
    // Login-Payloads (Account-E-Mail + Key) auch im Log NICHT als Hex ablegen —
    // das Konsolen-Log maskiert den Key bereits, hier gilt dasselbe Niveau.
    const sensitive = cls === 'user' || cls === 'geConnect';
    const hex = payload && !sensitive ? Buffer.from(payload).toString('hex') : '';
    const line = [
      ts.toISOString(), direction, role, peer,
      `${cls}/${method}`, `serial="${serial}"`, `extra="${extra}"`, `${frameBytes} B`, hex,
    ].join('\t') + '\n';
    try {
      if (maxBytes > 0 && fs.existsSync(logFile) && fs.statSync(logFile).size + line.length > maxBytes) rotate();
      fs.appendFileSync(logFile, line);
    } catch { /* Log-Versagen darf den Frame-Fluss nie stören */ }
  }

  // Rohframe je (cls, method, serial) nach dumps/live/ sichern — neuester
  // Inhalt gewinnt, identische Inhalte werden nicht erneut geschrieben.
  // Dateiname ohne Timestamp: genau EIN aktuelles Sample je Frame-Art.
  function dumpFrame(buf, { cls, method, serial = '' }) {
    if (!liveDir || !buf || !cls || !method) return null;
    if (cls === 'user' || cls === 'geConnect') return null; // Login: Account-Daten — nie dumpen
    if (cls === 'set' && method === 'pingTime') return null;
    if (buf.length > DUMP_MAX_BYTES) return null;
    const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(liveDir, `GERAET_${safe(cls)}_${safe(method)}_${safe(serial || 'ohne-serial')}.bin`);
    try {
      let prev = null;
      try { prev = fs.readFileSync(file); } catch { /* neu */ }
      if (prev && prev.equals(buf)) return null; // unverändert — Platte schonen
      fs.writeFileSync(file, buf);
      return file;
    } catch { return null; }
  }

  return { logFrame, dumpFrame, logFile, liveDir };
}
