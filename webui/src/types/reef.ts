// reefcloud Web-UI — Typen, gespiegelt zur JSON-API von reef-cloud-v2 (Port 8080)

export interface DeviceSnapshot {
  serial: string;
  name?: string | null;
  customName?: string; // vom Nutzer vergebener Spitzname (optional, POST /api/devices/name)
  ip: string;
  family: string;
  firmware: string | null;
  online: boolean;
  reachable?: boolean; // per TCP erreichbar, auch wenn nicht eingeloggt (Hello-Ping)
  state: Record<string, unknown>;
  lastSeen: number; // Epoch-ms
}

export interface DevicesResponse {
  devices: DeviceSnapshot[];
  now: number;
  tank?: string | null;
  tunnel?: { connected: boolean; url?: string };
}

export interface CaptureFrame {
  ts: number; // Epoch-ms
  serial: string;
  hex: string;
  direction?: 'in' | 'out';
  class?: string;
  method?: string;
  payloadUtf8?: string;
}

export interface CaptureResponse {
  capture: boolean;
  frames: CaptureFrame[];
}

export type CommandFn = (serial: string, action: string, params?: Record<string, unknown>) => Promise<void>;
export type SetNicknameFn = (serial: string, name: string) => Promise<void>;

// Flare-Lichtprogramm (24h-Kurven), gespiegelt zu GET/POST /api/program.
// t = Minute des Tages (0..1440), l = 7 Kanäle (0..1): UV, Violett, Indigo, Blau, Grün, Rot, Weiß
export interface FlareProgramPoint {
  t: number;
  l: number[];
}

export interface FlareProgram {
  name: string;
  intensity: number; // Gesamtintensität 0..100 %
  points: FlareProgramPoint[];
}
