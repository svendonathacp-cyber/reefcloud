import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Camera, CheckCircle2, Info, ListChecks,
  PartyPopper, RefreshCw, ScanSearch, Search, Server, Wifi,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/i18n/I18nContext';
import { deviceDisplayName } from '@/sections/DeviceCard';
import type { DeviceSnapshot, OnboardingNetwork, OnboardingScanResponse } from '@/types/reef';

// BarcodeDetector ist (noch) kein DOM-Standard-Typ — minimal nachdeklariert.
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => {
      detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
    };
  }
}

// Seriennummern: 2–4 Buchstaben Präfix + Ziffern (z. B. RFBP052311290012) —
// bewusst locker validiert (Hardware-Formate können variieren).
const SERIAL_RE = /^[A-Za-z]{2,4}\d{4,}$/;
const SERIAL_IN_TEXT_RE = /[A-Za-z]{2,4}\d{4,}/;

function extractSerial(text: string): string | null {
  const m = text.match(SERIAL_IN_TEXT_RE);
  return m ? m[0].toUpperCase() : null;
}

type QrError = 'unsupported' | 'https' | 'denied' | null;

interface FoundDevice {
  serial: string;
  isNew: boolean;
}

// ---------- SVG-Illustrationen (Stil angelehnt an guides/*.html) ----------
const SVG_FONT = { fontFamily: 'system-ui' } as const;

function IllustrationFrame({ label, children, height = 190 }: { label: string; children: React.ReactNode; height?: number }) {
  return (
    <svg viewBox={`0 0 320 ${height}`} role="img" aria-label={label} className="h-auto w-full max-w-80">
      <rect x="1" y="1" width="318" height={height - 2} rx="12" fill="#0b1220" stroke="#2c3f61" strokeWidth="2" />
      {children}
    </svg>
  );
}

function ApModeSvg({ label }: { label: string }) {
  return (
    <IllustrationFrame label={label}>
      {/* Gerät */}
      <rect x="40" y="55" width="110" height="90" rx="10" fill="#16223a" stroke="#4d7bd6" strokeWidth="2" />
      <rect x="52" y="67" width="86" height="40" rx="5" fill="#0b1220" stroke="#2c3f61" strokeWidth="1.5" />
      <text x="95" y="92" textAnchor="middle" fontSize="13" fill="#9fc1ff" {...SVG_FONT}>RF</text>
      {/* Reset-Taste */}
      <circle cx="95" cy="130" r="9" fill="#121c30" stroke="#ffd479" strokeWidth="2" />
      <circle cx="95" cy="130" r="3" fill="#ffd479" />
      {/* Finger, der drückt */}
      <rect x="88" y="146" width="14" height="34" rx="7" fill="#1a2740" stroke="#2c3f61" strokeWidth="1.5" />
      <path d="M95 146 L95 137" stroke="#ffd479" strokeWidth="2" strokeDasharray="3 3" />
      {/* blinkende LED */}
      <circle cx="140" cy="67" r="4" fill="#52d273" />
      <circle cx="140" cy="67" r="8" fill="none" stroke="#52d273" strokeWidth="1" opacity="0.6" />
      <circle cx="140" cy="67" r="12" fill="none" stroke="#52d273" strokeWidth="1" opacity="0.3" />
      {/* WLAN-Wellen */}
      <g fill="none" stroke="#52d273" strokeWidth="3" strokeLinecap="round">
        <path d="M205 120 a34 34 0 0 1 34 -34" opacity="0.4" />
        <path d="M205 108 a46 46 0 0 1 46 -46" opacity="0.6" />
        <path d="M205 96 a58 58 0 0 1 58 -58" opacity="0.85" />
      </g>
      <circle cx="205" cy="120" r="5" fill="#52d273" />
      <text x="245" y="160" textAnchor="middle" fontSize="11" fill="#8fa3c0" {...SVG_FONT}>AP</text>
    </IllustrationFrame>
  );
}

