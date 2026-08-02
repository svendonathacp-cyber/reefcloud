import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  BasepumpBody, deviceDisplayName, FlareBody, FAMILY_META, GenericBody, RollerBody, WaveBody, WAVE_MODE_KEYS,
} from './DeviceCard';
import { StatusDot, StatusLabel, statusOf } from './DeviceTile';
import AutolevelSection from './AutolevelSection';
import FlareProgramEditor from './FlareProgramEditor';
import { useT } from '@/i18n/I18nContext';
import type { CommandFn, DeviceSnapshot, SetNicknameFn } from '@/types/reef';

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
        <span className={`text-3xl font-bold ${accent ? 'text-[#38bdf8]' : 'text-foreground'}`}>{value}</span>
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
  const t = useT();
  switch (dev.family) {
    case 'basepump':
      return (
        <>
          <BigStat label={t('speed.label')} value={num(dev.state.speed)} unit="%" />
          <BigStat label={t('common.mode')} value={str(dev.state.mode)} accent={false} />
          <BigStat label={t('basepump.feeding')} value={`${num(dev.state.feedModeTime)} min`} accent={false} />
        </>
      );
    case 'wave': {
      const m = num(dev.state.mode);
      const modeKey = WAVE_MODE_KEYS[m];
      return (
        <>
          <BigStat label={t('speed.label')} value={num(dev.state.speed)} unit="%" />
          <BigStat label={t('common.mode')} value={modeKey ? t(modeKey) : m} accent={false} />
          <BigStat label={t('wave.clock')} value={clockFmt(dev.state.clock)} accent={false} />
        </>
      );
    }
    case 'roller': {
      const roll = obj(dev.state.roll);
      const pct = Math.round((num(roll.currentLength) / Math.max(1, num(roll.startLength, 1))) * 100);
      return (
        <>
          <BigStat label={t('detail.fleece')} value={pct} unit="%" />
          <BigStat label={t('detail.replaceIn')} value={num(roll.daysToReplace)} unit={t('detail.days')} accent={false} />
          <BigStat label={t('detail.today')} value={num(roll.todayUsed)} unit="mm" accent={false} />
        </>
      );
    }
    case 'flare': {
      const channels = Array.isArray(dev.state.channels) ? (dev.state.channels as unknown[]).map((c) => num(c)) : [];
      const on = dev.state.on === true || num(dev.state.on) === 1;
      return (
        <>
          <BigStat label={t('detail.temperature')} value={num(dev.state.ledTempC)} unit="°C" />
          <BigStat label={t('detail.status')} value={on ? t('common.on') : t('common.off')} accent={false} />
          <BigStat label={t('detail.maxChannel')} value={channels.length ? Math.max(...channels) : 0} unit="%" accent={false} />
        </>
      );
    }
    default:
      return null;
  }
}

// Inline-Editor für den Spitznamen (POST /api/devices/name, leer = löschen)
function NicknameEditor({ dev, setNickname }: { dev: DeviceSnapshot; setNickname: SetNicknameFn }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const name = value.trim().slice(0, 40);
    if (name === (dev.customName ?? '')) { setEditing(false); return; }
    setBusy(true);
    try {
      await setNickname(dev.serial, name);
      toast.success(t(name ? 'nickname.saved' : 'nickname.removed'));
      setEditing(false);
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(false);
  };

  if (!editing) {
    return dev.customName ? (
      <button
        type="button"
        onClick={() => { setValue(dev.customName ?? ''); setEditing(true); }}
        title={t('nickname.edit')}
        aria-label={t('nickname.edit')}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-[#38bdf8]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
      >
        <Pencil className="h-4 w-4" />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => { setValue(''); setEditing(true); }}
        className="flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground
          transition-colors hover:border-[#009deb]/60 hover:text-[#38bdf8]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
      >
        <Pencil className="h-3 w-3" />
        {t('nickname.set')}
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        maxLength={40}
        disabled={busy}
        placeholder={t('nickname.placeholder')}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="h-8 w-56 max-w-[60vw]"
      />
      <Button size="icon" variant="ghost" className="h-8 w-8 text-emerald-400" disabled={busy}
        onClick={() => void save()} aria-label={t('common.apply')}>
        <Check className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" disabled={busy}
        onClick={() => setEditing(false)} aria-label={t('common.cancel')}>
        <X className="h-4 w-4" />
      </Button>
    </span>
  );
}

interface Props {
  dev: DeviceSnapshot;
  devices: DeviceSnapshot[]; // alle Geräte (Sensor-Auswahl der Autolevel-Sektion)
  now: number;
  sendCommand: CommandFn;
  setNickname: SetNicknameFn;
}

// Geräte-Detailseite im Stil der Reef-Factory-Einstellungsseiten
export default function DeviceDetail({ dev, devices, now, sendCommand, setNickname }: Props) {
  const t = useT();
  const meta = FAMILY_META[dev.family] ?? FAMILY_META.unknown;
  const { Icon } = meta;
  const hasControls = ['basepump', 'wave', 'roller'].includes(dev.family);
  const status = statusOf(dev);
  const display = deviceDisplayName(dev) || t(meta.nameKey);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="border-b border-border pb-4 pt-2 text-center">
        <div
          className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${meta.color}1f` }}
        >
          <Icon className="h-6 w-6" style={{ color: meta.color }} />
        </div>
        <div className="flex items-center justify-center gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{display}</h2>
          <NicknameEditor dev={dev} setNickname={setNickname} />
        </div>
        <p className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {dev.customName && dev.name && <><span>{dev.name}</span>·</>}
          <span>{t(meta.nameKey)}</span>·<span className="font-mono text-xs">{dev.serial}</span>·
          <span className="flex items-center gap-1.5" title={status === 'reachable' ? t('status.reachableLong') : undefined}>
            <StatusDot status={status} />
            <StatusLabel status={status} />
          </span>
        </p>
      </div>

      <div className="flex items-start justify-center divide-x divide-border py-6">
        <StatsRow dev={dev} />
      </div>

      <Card className="border-border bg-card/80 shadow-sm">
        <CardContent className="pt-5">
          {dev.family === 'basepump' && (
            <>
              <BasepumpBody dev={dev} sendCommand={sendCommand} />
              <AutolevelSection dev={dev} devices={devices} />
            </>
          )}
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
              {t('detail.readonlyNote')}
            </p>
          )}
        </CardContent>
      </Card>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        {dev.firmware ? t('detail.firmware', { v: dev.firmware }) : t('detail.firmwareUnknown')} · {dev.ip || t('detail.ipUnknown')} ·
        {' '}{now && dev.lastSeen
          ? t('detail.lastSeen', { s: Math.max(0, Math.round((now - dev.lastSeen) / 1000)) })
          : t('time.never')}
      </p>
    </div>
  );
}
