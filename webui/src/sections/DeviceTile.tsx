import { Activity, ChevronRight } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { useT } from '@/i18n/I18nContext';
import { Ago, deviceDisplayName, FAMILY_META, WAVE_MODE_KEYS } from './DeviceCard';
import type { DeviceSnapshot } from '@/types/reef';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '—') => (typeof v === 'string' && v ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const fmt1 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—');

export type DeviceStatus = 'online' | 'reachable' | 'offline';

// Drei klar unterscheidbare Zustände: eingeloggt / per TCP erreichbar / weg
export function statusOf(dev: DeviceSnapshot): DeviceStatus {
  if (dev.online) return 'online';
  if (dev.reachable) return 'reachable';
  return 'offline';
}

export function StatusDot({ status }: { status: DeviceStatus }) {
  const cls =
    status === 'online'
      ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.45)]'
      : status === 'reachable'
        ? 'border-2 border-amber-400 bg-transparent'
        : 'border-2 border-muted-foreground/50 bg-transparent';
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} />;
}

export function StatusLabel({ status }: { status: DeviceStatus }) {
  const t = useT();
  const key = status === 'online' ? 'status.online' : status === 'reachable' ? 'status.reachable' : 'status.offline';
  const cls = status === 'online' ? 'text-emerald-400' : status === 'reachable' ? 'text-amber-400' : 'text-muted-foreground';
  return <span className={`text-[11px] font-medium ${cls}`}>{t(key)}</span>;
}

