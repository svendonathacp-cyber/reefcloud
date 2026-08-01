import { useCallback, useEffect, useState } from 'react';
import type { CaptureFrame, DeviceSnapshot } from '@/types/reef';

// Zentrale Datenquelle der reefcloud-UI: pollt die JSON-API der reef-cloud-v2
// (direkt auf Port 8080 oder im Dev-Betrieb über den Vite-Proxy).
export function useReef(pollMs = 4000) {
  const [devices, setDevices] = useState<DeviceSnapshot[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [captureOn, setCaptureOnState] = useState(false);
  const [frames, setFrames] = useState<CaptureFrame[]>([]);

  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch('/api/devices');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setDevices(j.devices ?? []);
      setNow(j.now ?? Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  return { devices, now, error, captureOn, frames, sendCommand, setCapture };
}
