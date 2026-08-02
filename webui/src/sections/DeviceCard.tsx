import { useEffect, useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { StepperInput } from '@/components/ui/stepper-input';
import { toast } from 'sonner';
import {
  Beaker, Cpu, Droplets, FlaskConical, Gauge, Lightbulb,
  Plug, Ruler, Scroll, Thermometer, Waves, type LucideIcon,
} from 'lucide-react';
import WaveScheduleEditor from './WaveScheduleEditor';
import { useT } from '@/i18n/I18nContext';
import type { MessageKey } from '@/i18n/messages';
import type { CommandFn, DeviceSnapshot } from '@/types/reef';

// Dezente Familien-Farbkodierung (Hex, wird per Inline-Style gesetzt)
export const FAMILY_META: Record<string, { nameKey: MessageKey; Icon: LucideIcon; color: string }> = {
  basepump: { nameKey: 'family.basepump', Icon: Droplets, color: '#38bdf8' },
  wave: { nameKey: 'family.wave', Icon: Waves, color: '#22d3ee' },
  roller: { nameKey: 'family.roller', Icon: Scroll, color: '#fbbf24' },
  flare: { nameKey: 'family.flare', Icon: Lightbulb, color: '#a78bfa' },
  levelSensor: { nameKey: 'family.levelSensor', Icon: Gauge, color: '#34d399' },
  salinity: { nameKey: 'family.salinity', Icon: FlaskConical, color: '#2dd4bf' },
  thermo: { nameKey: 'family.thermo', Icon: Thermometer, color: '#fb923c' },
  doser: { nameKey: 'family.doser', Icon: Beaker, color: '#f472b6' },
  level: { nameKey: 'family.level', Icon: Ruler, color: '#4ade80' },
  powerswitcher: { nameKey: 'family.powerswitcher', Icon: Plug, color: '#facc15' },
  unknown: { nameKey: 'family.unknown', Icon: Cpu, color: '#94a3b8' },
};

// Anzeigename: Spitzname prominent, sonst Originalname aus dem Tank-Modell
export function deviceDisplayName(dev: DeviceSnapshot): string {
  return dev.customName || dev.name || '';
}

export const WAVE_MODE_KEYS: Record<number, MessageKey> = {
  1: 'waveMode.1', 2: 'waveMode.2', 3: 'waveMode.3', 4: 'waveMode.4',
};

// Level-Keeper-Status (Server-Key aus LK_STATUS_TEXT, reef-onboard.mjs) → i18n
export const LK_STATUS_KEYS: Record<string, MessageKey> = {
  normal: 'lk.status.normal', filling: 'lk.status.filling',
  manualRefill: 'lk.status.manualRefill', circuit: 'lk.status.circuit',
  calibration: 'lk.status.calibration', high: 'lk.status.high',
  low: 'lk.status.low', temporaryOff: 'lk.status.temporaryOff',
};

// Level-Keeper-Modi (Nachfüllzyklus, 0–5) → i18n
export const LK_MODE_KEYS: Record<number, MessageKey> = {
  0: 'lk.mode.0', 1: 'lk.mode.1', 2: 'lk.mode.2', 3: 'lk.mode.3', 4: 'lk.mode.4', 5: 'lk.mode.5',
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---------- gemeinsame Bausteine ----------

export function Ago({ lastSeen, now }: { lastSeen: number; now: number }) {
  const t = useT();
  if (!lastSeen) return <>{t('time.never')}</>;
  const s = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (s < 60) return <>{t('time.secondsAgo', { s })}</>;
  if (s < 3600) return <>{t('time.minutesAgo', { m: Math.round(s / 60) })}</>;
  return <>{t('time.hoursAgo', { h: Math.round(s / 3600) })}</>;
}

function SpeedControl({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const current = num(dev.state.speed);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(current), [current]);
  const dirty = value !== current;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{t('speed.label')}</span>
        <span className="font-mono text-lg font-semibold text-[#17c3d6]">{dirty ? `${value} → ${current}` : current} %</span>
      </div>
      <Slider value={[value]} min={0} max={100} step={1} disabled={!dev.online || busy}
        onValueChange={([v]) => setValue(v)} />
      <Button size="sm" className="w-full" disabled={!dev.online || !dirty || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await sendCommand(dev.serial, 'setSpeed', { speed: value });
            const meta = FAMILY_META[dev.family] ?? FAMILY_META.unknown;
            toast.success(t('speed.sent', { device: t(meta.nameKey), value }));
          } catch (e) { toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) })); }
          setBusy(false);
        }}>
        {t('common.apply')}
      </Button>
    </div>
  );
}

function Stat({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono' : ''}>{value}</span>
    </div>
  );
}

// ---------- Familien-Bodies ----------

function BasepumpBody({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const alertOk = str(dev.state.alert, 'noErrors') === 'noErrors';
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{t('basepump.modeBadge', { mode: str(dev.state.mode, '—') })}</Badge>
        <Badge variant={alertOk ? 'secondary' : 'destructive'}>{alertOk ? t('basepump.noErrors') : str(dev.state.alert)}</Badge>
        <Badge variant="secondary">{t('basepump.display', { display: str(dev.state.display, '—') })}</Badge>
      </div>
      <div className="mt-3 space-y-1">
        <Stat label={t('basepump.feeding')} value={`${num(dev.state.feedModeTime)} min @ ${num(dev.state.feedSpeed)} %`} />
      </div>
      <SpeedControl dev={dev} sendCommand={sendCommand} />
    </>
  );
}