function BigValue({ value, unit, label, color }: { value: string | number; unit?: string; label: string; color?: string }) {
  return (
    <div className="leading-tight">
      <span className="text-2xl font-bold" style={color ? { color } : undefined}>{value}</span>
      {unit && <span className="ml-0.5 text-sm text-muted-foreground">{unit}</span>}
      <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

// Die 1–3 wichtigsten Live-Werte je Familie (rein anzeigend, keine Steuerung)
function TileValues({ dev }: { dev: DeviceSnapshot }) {
  const t = useT();
  const meta = FAMILY_META[dev.family] ?? FAMILY_META.unknown;

  if (dev.family === 'basepump') {
    const alert = str(dev.state.alert, 'noErrors');
    return (
      <div className="flex items-end justify-between gap-3">
        <BigValue value={num(dev.state.speed)} unit="%" label={t('speed.label')} color={meta.color} />
        <div className="pb-0.5 text-right text-[11px] leading-snug text-muted-foreground">
          <p>{str(dev.state.mode)}</p>
          {alert !== 'noErrors' && <p className="font-medium text-red-400">{alert}</p>}
        </div>
      </div>
    );
  }

  if (dev.family === 'wave') {
    const m = num(dev.state.mode);
    const modeKey = WAVE_MODE_KEYS[m];
    const feeding = num(obj(dev.state.feed).status) === 1;
    return (
      <div className="flex items-end justify-between gap-3">
        <BigValue value={num(dev.state.speed)} unit="%" label={modeKey ? t(modeKey) : t('wave.modeN', { n: m })} color={meta.color} />
        {feeding && <p className="pb-0.5 text-[11px] font-medium text-amber-400">{t('wave.feedingActive')}</p>}
      </div>
    );
  }

  if (dev.family === 'roller') {
    const roll = obj(dev.state.roll);
    const pct = Math.max(0, Math.min(100, Math.round((num(roll.currentLength) / Math.max(1, num(roll.startLength, 1))) * 100)));
    return (
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-bold" style={{ color: meta.color }}>{pct} %</span>
          <span className="text-[11px] text-muted-foreground">
            {t('detail.replaceIn')} ≈ {num(roll.daysToReplace)} {t('detail.days')}
          </span>
        </div>
        <Progress value={pct} className="mt-1.5 h-1.5" />
        <p className="mt-1 text-[11px] text-muted-foreground">{t('roller.fleeceRemaining')}</p>
      </div>
    );
  }

  if (dev.family === 'flare') {
    const on = dev.state.on === true || num(dev.state.on) === 1;
    return (
      <div className="flex items-end justify-between gap-3">
        <BigValue value={num(dev.state.ledTempC)} unit="°C" label={t('detail.temperature')} color={meta.color} />
        <p className="pb-0.5 text-[11px] text-muted-foreground">{on ? t('flare.lightOn') : t('flare.lightOff')}</p>
      </div>
    );
  }

  if (dev.family === 'salinity') {
    // Große Salinität (ppt), klein Leitfähigkeit@25 °C + Temperatur. Roh- und
    // unbekannte Werte (rawH, tempOffsetC, d1-/d2-Paare) bleiben der
    // Detailansicht vorbehalten.
    const sal = num(dev.state.salinityPpt, NaN);
    return (
      <div className="flex items-end justify-between gap-3">
        <BigValue
          value={Number.isFinite(sal) ? sal.toFixed(1) : '—'}
          unit="ppt"
          label={t('salinity.salinity')}
          color={meta.color}
        />
        <div className="pb-0.5 text-right text-[11px] leading-snug text-muted-foreground">
          <p>{fmt1(dev.state.conductivityMs25)} mS/cm</p>
          <p>{fmt1(dev.state.temperatureC)} °C</p>
        </div>
      </div>
    );
  }

  if (dev.family === 'levelSensor') {
    // Eigene Darstellung statt generischer Rohwerte: großer Wasserstand aus
    // covered, Alarm-Badge in Rot (nie grün!). covered/alarm kommen vom
    // lsRefresh-Parser (true | false | 'unknown').
    const covered = dev.state.covered;
    const alarm = dev.state.alarm;
    const label = covered === true ? t('level.above') : covered === false ? t('level.below') : t('level.unknown');
    const color = covered === true || covered === false ? meta.color : undefined;
    return (
      <div className="flex items-end justify-between gap-3">
        <div className="leading-tight">
          <span className={`text-base font-bold ${color ? '' : 'text-muted-foreground'}`} style={color ? { color } : undefined}>
            {label}
          </span>
        </div>
        {alarm === true && (
          <span className="mb-0.5 shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-400">
            {t('level.alarm')}
          </span>
        )}
      </div>
    );
  }

  // Sensoren & übrige Familien: bis zu drei numerische Messwerte aus dem State
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(dev.state)) {
    if (rows.length >= 3) break;
    if (typeof v === 'number' && Number.isFinite(v)) rows.push([k, String(v)]);
    else if (typeof v === 'string' && v) rows.push([k, v]);
  }
  if (rows.length === 0) {
    return <p className="py-1.5 text-[11px] italic text-muted-foreground/70">{t('status.noLiveData')}</p>;
  }
  return (
    <div className="space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-2 text-[13px]">
          <span className="truncate text-muted-foreground">{k}</span>
          <span className="font-mono font-medium" style={{ color: meta.color }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  dev: DeviceSnapshot;
  now: number;
  onOpen: (serial: string) => void;
}

// Kompakte Status-Kachel fürs Dashboard — Klick führt in die Detailansicht
export default function DeviceTile({ dev, now, onOpen }: Props) {
  const t = useT();
  const meta = FAMILY_META[dev.family] ?? FAMILY_META.unknown;
  const { Icon } = meta;
  const status = statusOf(dev);
  const display = deviceDisplayName(dev) || t(meta.nameKey);
  const subtitle = dev.customName ? (dev.name ?? t(meta.nameKey)) : t(meta.nameKey);

  return (
    <button
      type="button"
      onClick={() => onOpen(dev.serial)}
      aria-label={t('tile.openDetail', { name: display })}
      className={`group flex w-full flex-col rounded-xl border border-border/70 bg-card/80 p-3.5 text-left shadow-lg shadow-black/30
        transition-all hover:-translate-y-0.5 hover:border-[#009deb]/50 hover:shadow-xl hover:shadow-black/40
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:ring-offset-2 focus-visible:ring-offset-background
        ${status === 'online' ? '' : 'opacity-55 saturate-50'}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-semibold">{display}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5" title={status === 'reachable' ? t('status.reachableLong') : undefined}>
          <StatusDot status={status} />
          <StatusLabel status={status} />
        </span>
      </div>

      <div className="mt-3 min-h-12 flex-1">
        <TileValues dev={dev} />
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Activity className="h-3 w-3" />
          <Ago lastSeen={dev.lastSeen} now={now} />
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-[#38bdf8]" />
      </div>
    </button>
  );
}
