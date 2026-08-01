import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FlareProgram } from '@/types/reef';

// Kanäle der Reef flare M (App-Modell, 7 Kanäle — Reihenfolge wie im RF-Export)
const CHANNELS = [
  { name: 'UV', color: '#7c3aed' },
  { name: 'Violett', color: '#a855f7' },
  { name: 'Indigo', color: '#6366f1' },
  { name: 'Blau', color: '#3b82f6' },
  { name: 'Grün', color: '#22c55e' },
  { name: 'Rot', color: '#ef4444' },
  { name: 'Weiß', color: '#94a3b8' },
];

const DEFAULT_PROGRAM: FlareProgram = {
  name: 'Mein Programm',
  intensity: 70,
  points: [
    { t: 0, l: [0, 0, 0, 0, 0, 0, 0] },
    { t: 1440, l: [0, 0, 0, 0, 0, 0, 0] },
  ],
};

// SVG-Geometrie
const W = 960, H = 300, ML = 14, MR = 14, MT = 34, MB = 30;
const xOf = (t: number) => ML + (t / 1440) * (W - ML - MR);
const yOf = (v: number) => MT + (1 - v) * (H - MT - MB);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtT = (t: number) => `${Math.floor((t % 1440) / 60)}:${String(t % 60).padStart(2, '0')}`;

interface Props {
  serial: string;
}

