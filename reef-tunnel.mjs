// reef-tunnel.mjs — Ausgehender WebSocket-Tunnel zu einem externen Server (z. B. WebOS)
// Protokoll (JSON über wss), identisch zum bisherigen reef-bridge-Tunnel (NAS):
//   Server→Pi:  {"id":"<uuid>","type":"request","method":"…","params":{…}}
//   Pi→Server:  {"id":"<uuid>","type":"response","ok":true,"data":…} | {"ok":false,"error":"…"}
//   Pi→Server:  {"type":"event","event":"device","data":<deviceSnapshot>}  (unaufgefordert)
// Verhalten: Reconnect mit Backoff (1 s → max 60 s); nach jedem Connect
// vollständiger Re-Announce aller Snapshots (Server-Cache ist sonst leer).
import WebSocket from 'ws';

export function startTunnel({ url, token, log, getSnapshots, handleRequest, WebSocketClass = WebSocket }) {
  let ws = null;
  let backoff = 1000;
  let stopped = false;
  let reconnectTimer = null;

  const tlog = (...a) => log(`  [tunnel] ${a.join(' ')}`);

  function sendEvent(snapshot) {
    if (stopped) return;
    const msg = JSON.stringify({ type: 'event', event: 'device', data: snapshot });
    if (ws && ws.readyState === ws.OPEN) ws.send(msg);
    // Kein Offline-Puffer: getSnapshots liefert beim nächsten open den
    // vollständigen aktuellen Stand. Alte Events würden ihn überschreiben.
  }

  function connect() {
    if (stopped) return;
    tlog(`verbinde mit ${url} …`);
    const socket = new WebSocketClass(url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
      maxPayload: 1 * 1024 * 1024,
    });
    ws = socket;

    socket.on('open', () => {
      if (stopped || ws !== socket) return;
      tlog('✅ verbunden — Re-Announce aller Geräte');
      backoff = 1000;
      try {
        for (const snap of getSnapshots()) sendEvent(snap);
      } catch (e) { tlog(`!! Re-Announce-Fehler: ${e.message}`); }
    });

    socket.on('message', async (data) => {
      if (stopped || ws !== socket) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { tlog('!! ungültiges JSON vom Server'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.type !== 'request') {
        tlog('!! ungültiger Request vom Server'); return;
      }
      const respond = (ok, dataOrErr) => {
        const out = ok ? { id: msg.id, type: 'response', ok: true, data: dataOrErr }
                       : { id: msg.id, type: 'response', ok: false, error: String(dataOrErr) };
        // Eine verspätete Antwort gehört ausschließlich zur ursprünglichen
        // Verbindung; niemals in eine neue Server-Session senden.
        if (!stopped && ws === socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
      };
      try {
        if (typeof msg.id !== 'string' || !msg.id || typeof msg.method !== 'string' || !msg.method) {
          throw new Error('Request benötigt id und method als nichtleere Strings');
        }
        if (msg.params != null && (typeof msg.params !== 'object' || Array.isArray(msg.params))) {
          throw new Error('Request params muss ein Objekt sein');
        }
        tlog(`>> request ${msg.method}`);
        const result = await handleRequest(msg.method, msg.params || {});
        respond(true, result ?? { ok: true });
      } catch (e) {
        tlog(`!! ${msg.method} fehlgeschlagen: ${e.message}`);
        respond(false, e.message);
      }
    });

    socket.on('close', (code, reason) => {
      if (ws !== socket) return;
      ws = null;
      if (stopped) return;
      if (code === 4000) tlog('!! Verbindung ersetzt: konkurrierende Tunnel-Instanz prüfen');
      tlog(`getrennt (code=${code} ${reason}) — Reconnect in ${backoff / 1000} s`);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    socket.on('error', (e) => tlog(`Fehler: ${e.message}`));
  }

  connect();
  return {
    sendEvent,
    isConnected: () => !!(ws && ws.readyState === 1),
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const socket = ws;
      ws = null;
      try { socket?.close(); } catch {}
    },
  };
}