function WaveBody({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const feed = obj(dev.state.feed);
  const feeding = num(feed.status) === 1;
  const settings = obj(dev.state.settings);
  const hasSchedule = Array.isArray(settings.schedule) && (settings.schedule as unknown[]).length > 0;
  const m = num(dev.state.mode);
  const modeKey = WAVE_MODE_KEYS[m];
  const modeName = modeKey ? t(modeKey) : t('wave.modeN', { n: m });
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{modeName}</Badge>
        <Badge variant={feeding ? 'default' : 'secondary'}>{feeding ? t('wave.feedingActive') : t('wave.normalOperation')}</Badge>
        <Stat label={t('wave.clock')} value={`${num(dev.state.clock)}`} />
      </div>
      {hasSchedule
        ? <WaveScheduleEditor dev={dev} sendCommand={sendCommand} />
        : <SpeedControl dev={dev} sendCommand={sendCommand} />}
    </>
  );
}

function RollerBody({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const roll = obj(dev.state.roll);
  const current = num(roll.currentLength);
  const start = num(roll.startLength, 1);
  const pct = Math.max(0, Math.min(100, Math.round((current / start) * 100)));
  const modeType = num(dev.state.mode, -1);
  const modeLabel = modeType === 1 ? t('common.auto') : modeType === 0 ? t('common.off') : str(dev.state.mode, '—');
  const [mm, setMm] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: string, params: Record<string, unknown>, label: string) => {
    setBusy(action);
    try {
      await sendCommand(dev.serial, action, params);
      toast.success(t('common.sent', { label }));
    } catch (e) { toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) })); }
    setBusy(null);
  };
  return (
    <>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('roller.fleeceRemaining')}</span>
          <span className="font-mono font-semibold text-[#17c3d6]">{pct} %</span>
        </div>
        <Progress value={pct} className="h-2.5" />
        <p className="text-xs text-muted-foreground">
          {t('roller.metaLine', {
            current: (current / 1000).toFixed(1),
            start: (start / 1000).toFixed(0),
            days: num(roll.daysToReplace),
          })}
        </p>
      </div>
      <div className="mt-3 space-y-1">
        <Stat label={t('common.mode')} value={modeLabel} mono={false} />
        <Stat label={t('roller.usedToday')} value={`${num(roll.todayUsed)} mm`} />
        <Stat label={t('roller.avgPerDay')} value={`${num(roll.dailyUsedAverage)} mm`} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button size="sm" variant={modeType === 0 ? 'default' : 'outline'} disabled={!dev.online || busy !== null || modeType === 0}
          onClick={() => run('setMode', { type: 0 }, t('roller.modeOff'))}>
          {busy === 'setMode' && modeType !== 0 ? '…' : t('common.off')}
        </Button>
        <Button size="sm" variant={modeType === 1 ? 'default' : 'outline'} disabled={!dev.online || busy !== null || modeType === 1}
          onClick={() => run('setMode', { type: 1 }, t('roller.modeAuto'))}>
          {busy === 'setMode' && modeType !== 1 ? '…' : t('common.auto')}
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <StepperInput min={1} max={500} value={String(mm)} disabled={!dev.online}
          onChange={(v) => setMm(Math.max(0, Number(v) || 0))} className="w-28" />
        <Button size="sm" variant="secondary" disabled={!dev.online || busy !== null}
          onClick={() => run('feed', { mm }, t('roller.feedMm', { mm }))}>
          {busy === 'feed' ? '…' : t('roller.feed')}
        </Button>
      </div>
      <div className="mt-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
              {busy === 'newRoll' ? '…' : t('roller.newRoll')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('roller.newRoll')}</AlertDialogTitle>
              <AlertDialogDescription>{t('roller.confirmNewRoll')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void run('newRoll', {}, t('roller.newRoll'))}>
                {t('common.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}

function FlareBody({ dev }: { dev: DeviceSnapshot }) {
  const t = useT();
  const channels = Array.isArray(dev.state.channels) ? (dev.state.channels as unknown[]).map((c) => num(c)) : [];
  const on = dev.state.on === true || num(dev.state.on) === 1;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant={on ? 'default' : 'secondary'}>{on ? t('flare.lightOn') : t('flare.lightOff')}</Badge>
        <Badge variant="secondary">{t('flare.ledTemp', { temp: num(dev.state.ledTempC) })}</Badge>
      </div>
      {channels.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {channels.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-8 text-xs text-muted-foreground">{t('flare.channelShort', { n: i + 1 })}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-gradient-to-r from-[#009deb] to-[#17c3d6]" style={{ width: `${Math.min(100, v)}%` }} />
              </div>
              <span className="w-10 text-right font-mono text-xs">{v} %</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function GenericBody({ dev }: { dev: DeviceSnapshot }) {
  const t = useT();
  const rows: [string, string][] = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key);
      else rows.push([key, Array.isArray(v) ? t('generic.entries', { n: v.length }) : String(v)]);
    }
  };
  walk(dev.state, '');
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('generic.noData')}</p>;
  }
  return (
    <div className="space-y-1">
      {rows.slice(0, 8).map(([k, v]) => <Stat key={k} label={k} value={v} />)}
      {rows.length > 8 && <p className="text-xs text-muted-foreground">{t('generic.moreValues', { n: rows.length - 8 })}</p>}
    </div>
  );
}

// Wiederverwendung in der RF-Stil-Detailansicht
export { SpeedControl, BasepumpBody, WaveBody, RollerBody, FlareBody, GenericBody };