// Lichtprogramm-Editor im Stil der RF-Cloud: 24h-Kurven pro Kanal, Punkte ziehen,
// Werte pro Kanal am ausgewählten Punkt einstellen, Gesamtintensität regeln.
export default function FlareProgramEditor({ serial }: Props) {
  const [program, setProgram] = useState<FlareProgram>(DEFAULT_PROGRAM);
  const [sel, setSel] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ idx: number; ch: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/program?serial=${encodeURIComponent(serial)}`);
      const j = await r.json();
      setProgram(j.program ?? DEFAULT_PROGRAM);
    } catch {
      setProgram(DEFAULT_PROGRAM);
    } finally {
      setLoaded(true);
      setDirty(false);
      setSel(null);
    }
  }, [serial]);

  useEffect(() => { void load(); }, [load]);

  const sorted = program.points; // server sortiert; im Editor halten wir die Ordnung selbst
  const selPt = sel !== null ? sorted[sel] : null;

  function mutate(fn: (p: FlareProgram) => FlareProgram) {
    setProgram((p) => fn(structuredClone(p)));
    setDirty(true);
  }

  // Pointer → Chart-Koordinaten
  function chartPos(e: React.PointerEvent): { t: number; v: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    const t = ((sx - ML) / (W - ML - MR)) * 1440;
    const v = 1 - (sy - MT) / (H - MT - MB);
    return { t, v };
  }

  function onHandleDown(idx: number, ch: number) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { idx, ch };
      setSel(idx);
      svgRef.current?.setPointerCapture(e.pointerId);
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const { t, v } = chartPos(e);
    mutate((p) => {
      const pt = p.points[d.idx];
      const prev = p.points[d.idx - 1];
      const next = p.points[d.idx + 1];
      // Zeit: auf 5 Min runden, zwischen den Nachbarn bleiben
      const lo = prev ? prev.t + 5 : 0;
      const hi = next ? next.t - 5 : 1440;
      pt.t = clamp(Math.round(t / 5) * 5, lo, hi);
      // Wert: nur den gezogenen Kanal dieses Punkts
      pt.l[d.ch] = clamp(Math.round(v * 100) / 100, 0, 1);
      return p;
    });
  }

  function onPointerUp() { dragRef.current = null; }

  function addPoint() {
    mutate((p) => {
      const base = sel !== null ? p.points[sel] : p.points[p.points.length - 2] ?? p.points[0];
      const t = clamp((base?.t ?? 690) + 30, 5, 1435);
      const pt = { t, l: [...(base?.l ?? [0, 0, 0, 0, 0, 0, 0])] };
      p.points.push(pt);
      p.points.sort((a, b) => a.t - b.t);
      setSel(p.points.indexOf(pt));
      return p;
    });
  }

  function removePoint() {
    if (sel === null || sorted.length <= 2) return;
    mutate((p) => { p.points.splice(sel, 1); return p; });
    setSel(null);
  }

  function nudgeTime(delta: number) {
    if (sel === null) return;
    mutate((p) => {
      const pt = p.points[sel];
      const prev = p.points[sel - 1];
      const next = p.points[sel + 1];
      pt.t = clamp(pt.t + delta, prev ? prev.t + 5 : 0, next ? next.t - 5 : 1440);
      return p;
    });
  }

  function setChannelValue(ch: number, pct: number) {
    if (sel === null) return;
    mutate((p) => { p.points[sel].l[ch] = clamp(pct, 0, 100) / 100; return p; });
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch('/api/program', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serial, program }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast.success('Programm gespeichert', {
        description: 'Upload zur Lampe folgt, sobald das Schreib-Protokoll verifiziert ist.',
      });
      setDirty(false);
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();

  return (
    <div className="mt-6 border-t border-border/60 pt-5">
      {/* Tabs wie in der RF-App (nur PROGRAMME aktiv) */}
      <div className="mb-4 flex items-center justify-center gap-6 text-xs font-semibold uppercase tracking-wider">
        <span className="text-foreground">Programme</span>
        <span className="cursor-not-allowed text-muted-foreground/50" title="folgt">Zeitschaltmodus</span>
        <span className="cursor-not-allowed text-muted-foreground/50" title="folgt">Ausschalten</span>
      </div>

      {/* Name + Intensität */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          value={program.name}
          onChange={(e) => mutate((p) => ({ ...p, name: e.target.value }))}
          className="h-8 w-48 text-sm"
          placeholder="Programmname"
        />
        <div className="flex min-w-56 flex-1 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground">Gesamtintensität</span>
          <input
            type="range" min={0} max={100} value={program.intensity}
            onChange={(e) => mutate((p) => ({ ...p, intensity: Number(e.target.value) }))}
            className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-amber-100 accent-amber-400"
          />
          <span className="w-10 text-right text-sm font-semibold text-amber-500">{program.intensity} %</span>
        </div>
      </div>

      {/* Kurven-Chart */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none rounded-lg border border-border/60 bg-white"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {/* horizontale Hilfslinien */}
        {[0.25, 0.5, 0.75].map((v) => (
          <line key={v} x1={ML} x2={W - MR} y1={yOf(v)} y2={yOf(v)} stroke="#e5edf3" strokeDasharray="4 4" />
        ))}
        {/* Zeitachse */}
        {Array.from({ length: 7 }, (_, i) => i * 240).map((t) => (
          <g key={t}>
            <line x1={xOf(t)} x2={xOf(t)} y1={MT} y2={H - MB} stroke="#eef3f7" />
            <text x={xOf(t)} y={H - 10} textAnchor="middle" fontSize="13" fill="#8aa0b4">{fmtT(t)}</text>
          </g>
        ))}
        {/* Jetzt-Marker */}
        <line x1={xOf(nowMin)} x2={xOf(nowMin)} y1={MT - 6} y2={H - MB} stroke="#009deb" strokeWidth="1.5" strokeDasharray="2 3" />

        {/* Kurven pro Kanal */}
        {CHANNELS.map((c, ch) => (
          <polyline
            key={c.name}
            points={sorted.map((pt) => `${xOf(pt.t)},${yOf(pt.l[ch] ?? 0)}`).join(' ')}
            fill="none" stroke={c.color} strokeWidth="2" strokeLinejoin="round" opacity="0.85"
          />
        ))}

        {/* Punkte (ziehbare Handles) */}
        {sorted.map((pt, i) =>
          CHANNELS.map((c, ch) => {
            const active = sel === i;
            const size = active ? 11 : 8;
            return (
              <rect
                key={`${i}-${ch}`}
                x={xOf(pt.t) - size / 2}
                y={yOf(pt.l[ch] ?? 0) - size / 2}
                width={size} height={size}
                fill={c.color}
                stroke={active ? '#0f172a' : 'white'}
                strokeWidth={active ? 1.5 : 1}
                className="cursor-grab"
                onPointerDown={onHandleDown(i, ch)}
              >
                <title>{`${c.name} · ${fmtT(pt.t)} · ${Math.round((pt.l[ch] ?? 0) * 100)} %`}</title>
              </rect>
            );
          }),
        )}

        {/* Zeit-Bubble über dem ausgewählten Punkt */}
        {selPt && (
          <g>
            <rect
              x={clamp(xOf(selPt.t) - 34, 2, W - 70)} y={2} width={68} height={24} rx={6}
              fill="#009deb"
            />
            <text x={clamp(xOf(selPt.t), 36, W - 36)} y={19} textAnchor="middle" fontSize="13" fontWeight="bold" fill="white">
              {fmtT(selPt.t)}
            </text>
          </g>
        )}
      </svg>

      {/* Ausgewählter Punkt: Zeit + Kanalwerte */}
      {selPt ? (
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-center gap-3 text-sm">
            <span className="text-muted-foreground">Punkt</span>
            <Button variant="outline" size="sm" onClick={() => nudgeTime(-5)}>−5 min</Button>
            <span className="w-16 text-center text-lg font-bold text-[#009deb]">{fmtT(selPt.t)}</span>
            <Button variant="outline" size="sm" onClick={() => nudgeTime(5)}>+5 min</Button>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {CHANNELS.map((c, ch) => {
              const pct = Math.round((selPt.l[ch] ?? 0) * 100);
              return (
                <div key={c.name} className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} />
                  <span className="w-14 text-xs text-muted-foreground">{c.name}</span>
                  <input
                    type="range" min={0} max={100} value={pct}
                    onChange={(e) => setChannelValue(ch, Number(e.target.value))}
                    className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-100"
                    style={{ accentColor: c.color }}
                  />
                  <span className="w-12 text-right text-xs font-semibold tabular-nums">{pct} %</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Punkt antippen zum Bearbeiten — horizontal ziehen = Uhrzeit, vertikal = Kanalwert.
        </p>
      )}

      {/* Aktionen */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button size="sm" className="bg-green-500 text-white hover:bg-green-600" onClick={addPoint}>
            <Plus className="mr-1 h-4 w-4" /> Punkt hinzufügen
          </Button>
          <Button
            size="sm" variant="destructive" onClick={removePoint}
            disabled={sel === null || sorted.length <= 2}
          >
            <Trash2 className="mr-1 h-4 w-4" /> Punkt löschen
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={!dirty}>
            Abbrechen
          </Button>
          <Button size="sm" className="bg-[#009deb] text-white hover:bg-[#0088cc]" onClick={() => void save()} disabled={!dirty || saving || !loaded}>
            {saving ? 'Speichere…' : 'O.K.'}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Gespeichert wird das Programm in der reef-cloud — das Hochladen auf die Lampe wird
        freigeschaltet, sobald der rfPrecise-Schreibpfad aus einem App-Mitschnitt verifiziert ist.
      </p>
    </div>
  );
}
