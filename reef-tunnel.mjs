// reef-tunnel.mjs — Ausgehender WebSocket-Tunnel zum WebOS-Server (donath-home.de)
// Protokoll (JSON über wss), identisch zum bisherigen reef-bridge-Tunnel (NAS):
//   Server→Pi:  {"id":"<uuid>","type":"request","method":"…","params":{…}}
//   Pi→Server:  {"id":"<uuid>","type":"response","ok":true,"data":…} | {"ok":false,"error":"…"}
//   Pi→Server:  {"type":"event","event":"device","data":<deviceSnapshot>}  (unaufgefordert)
// Verhalten: Reconnect mit Backoff (1 s → max 60 s); nach jedem Connect
// vollständiger Re-Announce aller Snapshots (Server-Cache ist sonst leer).
import WebSocket from 'ws';

export function startTunnel({ url, token, log, getSnapshots, handleRequest }) {
  let ws = null;
  let backoff = 1000;
  let stopped = false;
  const queue = []; // Events, die vor dem ersten Connect anfallen

  const tlog = (...a) => log(`  [tunnel] ${a.join(' ')}`);

  function sendEvent(snapshot) {
    const msg = JSON.stringify({ type: 'event', event: 'device', data: snapshot });
    if (ws && ws.readyState === ws.OPEN) ws.send(msg);
    else queue.push(msg);
  }

  function connect() {
    if (stopped) return;
    tlog(`verbinde mit ${url} …`);
    ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });

    ws.on('open', () => {
      tlog('✅ verbunden — Re-Announce aller Geräte');
      backoff = 1000;
      try {
        for (const snap of getSnapshots()) sendEvent(snap);
        while (queue.length) ws.send(queue.shift());
      } catch (e) { tlog(`!! Re-Announce-Fehler: ${e.message}`); }
    });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { tlog('!! ungültiges JSON vom Server'); return; }
      if (msg.type !== 'request') { tlog(`?? Nachricht type=${msg.type}: ${data.toString('utf8').slice(0, 200)}`); return; }
      const respond = (ok, dataOrErr) => {
        const out = ok ? { id: msg.id, type: 'response', ok: true, data: dataOrErr }
                       : { id: msg.id, type: 'response', ok: false, error: String(dataOrErr) };
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(out));
      };
      try {
        tlog(`>> request ${msg.method} ${JSON.stringify(msg.params || {}).slice(0, 160)}`);
        const result = await handleRequest(msg.method, msg.params || {});
        respond(true, result ?? { ok: true });
      } catch (e) {
        tlog(`!! ${msg.method} fehlgeschlagen: ${e.message}`);
        respond(false, e.message);
      }
    });

    ws.on('close', (code, reason) => {
      tlog(`getrennt (code=${code} ${reason}) — Reconnect in ${backoff / 1000} s`);
      ws = null;
      if (!stopped) setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    ws.on('error', (e) => tlog(`Fehler: ${e.message}`));
  }

  connect();
  return {
    sendEvent,
    isConnected: () => !!(ws && ws.readyState === 1),
    stop() { stopped = true; try { ws?.close(); } catch {} },
  };
}
