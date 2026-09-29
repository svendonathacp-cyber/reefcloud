// Isolierte Tunnel-Vertragstests: keine externen Verbindungen oder Geräte.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startTunnel } from './reef-tunnel.mjs';

class FakeSocket extends EventEmitter {
  static instances = [];
  OPEN = 1;
  readyState = 0;
  sent = [];
  constructor(url, options) {
    super();
    this.options = options;
    FakeSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.emit('open'); }
  close(code = 1000) { this.readyState = 3; this.emit('close', code, ''); }
  request(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}

let snapshots = [{ serial: 'TEST-PUMP', online: true, state: { speed: 50, mode: 'auto' }, lastSeen: 1000 }];
const logs = [];
let finishSlow;
const tunnel = startTunnel({
  url: 'wss://example.invalid/api/reef/tunnel', token: 'test-only-token',
  log: (line) => logs.push(line), getSnapshots: () => snapshots,
  WebSocketClass: FakeSocket,
  handleRequest: async (method) => {
    if (method === 'listDevices') return snapshots;
    if (method === 'slow') return new Promise((resolve) => { finishSlow = resolve; });
    throw new Error('unknown method');
  },
});

try {
  const first = FakeSocket.instances[0];
  assert.equal(first.options.headers.authorization, 'Bearer test-only-token');
  // Alte Events vor dem Connect dürfen den aktuellen Stand nicht überschreiben.
  tunnel.sendEvent({ ...snapshots[0], state: { speed: 10 } });
  first.open();
  assert.deepEqual(first.sent, [{ type: 'event', event: 'device', data: snapshots[0] }]);
  assert.equal(tunnel.isConnected(), true);
  console.log('OK Auth-Header und vollständiger aktueller Snapshot beim Connect');

  first.request({ id: 'read-1', type: 'request', method: 'listDevices' });
  first.request({ id: 'error-1', type: 'request', method: 'missing' });
  first.request(null);
  first.request({ id: 'bad-1', type: 'request', method: 'listDevices', params: [] });
  await delay(0);
  assert.deepEqual(first.sent.find((m) => m.id === 'read-1'), { id: 'read-1', type: 'response', ok: true, data: snapshots });
  assert.equal(first.sent.find((m) => m.id === 'error-1').ok, false);
  assert.equal(first.sent.find((m) => m.id === 'bad-1').ok, false);
  console.log('OK korrelierte Erfolgs-/Fehlerantworten und ungültige Nachrichten');

  first.request({ id: 'old-session', type: 'request', method: 'slow' });
  first.close(4000);
  assert.equal(tunnel.isConnected(), false);
  snapshots = [{ ...snapshots[0], online: false, state: { speed: 60, mode: 'auto' }, lastSeen: 2000 }];
  for (let i = 0; i < 1000; i++) tunnel.sendEvent({ ...snapshots[0], state: { speed: i } });
  await delay(1100);
  const second = FakeSocket.instances[1];
  assert.ok(second, 'Reconnect erzeugt neue Verbindung');
  second.open();
  assert.deepEqual(second.sent, [{ type: 'event', event: 'device', data: snapshots[0] }]);
  finishSlow({ ok: true });
  await delay(0);
  assert.equal(second.sent.some((m) => m.id === 'old-session'), false);
  assert.ok(logs.some((line) => line.includes('konkurrierende Tunnel-Instanz')));
  console.log('OK Reconnect mit Offline-Snapshot, ohne alte Events oder fremde Antworten');

  snapshots = [{ ...snapshots[0], online: true, lastSeen: 3000 }];
  tunnel.sendEvent(snapshots[0]);
  assert.deepEqual(second.sent.at(-1).data, snapshots[0]);
  second.close();
  tunnel.stop();
  tunnel.sendEvent(snapshots[0]);
  await delay(1100);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(tunnel.isConnected(), false);
  console.log('OK Online-Wechsel und Stop während ausstehendem Reconnect');
} finally {
  tunnel.stop();
}

console.log('Alle Tunnel-Tests bestanden');