function ConnectWifiSvg({ label, homeWifi, neighborWifi }: { label: string; homeWifi: string; neighborWifi: string }) {
  return (
    <IllustrationFrame label={label}>
      {/* Handy */}
      <rect x="90" y="14" width="140" height="164" rx="14" fill="#1a2740" stroke="#2c3f61" strokeWidth="2" />
      <rect x="100" y="30" width="120" height="128" rx="6" fill="#0b1220" />
      <circle cx="160" cy="168" r="4" fill="#2c3f61" />
      {/* WLAN-Liste */}
      <text x="110" y="50" fontSize="11" fill="#9fc1ff" fontWeight="600" {...SVG_FONT}>Wi-Fi</text>
      <rect x="104" y="58" width="112" height="22" rx="5" fill="#16223a" />
      <text x="112" y="73" fontSize="10" fill="#8fa3c0" {...SVG_FONT}>{homeWifi}</text>
      <rect x="104" y="84" width="112" height="22" rx="5" fill="#0d2b1a" stroke="#52d273" strokeWidth="1.5" />
      <text x="112" y="99" fontSize="10" fill="#9fe8bd" {...SVG_FONT}>RF…-Setup</text>
      <path d="M206 91 l3 3 l5 -6" fill="none" stroke="#52d273" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="104" y="110" width="112" height="22" rx="5" fill="#16223a" />
      <text x="112" y="125" fontSize="10" fill="#8fa3c0" {...SVG_FONT}>{neighborWifi}</text>
      <text x="160" y="150" textAnchor="middle" fontSize="9" fill="#8fa3c0" {...SVG_FONT}>⋯</text>
    </IllustrationFrame>
  );
}

function ConfigureSvg({ label, ssidLine, passwordLine }: { label: string; ssidLine: string; passwordLine: string }) {
  return (
    <IllustrationFrame label={label}>
      {/* Browserfenster */}
      <rect x="30" y="20" width="180" height="150" rx="10" fill="#16223a" stroke="#2c3f61" strokeWidth="2" />
      <rect x="30" y="20" width="180" height="22" rx="10" fill="#1a2740" />
      <rect x="30" y="32" width="180" height="10" fill="#1a2740" />
      <circle cx="42" cy="31" r="3" fill="#2c3f61" />
      <circle cx="52" cy="31" r="3" fill="#2c3f61" />
      <text x="120" y="35" textAnchor="middle" fontSize="9" fill="#8fa3c0" {...SVG_FONT}>192.168.4.1</text>
      {/* Formular */}
      <rect x="44" y="52" width="152" height="18" rx="4" fill="#0b1220" stroke="#2c3f61" strokeWidth="1" />
      <text x="52" y="65" fontSize="9" fill="#8fa3c0" {...SVG_FONT}>{ssidLine}</text>
      <rect x="44" y="76" width="152" height="18" rx="4" fill="#0b1220" stroke="#2c3f61" strokeWidth="1" />
      <text x="52" y="89" fontSize="9" fill="#8fa3c0" {...SVG_FONT}>{passwordLine}</text>
      <rect x="44" y="100" width="152" height="18" rx="4" fill="#0b1220" stroke="#4d7bd6" strokeWidth="1.5" />
      <text x="52" y="113" fontSize="9" fill="#9fc1ff" {...SVG_FONT}>Server: reef-cloud</text>
      <rect x="44" y="128" width="80" height="20" rx="5" fill="#0d2b1a" stroke="#52d273" strokeWidth="1.5" />
      <text x="84" y="142" textAnchor="middle" fontSize="10" fill="#9fe8bd" {...SVG_FONT}>OK</text>
      {/* Pfeil zur Cloud */}
      <line x1="214" y1="95" x2="248" y2="95" stroke="#52d273" strokeWidth="2.5" markerEnd="url(#ob-arrow)" />
      <defs>
        <marker id="ob-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#52d273" />
        </marker>
      </defs>
      {/* Cloud */}
      <g fill="#1a2740" stroke="#4d7bd6" strokeWidth="2">
        <circle cx="272" cy="86" r="16" />
        <circle cx="290" cy="92" r="12" />
        <circle cx="258" cy="96" r="11" />
        <rect x="254" y="88" width="44" height="18" rx="9" stroke="none" />
      </g>
    </IllustrationFrame>
  );
}

