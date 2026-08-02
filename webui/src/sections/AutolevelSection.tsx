import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Gauge, History, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { StepperInput } from '@/components/ui/stepper-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n, useT } from '@/i18n/I18nContext';
import type { AutolevelReason, AutolevelResponse, CoveredState, DeviceSnapshot } from '@/types/reef';

// Defensiv: ältere Server-Versionen kennen /api/autolevel noch nicht und liefern
// über den SPA-Fallback HTML — daran sauber erkennen statt zu crashen
// (Muster wie Settings.tsx).
class ApiUnavailableError extends Error {
  constructor() { super('api-unavailable'); }
}

async function fetchJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(path, init);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new ApiUnavailableError();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
}

const NONE = '__none__'; // Radix-Select erlaubt keine leeren Values

// covered → Anzeigetext (Wasser über/unter Sensor)
function coveredKey(c: CoveredState): 'level.above' | 'level.below' | 'level.unknown' {
  if (c === true) return 'level.above';
  if (c === false) return 'level.below';
  return 'level.unknown';
}

// Problemfarbe je Sensorposition: oben covered = zu voll (rot),
// unten NICHT covered = zu leer (rot), sonst grün; unbekannt = gedimmt
function coveredColor(c: CoveredState, role: 'high' | 'low'): string {
  const problem = role === 'high' ? c === true : c === false;
  if (problem) return 'text-red-400';
  if (c === true || c === false) return 'text-emerald-400';
  return 'text-muted-foreground';
}

function reasonKey(r: AutolevelReason): 'autolevel.reason.tooFull' | 'autolevel.reason.tooEmpty' | 'autolevel.reason.staleData' {
  return r === 'tooFull' ? 'autolevel.reason.tooFull' : r === 'tooEmpty' ? 'autolevel.reason.tooEmpty' : 'autolevel.reason.staleData';
}

interface Props {
  dev: DeviceSnapshot;      // die geöffnete Rückförderpumpe (family basepump)
  devices: DeviceSnapshot[]; // alle Geräte (für die Sensor-Auswahl)
}

