import { useCallback, useEffect, useState } from 'react';
import type { CaptureFrame, DeviceSnapshot } from '@/types/reef';

// Zentrale Datenquelle der reefcloud-UI: pollt die JSON-API der reef-cloud-v2
// (direkt auf Port 8080 oder im Dev-Betrieb über den Vite-Proxy).
export function useReef(pollMs = 4000) {
  const [devices, setDevices] = useState<DeviceSnapshot[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  const [tunnel, setTunnel] = useState<{ connected: boolean; url?: string }>({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // bis zur ersten (erfolglosen oder erfolgreichen) Antwort
  const [captureOn, setCaptureOnState] = useState(false);
  const [frames, setFrames] = useState<CaptureFrame[]>([]);

  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch('/api/devices');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setDevices(j.devices ?? []);
      setNow(j.now ?? Date.now());
      setTunnel(j.tunnel ?? { connected: false });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCapture = useCallback(async () => {
    try {
      const r = await fetch('/api/capture');
      if (!r.ok) return;
      const j = await r.json();
      setCaptureOnState(!!j.capture);
      setFrames(j.frames ?? []);
    } catch { /* Capture ist optional */ }
  }, []);

  useEffect(() => {
    loadDevices();
    const t = setInterval(loadDevices, pollMs);
    return () => clearInterval(t);
  }, [loadDevices, pollMs]);

  useEffect(() => {
    loadCapture();
    const t = setInterval(loadCapture, 3000);
    return () => clearInterval(t);
  }, [loadCapture]);

  const sendCommand = useCallback(async (serial: string, action: string, params: Record<string, unknown> = {}) => {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serial, action, params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    setTimeout(loadDevices, 400); // State zeitnah nachladen
  }, [loadDevices]);

  const setCapture = useCallback(async (on: boolean) => {
    const r = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    if (r.ok) {
      setCaptureOnState(on);
      setTimeout(loadCapture, 300);
    }
  }, [loadCapture]);

  const setNickname = useCallback(async (serial: string, name: string) => {
    const r = await fetch('/api/devices/name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serial, name }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok !== true) throw new Error(j.error || `HTTP ${r.status}`);
    // Sofort lokal spiegeln, damit Kachel/Detail ohne Poll-Verzögerung reagieren
    setDevices((ds) => ds.map((d) => (d.serial === serial ? { ...d, customName: name || undefined } : d)));
    setTimeout(loadDevices, 600); // Server-Stand zeitnah nachladen
  }, [loadDevices]);

  // Geräte-Eigenschaften (Level-Sensor: Alarm-Richtung über/unter).
  // Server leitet covered sofort neu ab — hier lokal gespiegelt, damit die
  // Anzeige ohne Poll-Verzögerung umspringt.
  const setDeviceProps = useCallback(async (serial: string, alarmWhen: 'above' | 'below') => {
    const r = await fetch('/api/devices/props', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serial, alarmWhen }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok !== true) throw new Error(j.error || `HTTP ${r.status}`);
    setDevices((ds) => ds.map((d) => {
      if (d.serial !== serial) return d;
      const alarm = d.state.alarm;
      const covered = alarm === true || alarm === false
        ? (alarmWhen === 'above' ? alarm : !alarm)
        : d.state.covered;
      return { ...d, alarmWhen, state: { ...d.state, covered } };
    }));
    setTimeout(loadDevices, 600);
  }, [loadDevices]);

  return { devices, now, tunnel, error, loading, captureOn, frames, sendCommand, setCapture, setNickname, setDeviceProps };
}
