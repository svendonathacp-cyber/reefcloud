import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import type { CommandFn, DeviceSnapshot } from '@/types/reef';

// Wave-Modi (verifiziert 02.08. gegen App-Mitschnitt):
// 1 Konstant {speed} | 2 Puls / 3 Sinus / 4 Zufällig {minSpeed,maxSpeed,period}
const MODES = [
  { id: 1, name: 'Konstant', color: '#9ca3af' },
  { id: 2, name: 'Puls', color: '#67e8f9' },
  { id: 3, name: 'Sinus', color: '#86efac' },
  { id: 4, name: 'Zufällig', color: '#fca5a5' },
] as const;

export interface ScheduleEntry {
  mode: number;
  time: number; // Startminute 0..1439
  speed?: number;
  minSpeed?: number;
  maxSpeed?: number;
  period?: number; // ms
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
const modeMeta = (m: number) => MODES.find((x) => x.id === m) ?? MODES[0];

const W = 960, H = 86, MT = 8, MB = 22;
const xOf = (t: number) => (t / 1440) * W;

interface Props {
  dev: DeviceSnapshot;
  sendCommand: CommandFn;
}

// Zeitplan-Editor im Stil der RF-App: Tagesleiste mit farbigen Modus-Blöcken,
// Block antippen → Modus/Zeit/Parameter bearbeiten, Blöcke hinzufügen/löschen.
export default function WaveScheduleEditor({ dev, sendCommand }: Props) {
  const loadEntries = (): ScheduleEntry[] => {
    const settings = (dev.state.settings ?? {}) as Record<string, unknown>;
    const s = Array.isArray(settings.schedule) ? (settings.schedule as ScheduleEntry[]) : [];
    return s.length ? s.map((e) => ({ ...e })) : [{ mode: 1, time: 0, speed: 50 }];
  };

  const [entries, setEntries] = useState<ScheduleEntry[]>(loadEntries);
  const [sel, setSel] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) { setEntries(loadEntries()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev.state.settings]);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => a.time - b.time),
    [entries],
  );
  const selEntry = sel !== null ? sorted[sel] : null;

  function mutate(fn: (list: ScheduleEntry[]) => void) {
    setEntries((prev) => {
      const next = prev.map((e) => ({ ...e }));
      fn(next);
      return next;
    });
    setDirty(true);
  }

  // WICHTIG: mutate() kopiert die Einträge. Die Position des ausgewählten Blocks
  // deshalb VOR dem Kopieren im Original-Array bestimmen — indexOf() auf der
  // Kopie würde sonst -1 liefern und die UI crashen.
  const selectedIndex = () => (sel === null ? -1 : entries.indexOf(sorted[sel]));

  function setMode(mode: number) {
    const idx = selectedIndex();
    if (idx < 0) return;
    mutate((list) => {
      const e = list[idx];
      if (!e) return;
      const fresh: ScheduleEntry = mode === 1
        ? { mode: 1, time: e.time, speed: e.speed ?? e.maxSpeed ?? 50 }
        : {
            mode, time: e.time,
            minSpeed: e.minSpeed ?? 40,
            maxSpeed: e.maxSpeed ?? e.speed ?? 80,
            period: e.period ?? 10000,
          };
      list[idx] = fresh;
    });
  }

  function nudgeTime(delta: number) {
    const idx = selectedIndex();
    if (idx < 0 || sel === null) return;
    mutate((list) => {
      const e = list[idx];
      if (!e) return;
      const prev = sorted[sel - 1];
      const next = sorted[sel + 1];
      e.time = clamp(e.time + delta, prev ? prev.time + 5 : 0, next ? next.time - 5 : 1439);
    });
  }

  function setParam(key: 'speed' | 'minSpeed' | 'maxSpeed' | 'period', value: number) {
    const idx = selectedIndex();
    if (idx < 0) return;
    mutate((list) => {
      const e = list[idx];
      if (e) e[key] = value;
    });
  }

  function addBlock() {
    mutate((list) => {
      const base = sel !== null ? sorted[sel] : sorted[sorted.length - 1];
      if (!base) return;
      const next = sel !== null ? sorted[sel + 1] : null;
      const t = clamp(base.time + 60, base.time + 5, next ? next.time - 5 : 1435);
      const fresh = { ...base, time: t };
      list.push(fresh);
      setSel([...list].sort((a, b) => a.time - b.time).indexOf(fresh));
    });
  }

  function removeBlock() {
    const idx = selectedIndex();
    if (idx < 0 || sorted.length <= 1) return;
    mutate((list) => { list.splice(idx, 1); });
    setSel(null);
  }

  async function save() {
    setBusy(true);
    try {
      await sendCommand(dev.serial, 'setSchedule', { schedule: sorted });
      toast.success('Zeitplan an die Pumpe gesendet');
      setDirty(false);
    } catch (e) {
      toast.error(`Fehler: ${e instanceof Error ? e.message : e}`);
    }
    setBusy(false);
  }

  const paramRows = selEntry
    ? selEntry.mode === 1
      ? [{ key: 'speed' as const, label: 'Leistung', value: selEntry.speed ?? 0, min: 0, max: 100, step: 1, fmt: (v: number) => `${v} %` }]
      : [
          { key: 'minSpeed' as const, label: 'Minimale Leistung', value: selEntry.minSpeed ?? 0, min: 0, max: 100, step: 1, fmt: (v: number) => `${v} %` },
          { key: 'maxSpeed' as const, label: 'Maximale Leistung', value: selEntry.maxSpeed ?? 0, min: 0, max: 100, step: 1, fmt: (v: number) => `${v} %` },
          { key: 'period' as const, label: 'Frequenz', value: (selEntry.period ?? 10000) / 1000, min: 0.5, max: 20, step: 0.5, fmt: (v: number) => `${v.toFixed(1)} s` },
        ]
    : [];

  return (
    <div className="mt-3">
      {/* Tagesleiste */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none rounded-lg border border-border/60 bg-white">
        {sorted.map((e, i) => {
          const end = sorted[i + 1]?.time ?? 1440;
          const meta = modeMeta(e.mode);
          const active = sel === i;
          return (
            <g key={i} onClick={() => setSel(active ? null : i)} className="cursor-pointer">
              <rect
                x={xOf(e.time)} y={MT} width={Math.max(2, xOf(end) - xOf(e.time))} height={H - MT - MB}
                fill={meta.color} opacity={active ? 1 : 0.65}
                stroke={active ? '#0f172a' : 'none'} strokeWidth={active ? 1.5 : 0}
              >
                <title>{`${meta.name} ab ${fmtT(e.time)}`}</title>
              </rect>
              {xOf(end) - xOf(e.time) > 52 && (
                <text x={xOf(e.time) + 5} y={MT + 14} fontSize="11" fill="#1f2937" opacity="0.8" pointerEvents="none">
                  {meta.name}
                </text>
              )}
            </g>
          );
        })}
        {Array.from({ length: 7 }, (_, i) => i * 240).map((t) => (
          <text key={t} x={xOf(t)} y={H - 6} fontSize="11" fill="#8aa0b4" textAnchor="middle">{fmtT(t)}</text>
        ))}
      </svg>

      {selEntry ? (
        <div className="mt-3 space-y-3">
          {/* Modus-Kacheln wie in der RF-App */}
          <div className="grid grid-cols-4 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  selEntry.mode === m.id ? 'border-[#009deb] bg-[#e6f4fd] text-[#009deb]' : 'border-border text-muted-foreground'
                }`}
              >
                <span className="mx-auto mb-1 block h-3 w-8 rounded-sm" style={{ background: m.color }} />
                {m.name}
              </button>
            ))}
          </div>

          {/* Block-Start */}
          <div className="flex items-center justify-center gap-3 text-sm">
            <span className="text-muted-foreground">Beginnt</span>
            <Button variant="outline" size="sm" onClick={() => nudgeTime(-5)}>−5 min</Button>
            <span className="w-16 text-center text-lg font-bold text-[#009deb]">{fmtT(selEntry.time)}</span>
            <Button variant="outline" size="sm" onClick={() => nudgeTime(5)}>+5 min</Button>
          </div>

          {/* Parameter je Modus */}
          {paramRows.map((r) => (
            <div key={r.key} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-mono text-sm font-semibold text-[#17c3d6]">{r.fmt(r.value)}</span>
              </div>
              <Slider
                value={[r.value]} min={r.min} max={r.max} step={r.step} disabled={!dev.online || busy}
                onValueChange={([v]) => setParam(r.key, r.key === 'period' ? Math.round(v * 1000) : v)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Block antippen zum Bearbeiten — Modus, Startzeit und Parameter je Block.
        </p>
      )}

      {/* Aktionen */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button size="sm" className="bg-green-500 text-white hover:bg-green-600" onClick={addBlock} disabled={sorted.length >= 12}>
            <Plus className="mr-1 h-4 w-4" /> Block
          </Button>
          <Button size="sm" variant="destructive" onClick={removeBlock} disabled={sel === null || sorted.length <= 1}>
            <Trash2 className="mr-1 h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!dirty || busy} onClick={() => { setEntries(loadEntries()); setDirty(false); setSel(null); }}>
            Abbrechen
          </Button>
          <Button size="sm" className="bg-[#009deb] text-white hover:bg-[#0088cc]" disabled={!dev.online || !dirty || busy} onClick={() => void save()}>
            {busy ? 'Sende…' : 'Übernehmen'}
          </Button>
        </div>
      </div>
    </div>
  );
}