function SearchSvg({ label, yourServer }: { label: string; yourServer: string }) {
  return (
    <IllustrationFrame label={label}>
      {/* Server */}
      <rect x="30" y="70" width="100" height="56" rx="8" fill="#16223a" stroke="#4d7bd6" strokeWidth="2" />
      <circle cx="44" cy="86" r="4" fill="#52d273" />
      <text x="90" y="90" textAnchor="middle" fontSize="11" fill="#9fc1ff" {...SVG_FONT}>reef-cloud</text>
      <text x="80" y="110" textAnchor="middle" fontSize="9" fill="#8fa3c0" {...SVG_FONT}>{yourServer}</text>
      {/* Gerät */}
      <rect x="220" y="76" width="70" height="44" rx="8" fill="#16223a" stroke="#2c3f61" strokeWidth="2" />
      <text x="255" y="102" textAnchor="middle" fontSize="11" fill="#9fc1ff" {...SVG_FONT}>RF</text>
      {/* Verbindungspfeil */}
      <line x1="216" y1="98" x2="134" y2="98" stroke="#52d273" strokeWidth="2.5" strokeDasharray="6 4" markerEnd="url(#ob-arrow2)" />
      <defs>
        <marker id="ob-arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#52d273" />
        </marker>
      </defs>
      {/* Lupe */}
      <circle cx="168" cy="52" r="18" fill="none" stroke="#ffd479" strokeWidth="3" />
      <line x1="181" y1="65" x2="194" y2="78" stroke="#ffd479" strokeWidth="4" strokeLinecap="round" />
      {/* Häkchen */}
      <circle cx="160" cy="152" r="14" fill="#0d2b1a" stroke="#52d273" strokeWidth="2" />
      <path d="M153 152 l5 5 l9 -10" fill="none" stroke="#52d273" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </IllustrationFrame>
  );
}

// ---------- Assistent ----------

const STEP_KEYS = [
  'onboarding.step.apMode',
  'onboarding.step.connectWifi',
  'onboarding.step.configure',
  'onboarding.step.search',
] as const;

interface Props {
  devices: DeviceSnapshot[]; // live gepollt durch useReef() in Home
  onDone: () => void;
  onOpenDevice: (serial: string) => void;
}

