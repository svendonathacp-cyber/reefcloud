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

// Onboarding: serverseitiger WLAN-Scan, gespiegelt zu GET /api/onboarding/scan.
export interface OnboardingNetwork {
  ssid: string;
  signal: number | null; // 0..100, null = unbekannt
  rfLike: boolean; // Heuristik: sieht nach RF-Gerät im AP-Modus aus
}

export interface OnboardingScanResponse {
  networks: OnboardingNetwork[];
  error?: string; // gesetzt, wenn der Scan am Host nicht möglich war
  scannedAt: number; // Epoch-ms
}

// Ablaufschacht-Stabilisierung, gespiegelt zu GET/POST /api/autolevel.
export interface AutolevelConfig {
  enabled: boolean;
  pumpSerial: string;
  highSerial: string;
  lowSerial: string;
  stepPercent: number;
  minSpeed: number;
  maxSpeed: number;
  cooldownS: number;
}

export type AutolevelReason = 'alarmHigh' | 'alarmLow';

export interface AutolevelHistoryEntry {
  ts: number; // Epoch-ms
  reason: AutolevelReason;
  sensorSerial: string;
  oldSpeed: number;
  newSpeed: number;
}

export interface AutolevelStatus {
  running: boolean;
  lastActionTs: number;
  currentSpeed: number | null;
  pumpOnline: boolean;
  highState: string; // 'ok' | 'alarmLow' | 'alarmHigh' | 'unknown'
  lowState: string;
  cooldownS: number;
  cooldownRemainingS?: { up: number; down: number };
}

export interface AutolevelResponse {
  config: AutolevelConfig;
  status: AutolevelStatus;
  history: AutolevelHistoryEntry[];
}

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