// SVG-Veranschaulichung: Ablaufschacht mit Wasserpegel, zwei Sensorpunkten
// (Farbe je Live-Zustand) und Pumpe mit aktuellem %-Wert + Richtungspfeil.
// covered-Logik: Punkt oben rot, wenn der obere Sensor bedeckt ist (zu voll);
// Punkt unten rot, wenn der untere NICHT bedeckt ist (zu leer); Wasserfläche
// zwischen den Sensoren, wenn unten covered && oben nicht covered.
function ShaftSketch({ highCovered, lowCovered, speed, arrowDir }: {
  highCovered: CoveredState; lowCovered: CoveredState; speed: number | null;
  arrowDir: 'up' | 'down' | null; // frischer Eingriff (< Cooldown alt)
}) {
  const H = 160, W = 120; // Schacht-Geometrie
  // Wasserpegel relativ zur Punktlage (oben cy=28 ±6 → Rand 22, unten
  // cy=H-18=142 ±6 → Rand 148): oben bedeckt → Oberfläche ÜBER dem oberen
  // Punkt (0.08 → y≈21); unten trocken → Oberfläche UNTER dem unteren
  // Punkt inkl. Radius (0.99 → y≈149); Normalbereich → zwischen den Sensoren.
  const levelFrac = highCovered === true ? 0.08 : lowCovered === false ? 0.99 : 0.5;
  const waterY = 10 + levelFrac * (H - 20);
  const dot = (c: CoveredState, role: 'high' | 'low') => {
    const problem = role === 'high' ? c === true : c === false;
    if (problem) return '#f87171';
    if (c === true || c === false) return '#34d399';
    return '#64748b'; // unbekannt
  };
  const blink = (c: CoveredState, role: 'high' | 'low') =>
    (role === 'high' ? c === true : c === false) ? 'autolevel-blink' : undefined;
  return (
    <div className="flex items-center justify-center gap-6">
      <style>{`@keyframes autolevel-blink { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
.autolevel-blink { animation: autolevel-blink 1s ease-in-out infinite }`}</style>
      <svg viewBox={`0 0 ${W} ${H + 10}`} className="h-44 w-auto" role="img" aria-label="Ablaufschacht">
        {/* Schacht */}
        <rect x="15" y="5" width={W - 30} height={H} rx="6" fill="none" stroke="#475569" strokeWidth="2" />
        {/* Wasser (y/höhe als CSS-Geometry-Properties → sanfter Übergang) */}
        <rect x="17" width={W - 34} rx="4" fill="#0ea5e9" fillOpacity="0.35"
          style={{ y: waterY, height: 5 + H - waterY, transition: 'y 1.2s ease, height 1.2s ease' }} />
        {/* Pegellinie */}
        <line x1="17" x2={W - 17} stroke="#38bdf8" strokeWidth="2" strokeDasharray="4 3"
          style={{ y1: waterY, y2: waterY, transition: 'y1 1.2s ease, y2 1.2s ease' } as React.CSSProperties} />
        {/* Sensorpunkte: oben = Hoch-Sensor, unten = Tief-Sensor */}
        <circle cx={W - 12} cy="28" r="6" fill={dot(highCovered, 'high')} className={blink(highCovered, 'high')} stroke="#0f172a" strokeWidth="1.5" />
        <circle cx={W - 12} cy={H - 18} r="6" fill={dot(lowCovered, 'low')} className={blink(lowCovered, 'low')} stroke="#0f172a" strokeWidth="1.5" />
      </svg>
      {/* Pumpe mit aktuellem %-Wert und Richtungspfeil */}
      <div className="flex flex-col items-center gap-1">
        <svg viewBox="0 0 64 84" className="h-24 w-auto" role="img" aria-label="Rückförderpumpe">
          <circle cx="32" cy="26" r="22" fill="none" stroke="#38bdf8" strokeWidth="2.5" />
          <circle cx="32" cy="26" r="22" fill="#38bdf8" fillOpacity="0.12" />
          <path d="M22 26 a10 10 0 0 1 20 0" fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" />
          <text x="32" y="31" textAnchor="middle" fontSize="13" fontWeight="700" fill="#e2e8f0">
            {speed === null ? '—' : `${speed} %`}
          </text>
          {arrowDir && (
            <g className="autolevel-blink">
              {arrowDir === 'up'
                ? <path d="M32 52 l-9 12 h5 v8 h8 v-8 h5 z" fill="#34d399" />
                : <path d="M32 72 l-9 -12 h5 v-8 h8 v8 h5 z" fill="#f87171" />}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

export default function AutolevelSection({ dev, devices }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [data, setData] = useState<AutolevelResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Erweiterte Werte (Formular)
  const [fStep, setFStep] = useState('1');
  const [fMin, setFMin] = useState('1');
  const [fMax, setFMax] = useState('100');
  const [fCooldown, setFCooldown] = useState('60');

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [locale],
  );

  const levelSensors = useMemo(
    () => devices.filter((d) => d.family === 'levelSensor'),
    [devices],
  );
  const sensorName = (d: DeviceSnapshot) => d.customName || d.name || d.serial;

  const load = useCallback(async () => {
    try {
      const j = await fetchJson('/api/autolevel');
      setData(j as unknown as AutolevelResponse);
      setUnavailable(false);
    } catch (e) {
      if (e instanceof ApiUnavailableError) setUnavailable(true);
      // sonstige Fehler: alten Stand behalten, nächster Poll versucht es erneut
    }
  }, []);

  // Beim Öffnen laden + alle 15 s aktualisieren (nur solange die Detailansicht offen ist)
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  // Formular aus der geladenen Config befüllen, wenn der Aufklapper geöffnet wird
  useEffect(() => {
    if (advancedOpen && data) {
      setFStep(String(data.config.stepPercent));
      setFMin(String(data.config.minSpeed));
      setFMax(String(data.config.maxSpeed));
      setFCooldown(String(data.config.cooldownS));
    }
  }, [advancedOpen, data]);

  const savePatch = useCallback(async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetchJson('/api/autolevel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await load();
      return true;
    } catch (e) {
      toast.error(t('autolevel.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const saveAdvanced = async () => {
    const step = Number(fStep), min = Number(fMin), max = Number(fMax), cd = Number(fCooldown);
    if (!Number.isInteger(step) || step < 1 || step > 10) { toast.error(t('autolevel.validation.step')); return; }
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > 50 || max < 50 || max > 100 || min >= max) {
      toast.error(t('autolevel.validation.range')); return;
    }
    if (!Number.isInteger(cd) || cd < 10 || cd > 600) { toast.error(t('autolevel.validation.cooldown')); return; }
    if (await savePatch({ stepPercent: step, minSpeed: min, maxSpeed: max, cooldownS: cd })) {
      toast.success(t('autolevel.saved'));
    }
  };

  if (unavailable) {
    return (
      <div className="mt-4 border-t border-border/60 pt-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2.5 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">{t('autolevel.title')}</p>
            <p className="mt-0.5 text-xs">{t('autolevel.unavailable')}</p>
            <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => void load()}>
              <RefreshCw className="mr-1 h-3 w-3" />{t('autolevel.retry')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const cfg = data?.config;
  const st = data?.status;
  const hist = data?.history ?? [];
  const last = hist[0];
  // Pfeil kurz nach einem Eingriff zeigen (Eintrag jünger als Cooldown;
  // staleData-Einträge haben keine Speeds → kein Pfeil)
  const arrowDir: 'up' | 'down' | null =
    last && st && typeof last.newSpeed === 'number' && typeof last.oldSpeed === 'number'
    && Date.now() - last.ts < st.cooldownS * 1000
      ? last.newSpeed > last.oldSpeed ? 'up' : last.newSpeed < last.oldSpeed ? 'down' : null
      : null;
  const bothSensorsSet = !!(cfg?.highSerial && cfg?.lowSerial);

  const sensorSelect = (
    label: string, value: string, field: 'highSerial' | 'lowSerial',
    covered: CoveredState, dataAgeS: number | null | undefined,
  ) => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Select
          value={value || NONE}
          disabled={busy || levelSensors.length === 0}
          onValueChange={(v) => void savePatch({ pumpSerial: dev.serial, [field]: v === NONE ? '' : v })}
        >
          <SelectTrigger className="h-8 flex-1 text-sm">
            <SelectValue placeholder={t('autolevel.noSensor')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('autolevel.noSensor')}</SelectItem>
            {levelSensors.map((s) => (
              <SelectItem key={s.serial} value={s.serial}>
                {sensorName(s)}{s.online ? '' : ` (${t('status.offline')})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className={`shrink-0 text-xs font-medium ${coveredColor(covered, field === 'highSerial' ? 'high' : 'low')}`}>
          {t(coveredKey(covered))}
        </span>
      </div>
      {value && (
        <p className="text-[11px] text-muted-foreground">
          {typeof dataAgeS === 'number' ? t('autolevel.dataAge', { s: dataAgeS }) : t('autolevel.dataAge.never')}
        </p>
      )}
    </div>
  );

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-[#38bdf8]" />
          <h3 className="text-sm font-semibold">{t('autolevel.title')}</h3>
          {st && (
            <Badge variant={st.running ? 'default' : 'secondary'}>
              {st.running ? t('autolevel.enabled') : t('autolevel.disabled')}
            </Badge>
          )}
          {st && st.running && !st.pumpOnline && (
            <Badge variant="destructive">{t('autolevel.pumpOffline')}</Badge>
          )}
        </div>
        <Switch
          checked={!!cfg?.enabled}
          disabled={busy || !data || (!!cfg && !cfg.enabled && !bothSensorsSet)}
          aria-label={t('autolevel.title')}
          onCheckedChange={(on) => void savePatch({ enabled: on, pumpSerial: dev.serial })}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('autolevel.description')}</p>

      {levelSensors.length === 0 && (
        <p className="mt-2 text-xs text-amber-300">{t('autolevel.noLevelSensors')}</p>
      )}
      {cfg && !cfg.enabled && !bothSensorsSet && levelSensors.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{t('autolevel.hint.selectSensors')}</p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {sensorSelect(t('autolevel.sensorHigh'), cfg?.highSerial ?? '', 'highSerial', st?.highCovered ?? 'unknown', st?.highDataAgeS)}
        {sensorSelect(t('autolevel.sensorLow'), cfg?.lowSerial ?? '', 'lowSerial', st?.lowCovered ?? 'unknown', st?.lowDataAgeS)}
      </div>

      <div className="mt-4 rounded-lg border border-border/60 bg-background/40 p-3">
        <ShaftSketch
          highCovered={st?.highCovered ?? 'unknown'}
          lowCovered={st?.lowCovered ?? 'unknown'}
          speed={st?.currentSpeed ?? null}
          arrowDir={arrowDir}
        />
        <div className="mt-2 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('autolevel.pumpSpeed')}</span>
            <span className="font-mono font-semibold text-[#17c3d6]">
              {st?.currentSpeed === null || st?.currentSpeed === undefined ? '—' : `${st.currentSpeed} %`}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('autolevel.lastAction')}</span>
            <span className="font-mono text-xs">
              {last
                ? `${timeFmt.format(new Date(last.ts))} · ${t(reasonKey(last.reason))}` +
                  (typeof last.oldSpeed === 'number' && typeof last.newSpeed === 'number'
                    ? ` · ${t('autolevel.lastAction.delta', { old: last.oldSpeed, new: last.newSpeed })}`
                    : '')
                : t('autolevel.lastAction.none')}
            </span>
          </div>
        </div>
        {cfg && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('autolevel.cooldownHint', { s: cfg.cooldownS, step: cfg.stepPercent })}
          </p>
        )}
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-3">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
            {t('autolevel.advanced')}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('autolevel.stepPercent')}</Label>
              <StepperInput min={1} max={10} value={fStep} onChange={setFStep} disabled={busy} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('autolevel.cooldownS')}</Label>
              <StepperInput min={10} max={600} value={fCooldown} onChange={setFCooldown} disabled={busy} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('autolevel.minSpeed')}</Label>
              <StepperInput min={0} max={50} value={fMin} onChange={setFMin} disabled={busy} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('autolevel.maxSpeed')}</Label>
              <StepperInput min={50} max={100} value={fMax} onChange={setFMax} disabled={busy} />
            </div>
          </div>
          <Button size="sm" className="w-full" disabled={busy} onClick={() => void saveAdvanced()}>
            {busy ? t('autolevel.saving') : t('autolevel.save')}
          </Button>
        </CollapsibleContent>
      </Collapsible>

      <div className="mt-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          {t('autolevel.history.title')}
        </div>
        {hist.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('autolevel.history.empty')}</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {hist.slice(0, 10).map((h, i) => (
              <li key={`${h.ts}-${i}`} className="flex items-center justify-between gap-2 rounded-md bg-background/40 px-2 py-1 font-mono text-xs">
                <span className="shrink-0 text-muted-foreground">{timeFmt.format(new Date(h.ts))}</span>
                <span className={`truncate ${h.reason === 'tooFull' ? 'text-red-400' : h.reason === 'tooEmpty' ? 'text-amber-300' : 'text-muted-foreground'}`}>
                  {t(reasonKey(h.reason))}
                </span>
                <span className="shrink-0">
                  {typeof h.oldSpeed === 'number' && typeof h.newSpeed === 'number' ? `${h.oldSpeed} % → ${h.newSpeed} %` : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