export default function OnboardingWizard({ devices, onDone, onOpenDevice }: Props) {
  const t = useT();
  const [step, setStep] = useState(0);

  // Seriennummer (optionaler Pfad: QR oder manuell)
  const [serialInput, setSerialInput] = useState('');
  const [serialTouched, setSerialTouched] = useState(false);
  const serial = useMemo(() => {
    const s = serialInput.trim().toUpperCase();
    return SERIAL_RE.test(s) ? s : null;
  }, [serialInput]);
  const serialInvalid = serialTouched && serialInput.trim().length > 0 && !serial;
  const knownDevice = useMemo(
    () => (serial ? devices.find((d) => d.serial.toUpperCase() === serial) ?? null : null),
    [devices, serial],
  );

  // QR-Scanner
  const [scanning, setScanning] = useState(false);
  const [qrError, setQrError] = useState<QrError>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const stop = () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    (async () => {
      const Detector = window.BarcodeDetector;
      if (!Detector) { setQrError('unsupported'); setScanning(false); return; }
      // getUserMedia braucht Secure Context (HTTPS/localhost) — die UI läuft
      // lokal oft über http://<lan-ip>:8080, dort ist die Kamera gesperrt.
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setQrError('https'); setScanning(false); return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        setQrError('denied'); setScanning(false); return;
      }
      if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
      const video = videoRef.current;
      if (video) { video.srcObject = stream; await video.play().catch(() => { /* Autoplay best effort */ }); }
      const detector = new Detector({ formats: ['qr_code'] });
      const tick = async () => {
        if (cancelled) return;
        try {
          const codes = video && video.readyState >= 2 ? await detector.detect(video) : [];
          const hit = codes.map((c) => extractSerial(c.rawValue)).find((s): s is string => !!s);
          if (hit) {
            setSerialInput(hit);
            setSerialTouched(true);
            toast.success(t('onboarding.qr.found', { serial: hit }));
            setScanning(false);
            return;
          }
        } catch { /* einzelner Frame ohne verwertbaren Treffer — weiter scannen */ }
        timer = window.setTimeout(() => void tick(), 400);
      };
      void tick();
    })();
    return stop;
  }, [scanning, t]);

  // Serverseitiger WLAN-Scan (Schritt 2)
  const [wifi, setWifi] = useState<{ networks: OnboardingNetwork[]; error: string | null } | null>(null);
  const [wifiLoading, setWifiLoading] = useState(false);
  const scanWifi = useCallback(async () => {
    setWifiLoading(true);
    try {
      const r = await fetch('/api/onboarding/scan');
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as OnboardingScanResponse;
      setWifi({ networks: j.networks ?? [], error: typeof j.error === 'string' ? j.error : null });
    } catch (e) {
      setWifi({ networks: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setWifiLoading(false);
    }
  }, []);
  useEffect(() => {
    if (step === 1 && !wifi && !wifiLoading) void scanWifi();
  }, [step, wifi, wifiLoading, scanWifi]);

  // Server-LAN-Adressen (Schritt 3) — gleiche Quelle wie der Setup-Wizard
  const [lanIps, setLanIps] = useState<{ name: string; address: string }[] | null>(null);
  useEffect(() => {
    if (step !== 2 || lanIps !== null) return;
    (async () => {
      try {
        const r = await fetch('/api/setup/status');
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { lanIps?: { name: string; address: string }[] };
        setLanIps(j.lanIps ?? []);
      } catch {
        setLanIps([]);
      }
    })();
  }, [step, lanIps]);

  // Gerät suchen (Schritt 4): devices-Prop wird von Home live gepollt.
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FoundDevice | null>(null);
  const [showTimeoutHint, setShowTimeoutHint] = useState(false);
  const baselineRef = useRef<Set<string> | null>(null);

  const startSearch = () => {
    baselineRef.current = new Set(devices.map((d) => d.serial));
    setFound(null);
    setShowTimeoutHint(false);
    setSearching(true);
  };

  useEffect(() => {
    if (!searching || found) return;
    const baseline = baselineRef.current ?? new Set<string>();
    if (serial) {
      const dev = devices.find((d) => d.serial.toUpperCase() === serial && d.online);
      if (dev) {
        setFound({ serial: dev.serial, isNew: !baseline.has(dev.serial) });
        setSearching(false);
      }
    } else {
      const dev = devices.find((d) => !baseline.has(d.serial));
      if (dev) {
        setFound({ serial: dev.serial, isNew: true });
        setSearching(false);
      }
    }
  }, [devices, searching, found, serial]);

  useEffect(() => {
    if (!searching) return;
    const timer = window.setTimeout(() => setShowTimeoutHint(true), 60_000);
    return () => window.clearTimeout(timer);
  }, [searching]);

  const foundDevice = found ? devices.find((d) => d.serial === found.serial) ?? null : null;

  const illustrations = [
    <ApModeSvg key="ap" label={t('onboarding.step.apMode')} />,
    <ConnectWifiSvg
      key="cw"
      label={t('onboarding.step.connectWifi')}
      homeWifi={t('onboarding.svg.homeWifi')}
      neighborWifi={t('onboarding.svg.neighborWifi')}
    />,
    <ConfigureSvg
      key="cf"
      label={t('onboarding.step.configure')}
      ssidLine={`${t('onboarding.svg.ssidLabel')} ${t('onboarding.svg.homeWifi')}`}
      passwordLine={`${t('onboarding.svg.passwordLabel')} ••••••••`}
    />,
    <SearchSvg key="se" label={t('onboarding.step.search')} yourServer={t('onboarding.svg.yourServer')} />,
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Kopf */}
      <div>
        <h1 className="text-xl font-semibold">{t('onboarding.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('onboarding.subtitle')}</p>
      </div>

      {/* Duplikat-Hinweis */}
      <div className="flex items-start gap-3 rounded-xl border border-[#009deb]/40 bg-[#009deb]/10 px-4 py-3 text-sm text-[#38bdf8]">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('onboarding.noDuplicates')}</span>
      </div>

      {/* Fortschritt */}
      <ol className="flex flex-wrap items-center gap-2">
        {STEP_KEYS.map((key, i) => (
          <li key={key} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                i < step
                  ? 'bg-emerald-400/20 text-emerald-400'
                  : i === step
                    ? 'bg-[#009deb]/20 text-[#38bdf8]'
                    : 'bg-secondary text-muted-foreground'
              }`}
            >
              {i < step ? '✓' : i + 1}
            </span>
            <span className={`hidden text-xs sm:inline ${i === step ? 'text-foreground' : 'text-muted-foreground'}`}>
              {t(key)}
            </span>
            {i < STEP_KEYS.length - 1 && <span className="h-px w-4 bg-border" />}
          </li>
        ))}
      </ol>

      {/* Schritt-Karte */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('onboarding.stepOf', { n: step + 1, total: STEP_KEYS.length })}
        </p>
        <h2 className="mt-1 text-lg font-semibold">{t(STEP_KEYS[step])}</h2>

        <div className="mt-4 grid grid-cols-1 items-start gap-5 md:grid-cols-[1fr_auto]">
          <div className="min-w-0 space-y-4">
            {step === 0 && (
              <>
                <p className="text-sm leading-relaxed text-foreground/80">{t('onboarding.apMode.body')}</p>
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('onboarding.apMode.note')}</span>
                </div>

                {/* Seriennummer (optional) */}
                <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 p-4">
                  <Label htmlFor="ob-serial" className="text-sm font-medium">{t('onboarding.serial.section')}</Label>
                  <p className="text-xs text-muted-foreground">{t('onboarding.serial.hint')}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="ob-serial"
                      value={serialInput}
                      onChange={(e) => { setSerialInput(e.target.value.toUpperCase()); }}
                      onBlur={() => setSerialTouched(true)}
                      placeholder={t('onboarding.serial.placeholder')}
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={32}
                      className="max-w-64 font-mono"
                      aria-invalid={serialInvalid}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => { setQrError(null); setScanning((v) => !v); }}
                    >
                      <Camera className="h-3.5 w-3.5" />
                      {scanning ? t('onboarding.qr.stop') : t('onboarding.qr.scan')}
                    </Button>
                  </div>
                  {serialInvalid && <p className="text-xs text-red-400">{t('onboarding.serial.invalid')}</p>}
                  {serial && (
                    <p className={`flex items-center gap-1.5 text-xs ${knownDevice ? 'text-[#38bdf8]' : 'text-emerald-400'}`}>
                      {knownDevice ? <Info className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      {knownDevice
                        ? t('onboarding.serial.known', { name: deviceDisplayName(knownDevice) || knownDevice.serial })
                        : t('onboarding.serial.unknown')}
                    </p>
                  )}
                  {qrError && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t(`onboarding.qr.${qrError}` as 'onboarding.qr.unsupported' | 'onboarding.qr.https' | 'onboarding.qr.denied')}
                    </p>
                  )}
                  {scanning && (
                    <div className="space-y-1.5">
                      <video ref={videoRef} muted playsInline className="w-full max-w-72 rounded-lg border border-border bg-black" />
                      <p className="text-xs text-muted-foreground">{t('onboarding.qr.scanning')}</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <p className="text-sm leading-relaxed text-foreground/80">{t('onboarding.connectWifi.body')}</p>
                <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Wifi className="h-4 w-4 text-[#38bdf8]" />
                      {t('onboarding.scan.title')}
                    </p>
                    <Button variant="outline" size="sm" className="gap-1.5" disabled={wifiLoading} onClick={() => void scanWifi()}>
                      <RefreshCw className={`h-3.5 w-3.5 ${wifiLoading ? 'animate-spin' : ''}`} />
                      {wifiLoading ? t('onboarding.scan.loading') : t('onboarding.scan.refresh')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('onboarding.scan.hint')}</p>
                  {wifiLoading && !wifi && (
                    <div className="space-y-2 pt-1">
                      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                    </div>
                  )}
                  {wifi?.error && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t('onboarding.scan.error', { error: wifi.error })}
                    </p>
                  )}
                  {wifi && !wifi.error && wifi.networks.length === 0 && !wifiLoading && (
                    <p className="text-xs text-muted-foreground">{t('onboarding.scan.empty')}</p>
                  )}
                  {wifi && wifi.networks.length > 0 && (
                    <ul className="divide-y divide-border/60 pt-1">
                      {wifi.networks.map((n) => (
                        <li key={n.ssid} className="flex items-center gap-2 py-1.5">
                          <Wifi className={`h-3.5 w-3.5 shrink-0 ${n.rfLike ? 'text-emerald-400' : 'text-muted-foreground'}`} />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{n.ssid}</span>
                          {n.rfLike && <Badge className="border-emerald-400/40 bg-emerald-400/10 text-emerald-400">{t('onboarding.scan.rfBadge')}</Badge>}
                          {n.signal !== null && (
                            <span className="shrink-0 text-[11px] text-muted-foreground">{t('onboarding.scan.signal', { signal: n.signal })}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <p className="text-sm leading-relaxed text-foreground/80">{t('onboarding.configure.body')}</p>
                <p className="rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                  {t('onboarding.configure.urls')}
                </p>
                <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Server className="h-4 w-4 text-[#38bdf8]" />
                    {t('onboarding.configure.serverField')}
                  </p>
                  {lanIps === null && <Skeleton className="h-6 w-40" />}
                  {lanIps !== null && lanIps.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t('onboarding.configure.serverUnknown')}</p>
                  )}
                  {lanIps !== null && lanIps.length > 0 && (
                    <ul className="space-y-1">
                      {lanIps.map((ip) => (
                        <li key={`${ip.name}-${ip.address}`} className="flex items-baseline gap-2 text-sm">
                          <code className="rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{ip.address}</code>
                          <span className="truncate text-xs text-muted-foreground">{ip.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">{t('onboarding.configure.serverHint')}</p>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                {!found && (
                  <>
                    <p className="text-sm leading-relaxed text-foreground/80">{t('onboarding.search.body')}</p>
                    {searching ? (
                      <div className="space-y-3">
                        <p className="flex items-center gap-2 text-sm text-[#38bdf8]">
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          {t('onboarding.search.searching')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {serial ? t('onboarding.search.targetSerial', { serial }) : t('onboarding.search.anyDevice')}
                        </p>
                        <Button variant="outline" size="sm" onClick={() => setSearching(false)}>
                          {t('onboarding.search.stop')}
                        </Button>
                        {showTimeoutHint && (
                          <p className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {t('onboarding.search.timeoutHint')}
                          </p>
                        )}
                      </div>
                    ) : (
                      <Button onClick={startSearch} className="gap-1.5">
                        <Search className="h-4 w-4" />
                        {t('onboarding.search.start')}
                      </Button>
                    )}
                  </>
                )}
                {found && (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-3">
                      <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                      <div>
                        <p className="text-sm font-medium text-emerald-300">
                          {found.isNew ? t('onboarding.success.new') : t('onboarding.success.relinked')}
                        </p>
                        <p className="mt-1 font-mono text-xs text-emerald-200/80">
                          {foundDevice ? deviceDisplayName(foundDevice) || found.serial : found.serial}
                          <span className="ml-2 text-muted-foreground">({found.serial})</span>
                        </p>
                        {/* Ohne Serial-Eingabe kann auch ein zufällig gleichzeitig
                            verbindendes Gerät gefunden worden sein — zur Sicherheit
                            eine explizite Bestätigungszeile zeigen. */}
                        {!serial && (
                          <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald-200/90">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {t('onboarding.success.confirm', { serial: found.serial })}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => onOpenDevice(found.serial)} className="gap-1.5">
                        <ListChecks className="h-4 w-4" />
                        {t('onboarding.success.openDevice')}
                      </Button>
                      <Button variant="outline" onClick={onDone}>
                        {t('onboarding.success.backToDashboard')}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="justify-self-center md:justify-self-end">{illustrations[step]}</div>
        </div>

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between border-t border-border/60 pt-4">
          <Button variant="ghost" size="sm" className="gap-1.5" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('onboarding.back')}
          </Button>
          {step < STEP_KEYS.length - 1 ? (
            <Button size="sm" className="gap-1.5" onClick={() => setStep((s) => Math.min(STEP_KEYS.length - 1, s + 1))}>
              {t('onboarding.next')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          ) : (
            !found && (
              <Button variant="ghost" size="sm" onClick={onDone}>
                {t('onboarding.done')}
              </Button>
            )
          )}
        </div>
      </div>

      {!found && searching === false && step === 3 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ScanSearch className="h-3.5 w-3.5" />
          {serial ? t('onboarding.search.targetSerial', { serial }) : t('onboarding.search.anyDevice')}
        </p>
      )}
    </div>
  );
}
