import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { toast } from 'sonner';
import {
  Activity, Beaker, Cpu, Droplets, FlaskConical, Gauge, Lightbulb,
  Plug, Ruler, Scroll, Thermometer, Waves, type LucideIcon,
} from 'lucide-react';
import WaveScheduleEditor from './WaveScheduleEditor';
import type { CommandFn, DeviceSnapshot } from '@/types/reef';

export const FAMILY_META: Record<string, { name: string; Icon: LucideIcon }> = {
  basepump: { name: 'Rückförderpumpe', Icon: Droplets },
  wave: { name: 'Strömungspumpe', Icon: Waves },
  roller: { name: 'Smart roller', Icon: Scroll },
  flare: { name: 'Reef flare', Icon: Lightbulb },
  levelSensor: { name: 'Level sensor', Icon: Gauge },
  salinity: { name: 'Salinity guardian', Icon: FlaskConical },
  thermo: { name: 'Thermo control', Icon: Thermometer },
  doser: { name: 'Doser', Icon: Beaker },
  level: { name: 'Level keeper', Icon: Ruler },
  powerswitcher: { name: 'Power switcher', Icon: Plug },
  unknown: { name: 'Gerät', Icon: Cpu },
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function ago(lastSeen: number, now: number): string {
  if (!lastSeen) return 'nie';
  const s = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
}

// ---------- gemeinsame Bausteine ----------

function SpeedControl({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const current = num(dev.state.speed);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(current), [current]);
  const dirty = value !== current;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Stärke</span>
        <span className="font-mono text-lg font-semibold text-[#17c3d6]">{dirty ? `${value} → ${current}` : current} %</span>
      </div>
      <Slider value={[value]} min={0} max={100} step={1} disabled={!dev.online || busy}
        onValueChange={([v]) => setValue(v)} />
      <Button size="sm" className="w-full" disabled={!dev.online || !dirty || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await sendCommand(dev.serial, 'setSpeed', { speed: value });
            toast.success(`${FAMILY_META[dev.family]?.name ?? 'Gerät'}: Stärke ${value} % gesendet`);
          } catch (e) { toast.error(`Fehler: ${e instanceof Error ? e.message : e}`); }
          setBusy(false);
        }}>
        Übernehmen
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
  const alertOk = str(dev.state.alert, 'noErrors') === 'noErrors';
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">Modus: {str(dev.state.mode, '—')}</Badge>
        <Badge variant={alertOk ? 'secondary' : 'destructive'}>{alertOk ? 'keine Fehler' : str(dev.state.alert)}</Badge>
        <Badge variant="secondary">Display {str(dev.state.display, '—')}</Badge>
      </div>
      <div className="mt-3 space-y-1">
        <Stat label="Fütterung" value={`${num(dev.state.feedModeTime)} min @ ${num(dev.state.feedSpeed)} %`} />
      </div>
      <SpeedControl dev={dev} sendCommand={sendCommand} />
    </>
  );
}

const WAVE_MODES: Record<number, string> = { 1: 'Konstant', 2: 'Puls', 3: 'Sinus', 4: 'Zufällig' };

function WaveBody({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const feed = obj(dev.state.feed);
  const feeding = num(feed.status) === 1;
  const settings = obj(dev.state.settings);
  const hasSchedule = Array.isArray(settings.schedule) && (settings.schedule as unknown[]).length > 0;
  const modeName = WAVE_MODES[num(dev.state.mode)] ?? `Modus ${num(dev.state.mode)}`;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{modeName}</Badge>
        <Badge variant={feeding ? 'default' : 'secondary'}>{feeding ? 'Fütterung läuft' : 'Normalbetrieb'}</Badge>
        <Stat label="Uhr" value={`${num(dev.state.clock)}`} />
      </div>
      {hasSchedule
        ? <WaveScheduleEditor dev={dev} sendCommand={sendCommand} />
        : <SpeedControl dev={dev} sendCommand={sendCommand} />}
    </>
  );
}

