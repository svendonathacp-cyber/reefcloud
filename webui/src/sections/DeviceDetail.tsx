import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  BasepumpBody, FlareBody, FAMILY_META, GenericBody, RollerBody, WaveBody,
} from './DeviceCard';
import FlareProgramEditor from './FlareProgramEditor';
import type { CommandFn, DeviceSnapshot } from '@/types/reef';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '—') => (typeof v === 'string' && v ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// Große Stat-Anzeige im Stil der RF-Cloud („LEISTUNG 70/130W", „TEMP 49°C")
function BigStat({ label, value, unit, accent = true }: { label: string; value: string | number; unit?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-4">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="leading-none">
        <span className={`text-3xl font-bold ${accent ? 'text-[#009deb]' : 'text-foreground'}`}>{value}</span>
        {unit && <span className="ml-0.5 text-sm text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
}

function clockFmt(c: unknown): string {
  const mins = num(c, -1);
  if (mins < 0) return '—';
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

function StatsRow({ dev }: { dev: DeviceSnapshot }) {
  switch (dev.family) {
    case 'basepump':
      return (
        <>
          <BigStat label="Stärke" value={num(dev.state.speed)} unit="%" />
          <BigStat label="Modus" value={str(dev.state.mode)} accent={false} />
          <BigStat label="Fütterung" value={`${num(dev.state.feedModeTime)} min`} accent={false} />
        </>
      );
    case 'wave':
      return (
        <>
          <BigStat label="Stärke" value={num(dev.state.speed)} unit="%" />
          <BigStat label="Modus" value={num(dev.state.mode)} accent={false} />
          <BigStat label="Uhr" value={clockFmt(dev.state.clock)} accent={false} />
        </>
      );
    case 'roller': {
      const roll = obj(dev.state.roll);
      const pct = Math.round((num(roll.currentLength) / Math.max(1, num(roll.startLength, 1))) * 100);
      return (
        <>
          <BigStat label="Vlies" value={pct} unit="%" />
          <BigStat label="Wechsel in" value={num(roll.daysToReplace)} unit="Tagen" accent={false} />
          <BigStat label="Heute" value={num(roll.todayUsed)} unit="mm" accent={false} />
        </>
      );
    }
    case 'flare': {
      const channels = Array.isArray(dev.state.channels) ? (dev.state.channels as unknown[]).map((c) => num(c)) : [];
      const on = dev.state.on === true || num(dev.state.on) === 1;
      return (
        <>
          <BigStat label="Temperatur" value={num(dev.state.ledTempC)} unit="°C" />
          <BigStat label="Status" value={on ? 'An' : 'Aus'} accent={false} />
          <BigStat label="Kanal-Max" value={channels.length ? Math.max(...channels) : 0} unit="%" accent={false} />
        </>
      );
    }
    default:
      return null;
  }
}

interface Props {
  dev: DeviceSnapshot;
  now: number;
  sendCommand: CommandFn;
}

// Geräte-Detailseite im Stil der Reef-Factory-Einstellungsseiten
export default function DeviceDetail({ dev, now, sendCommand }: Props) {
  const meta = FAMILY_META[dev.family] ?? FAMILY_META.unknown;
  const { Icon } = meta;
  const hasControls = ['basepump', 'wave', 'roller'].includes(dev.family);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="border-b border-border pb-4 pt-2 text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[#009deb]/15 to-[#17c3d6]/15">
          <Icon className="h-6 w-6 text-[#009deb]" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{dev.name ?? meta.name}</h2>
        <p className="mt-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>{meta.name}</span>·<span className="font-mono text-xs">{dev.serial}</span>·
          <Badge variant={dev.online ? 'default' : 'secondary'} className="text-[10px]">
            {dev.online ? 'online' : 'offline'}
          </Badge>
        </p>
      </div>

      <div className="flex items-start justify-center divide-x divide-border py-6">
        <StatsRow dev={dev} />
      </div>

      <Card className="border-border shadow-sm">
        <CardContent className="pt-5">
          {dev.family === 'basepump' && <BasepumpBody dev={dev} sendCommand={sendCommand} />}
          {dev.family === 'wave' && <WaveBody dev={dev} sendCommand={sendCommand} />}
          {dev.family === 'roller' && <RollerBody dev={dev} sendCommand={sendCommand} />}
          {dev.family === 'flare' && (
            <>
              <FlareBody dev={dev} />
              <FlareProgramEditor serial={dev.serial} />
            </>
          )}
          {!['basepump', 'wave', 'roller', 'flare'].includes(dev.family) && <GenericBody dev={dev} />}
          {!hasControls && dev.family !== 'flare' && (
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Nur Anzeige — Steuerbefehle für diesen Gerätetyp sind noch nicht verifiziert.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        {dev.firmware ? `Firmware ${dev.firmware}` : 'Firmware unbekannt'} · {dev.ip || 'IP unbekannt'} ·
        zuletzt gesehen {now && dev.lastSeen ? `vor ${Math.max(0, Math.round((now - dev.lastSeen) / 1000))} s` : 'nie'}
      </p>
    </div>
  );
}
