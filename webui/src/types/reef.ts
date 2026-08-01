// reefcloud Web-UI — Typen, gespiegelt zur JSON-API von reef-cloud-v2 (Port 8080)

export interface DeviceSnapshot {
  serial: string;
  name?: string | null;
  ip: string;
  family: string;
  firmware: string | null;
  online: boolean;
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
