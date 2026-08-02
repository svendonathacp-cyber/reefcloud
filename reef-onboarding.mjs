// reef-onboarding — Serverseitiger WLAN-Scan fürs Geräte-Onboarding.
// Browser können kein WLAN scannen; der Scan läuft daher auf dem Host:
//   Windows:  netsh wlan show networks mode=bssid
//   Linux/Pi: nmcli -t -f SSID,SIGNAL dev wifi   (Fallback: iwlist scan)
// Sicherheit: Kommandos und Argumente sind statisch — es wird NIEMALS
// Nutzereingabe in die Kommandozeile interpoliert (execFile ohne Shell).
// Der Server kann auch per LAN angebunden sein und gar keinen WLAN-Adapter
// haben — Fehler werden als klare Meldung nach oben gereicht, nicht als Crash.

import { execFile } from 'node:child_process';

const SCAN_TIMEOUT_MS = 10_000;

// Heuristik: typische SSID-Muster von Reef-Factory-Geräten (bzw. deren
// ESP-Chips) im AP-/Einlern-Modus. Die echten Muster sind nicht sicher
// bekannt — daher nur KENNZEICHNEN, niemals filtern.
const RF_SSID_PATTERNS = ['rf', 'reef', 'thermocontrol', 'esp_'];
export function looksLikeRfDevice(ssid) {
  const s = String(ssid || '').trim().toLowerCase();
  if (!s) return false;
  return RF_SSID_PATTERNS.some((p) => s.startsWith(p));
}

// execFile-Hülle: statisches Kommando, Timeout, Ausgabe als Buffer —
// netsh liefert auf Nicht-US-Windows OEM/ANSI-Codepages, kein UTF-8.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', timeout: SCAN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (err.killed || err.code === 'ETIMEDOUT') {
          reject(new Error(`WLAN-Scan abgebrochen: Zeitüberschreitung nach ${SCAN_TIMEOUT_MS / 1000} s`));
        } else if (err.code === 'ENOENT') {
          reject(new Error(`Kommando "${cmd}" nicht gefunden`));
        } else {
          reject(new Error(`${cmd} fehlgeschlagen: ${err.message}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
}

// Best-Effort-Dekodierung: erst striktes UTF-8, sonst windows-1252
// (netsh auf deutschem Windows liefert typischerweise CP850/CP1252-Bytes).
export function decodeOutput(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// netsh wlan show networks mode=bssid
// Aufbau: "SSID 1 : <name>"-Blöcke, darunter BSSID-Zeilen mit "Signal : 87 %".
// Lokalisierte Windows-Versionen variieren ("Signal" ist auf Deutsch gleich,
// Schlüsselwort wird großzügig gematcht).
export function parseNetsh(text) {
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    // \S als erstes Zeichen: versteckte Netze ("SSID 4 : <leer>") überspringen
    const mSsid = line.match(/^\s*SSID\s+\d+\s*:\s*(\S.*?)\s*$/i);
    if (mSsid) {
      current = { ssid: mSsid[1], signal: null };
      out.push(current);
      continue;
    }
    const mSig = line.match(/Signal\s*:\s*(\d{1,3})\s*%/i);
    if (mSig && current) {
      const v = Math.min(100, Math.max(0, Number(mSig[1])));
      current.signal = current.signal === null ? v : Math.max(current.signal, v);
    }
  }
  return out;
}

// nmcli -t -f SSID,SIGNAL dev wifi
// Terse-Modus: "<ssid>:<signal>", Doppelpunkte in der SSID sind als "\:" escaped.
export function parseNmcli(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^(.*):(\d{1,3})\s*$/);
    if (!m) continue;
    const ssid = m[1].replace(/\\:/g, ':').trim();
    if (!ssid) continue; // versteckte Netze (leere SSID) überspringen
    out.push({ ssid, signal: Math.min(100, Math.max(0, Number(m[2]))) });
  }
  return out;
}

// iwlist scan (Fallback ohne NetworkManager):
// 'ESSID:"<name>"' + 'Quality=70/94' bzw. 'Signal level=-42 dBm'
export function parseIwlist(text) {
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const mSsid = line.match(/ESSID:"([^"]*)"/);
    if (mSsid) {
      current = mSsid[1].trim() ? { ssid: mSsid[1].trim(), signal: null } : null;
      if (current) out.push(current);
      continue;
    }
    if (!current) continue;
    const mQ = line.match(/Quality=(\d+)\/(\d+)/);
    if (mQ && Number(mQ[2]) > 0) {
      current.signal = Math.min(100, Math.max(0, Math.round((Number(mQ[1]) / Number(mQ[2])) * 100)));
      continue;
    }
    const mDbm = line.match(/Signal level=(-?\d+)\s*dBm/);
    // dBm grob auf % mappen: -100 dBm ≈ 0 %, -50 dBm ≈ 100 %
    if (mDbm) current.signal = Math.min(100, Math.max(0, 2 * (Number(mDbm[1]) + 100)));
  }
  return out;
}

// Doppelte SSIDs (mehrere BSSIDs/APs) zusammenführen: stärkstes Signal gewinnt.
function dedupe(networks) {
  const bySsid = new Map();
  for (const n of networks) {
    const prev = bySsid.get(n.ssid);
    if (!prev || (n.signal ?? -1) > (prev.signal ?? -1)) bySsid.set(n.ssid, n);
  }
  return [...bySsid.values()]
    .map((n) => ({ ssid: n.ssid, signal: n.signal, rfLike: looksLikeRfDevice(n.ssid) }))
    .sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

// Scannt die am Host sichtbaren WLANs. Rückgabe:
//   [{ ssid, signal: 0..100|null, rfLike: bool }]  (nach Signal absteigend)
// Wirft einen Fehler mit verständlicher Meldung, wenn kein Scan möglich ist
// (kein WLAN-Adapter, Server per LAN angebunden, Tools fehlen, Timeout).
export async function scanWifiNetworks() {
  if (process.platform === 'win32') {
    const buf = await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid']);
    const networks = dedupe(parseNetsh(decodeOutput(buf)));
    if (!networks.length) throw new Error('Keine WLAN-Netze gefunden — hat der Server einen WLAN-Adapter?');
    return networks;
  }
  if (process.platform === 'linux') {
    try {
      const buf = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL', 'dev', 'wifi']);
      const networks = dedupe(parseNmcli(decodeOutput(buf)));
      if (networks.length) return networks;
      // nmcli lief ohne Fehler, fand aber nichts → echter Scan ohne Treffer
      return [];
    } catch (e) {
      // Fallback: iwlist (Systeme ohne NetworkManager). Scan braucht i. d. R.
      // root-Rechte — Fehlermeldung entsprechend formulieren.
      try {
        const buf = await run('iwlist', ['scan']);
        const networks = dedupe(parseIwlist(decodeOutput(buf)));
        if (networks.length) return networks;
        throw new Error('iwlist fand keine WLAN-Netze');
      } catch (e2) {
        throw new Error(`WLAN-Scan nicht möglich (nmcli: ${e.message}; iwlist: ${e2.message}) — hat der Server einen WLAN-Adapter?`);
      }
    }
  }
  throw new Error(`WLAN-Scan wird auf dieser Plattform (${process.platform}) nicht unterstützt`);
}