function RollerBody({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const roll = obj(dev.state.roll);
  const current = num(roll.currentLength);
  const start = num(roll.startLength, 1);
  const pct = Math.max(0, Math.min(100, Math.round((current / start) * 100)));
  const [mm, setMm] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: string, params: Record<string, unknown>, label: string) => {
    setBusy(action);
    try {
      await sendCommand(dev.serial, action, params);
      toast.success(`${label} gesendet`);
    } catch (e) { toast.error(`Fehler: ${e instanceof Error ? e.message : e}`); }
    setBusy(null);
  };
  return (
    <>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Vlies verbleibend</span>
          <span className="font-mono font-semibold text-[#17c3d6]">{pct} %</span>
        </div>
        <Progress value={pct} className="h-2.5" />
        <p className="text-xs text-muted-foreground">
          {(current / 1000).toFixed(1)} m von {(start / 1000).toFixed(0)} m · Wechsel in ≈ {num(roll.daysToReplace)} Tagen
        </p>
      </div>
      <div className="mt-3 space-y-1">
        <Stat label="Heute verbraucht" value={`${num(roll.todayUsed)} mm`} />
        <Stat label="Ø pro Tag" value={`${num(roll.dailyUsedAverage)} mm`} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Input type="number" min={1} max={500} value={mm} disabled={!dev.online}
          onChange={(e) => setMm(Number(e.target.value))} className="w-20" />
        <Button size="sm" variant="secondary" disabled={!dev.online || busy !== null}
          onClick={() => run('feed', { mm }, `Vorschub ${mm} mm`)}>
          {busy === 'feed' ? '…' : 'Vorschub'}
        </Button>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}
          onClick={() => { if (window.confirm('Neue Vliesrolle wirklich einlernen?')) run('newRoll', {}, 'Neue Rolle'); }}>
          Neue Rolle
        </Button>
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}
          onClick={() => { if (window.confirm('Blockade des Rollers wirklich zurücksetzen?')) run('unblock', {}, 'Entblocken'); }}>
          Entblocken
        </Button>
      </div>
    </>
  );
}

function FlareBody({ dev }: { dev: DeviceSnapshot }) {
  const channels = Array.isArray(dev.state.channels) ? (dev.state.channels as unknown[]).map((c) => num(c)) : [];
  const on = dev.state.on === true || num(dev.state.on) === 1;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant={on ? 'default' : 'secondary'}>{on ? 'Beleuchtung an' : 'Beleuchtung aus'}</Badge>
        <Badge variant="secondary">LED {num(dev.state.ledTempC)} °C</Badge>
      </div>
      {channels.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {channels.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-8 text-xs text-muted-foreground">K{i + 1}</span>
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
  const rows: [string, string][] = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key);
      else rows.push([key, Array.isArray(v) ? `[${v.length} Einträge]` : String(v)]);
    }
  };
  walk(dev.state, '');
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Noch keine Statusdaten empfangen.</p>;
  }
  return (
    <div className="space-y-1">
      {rows.slice(0, 8).map(([k, v]) => <Stat key={k} label={k} value={v} />)}
      {rows.length > 8 && <p className="text-xs text-muted-foreground">… und {rows.length - 8} weitere Werte</p>}
    </div>
  );
}

// ---------- Karten-Shell ----------

interface Props {
  dev: DeviceSnapshot;
  now: number;
  sendCommand: CommandFn;
}

export default function DeviceCard({ dev, now, sendCommand }: Props) {
  const meta = FAMILY_META[dev.family] ?? FAMILY_META.unknown;
  const { Icon } = meta;
  return (
    <Card className={`border-border/70 bg-card/80 shadow-lg shadow-black/20 transition-opacity ${dev.online ? '' : 'opacity-55'}`}>
      <CardHeader className="flex-row items-center gap-3 space-y-0 pb-3">
        <div className="rounded-lg bg-gradient-to-br from-[#009deb]/25 to-[#17c3d6]/25 p-2">
          <Icon className="h-5 w-5 text-[#17c3d6]" />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-semibold">{dev.name ?? meta.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{dev.serial}</p>
        </div>
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dev.online ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.5)]' : 'bg-muted-foreground/50'}`} />
      </CardHeader>
      <CardContent>
        {dev.family === 'basepump' && <BasepumpBody dev={dev} sendCommand={sendCommand} />}
        {dev.family === 'wave' && <WaveBody dev={dev} sendCommand={sendCommand} />}
        {dev.family === 'roller' && <RollerBody dev={dev} sendCommand={sendCommand} />}
        {dev.family === 'flare' && <FlareBody dev={dev} />}
        {!['basepump', 'wave', 'roller', 'flare'].includes(dev.family) && <GenericBody dev={dev} />}
        <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
          <span>{dev.firmware ? `FW ${dev.firmware}` : 'FW —'} · {dev.ip || 'IP —'}</span>
          <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{ago(dev.lastSeen, now)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// Wiederverwendung in der RF-Stil-Detailansicht
export { SpeedControl, BasepumpBody, WaveBody, RollerBody, FlareBody, GenericBody };
