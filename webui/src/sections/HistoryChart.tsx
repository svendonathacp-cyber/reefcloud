import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, useT } from '@/i18n/I18nContext';
import type { MessageKey } from '@/i18n/messages';
import type { DeviceSnapshot } from '@/types/reef';

// Metrik-Katalog: Einheit + ob diskret (Stufenchart) + i18n-Key.
// Dynamische Doser-Metriken (pumpN.todayMl/fillMl) werden separat gemappt.
const METRIC_INFO: Record<string, { unit: string; discrete?: boolean; key: MessageKey }> = {
  speed: { unit: '%', key: 'history.metric.speed' },
  mode: { unit: '', discrete: true, key: 'history.metric.mode' },
  flow: { unit: '%', key: 'history.metric.flow' },
  temperatureC: { unit: '°C', key: 'history.metric.temperatureC' },
  salinityPpt: { unit: 'ppt', key: 'history.metric.salinityPpt' },
  conductivityMs: { unit: 'mS/cm', key: 'history.metric.conductivityMs' },
  ledTempC: { unit: '°C', key: 'history.metric.ledTempC' },
  todayMl: { unit: 'ml', key: 'history.metric.todayMl' },
  fillMl: { unit: 'ml', key: 'history.metric.fillMl' },
  statusCode: { unit: '', discrete: true, key: 'history.metric.statusCode' },
  covered: { unit: '', discrete: true, key: 'history.metric.covered' },
  alarm: { unit: '', discrete: true, key: 'history.metric.alarm' },
  rollCurrentLength: { unit: 'mm', key: 'history.metric.rollCurrentLength' },
};

interface MetricEntry { serial: string; metric: string; points: number; firstTs: number; lastTs: number }
interface Point { ts: number; value: number }
interface AutoEvent { ts: number; reason: string; serial: string; oldValue: number | null; newValue: number | null }

const RANGES = [
  { id: '24h', spanMs: 86_400_000, key: 'history.range.24h' as MessageKey },
  { id: '7d', spanMs: 7 * 86_400_000, key: 'history.range.7d' as MessageKey },
  { id: '30d', spanMs: 30 * 86_400_000, key: 'history.range.30d' as MessageKey },
  { id: 'max', spanMs: 0, key: 'history.range.max' as MessageKey },
];

async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(path);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error('api-unavailable');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
}

// Doser: pumpN.todayMl / pumpN.fillMl → Label + Einheit
function doserMetric(metric: string): { unit: string; labelKey: MessageKey; n: number } | null {
  const m = /^pump([1-4])\.(todayMl|fillMl)$/.exec(metric);
  if (!m) return null;
  return {
    unit: 'ml',
    labelKey: m[2] === 'todayMl' ? 'history.metric.pumpTodayMl' : 'history.metric.pumpFillMl',
    n: Number(m[1]),
  };
}

// Autolevel-Marker: ▼ rot = „zu voll" (Speed gesenkt), ▲ grün = „zu leer"
// (Speed gehoben). Hover-Titel erklärt den Eingriff (alt → neu).
function EventDot(props: {
  cx?: number; cy?: number; payload?: { reason: string; oldValue: number | null; value: number };
  titleOf: (reason: string, oldValue: number | null, newValue: number) => string;
}) {
  const { cx, cy, payload, titleOf } = props;
  if (cx == null || cy == null || !payload) return null;
  const down = payload.reason === 'tooFull';
  const color = down ? '#f87171' : '#4ade80';
  const pts = down
    ? `${cx - 6},${cy - 4} ${cx + 6},${cy - 4} ${cx},${cy + 6}`
    : `${cx - 6},${cy + 4} ${cx + 6},${cy + 4} ${cx},${cy - 6}`;
  return (
    <polygon points={pts} fill={color} stroke="rgba(2,6,23,0.7)" strokeWidth={1}>
      <title>{titleOf(payload.reason, payload.oldValue, payload.value)}</title>
    </polygon>
  );
}

// Zeitreihen-Karte für die Geräte-Detailansicht. Rendert nichts, wenn der
// Server keine Punkte für dieses Gerät aufgezeichnet hat (History deaktiviert
// oder Gerät ohne Metriken). Daten kommen gebucket vom Server (≤ ~480 Punkte).
export default function HistoryChart({ dev }: { dev: DeviceSnapshot }) {
  const t = useT();
  const { locale } = useI18n();
  const [metrics, setMetrics] = useState<MetricEntry[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [metric, setMetric] = useState<string>('');
  const [range, setRange] = useState<string>('24h');
  const [points, setPoints] = useState<Point[]>([]);
  const [events, setEvents] = useState<AutoEvent[]>([]);
  const [bounds, setBounds] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verfügbare Metriken dieses Geräts laden
  useEffect(() => {
    let alive = true;
    fetchJson('/api/history/metrics')
      .then((j) => {
        if (!alive) return;
        setEnabled(j.enabled !== false);
        const list = (Array.isArray(j.metrics) ? j.metrics : []) as MetricEntry[];
        const mine = list.filter((m) => m.serial === dev.serial);
        setMetrics(mine);
        setMetric((cur) => cur || mine[0]?.metric || '');
      })
      .catch(() => { if (alive) { setEnabled(false); setMetrics([]); } });
    return () => { alive = false; };
  }, [dev.serial]);

  const firstTs = useMemo(
    () => metrics?.find((m) => m.metric === metric)?.firstTs ?? 0,
    [metrics, metric],
  );

  // Punkte laden (60-s-Auto-Refresh im 24-h-Fenster)
  const load = useCallback(async (silent = false) => {
    if (!metric) return;
    const to = Date.now();
    const r = RANGES.find((x) => x.id === range) ?? RANGES[0];
    const from = r.id === 'max' ? Math.max(0, firstTs - 60_000) : to - r.spanMs;
    if (!silent) setLoading(true);
    try {
      const j = await fetchJson(
        `/api/history?serial=${encodeURIComponent(dev.serial)}&metric=${encodeURIComponent(metric)}&from=${from}&to=${to}`);
      setPoints((Array.isArray(j.points) ? j.points : []) as Point[]);
      setBounds({ from, to });
      // Autolevel-Eingriffe als Marker über dem Speed-Chart der RFP
      if (dev.family === 'basepump' && metric === 'speed') {
        try {
          const ej = await fetchJson(`/api/history/events?kind=autolevel&from=${from}&to=${to}`);
          setEvents((Array.isArray(ej.events) ? ej.events : []) as AutoEvent[]);
        } catch { setEvents([]); } // Events sind optional — Chart bleibt ohne Marker nutzbar
      } else {
        setEvents([]);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (!silent) setLoading(false);
  }, [dev.serial, dev.family, metric, range, firstTs]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(true), 60_000);
    return () => clearInterval(iv);
  }, [load]);

  if (!enabled) return null;
  if (metrics && metrics.length === 0) return null;

  const info = METRIC_INFO[metric];
  const dz = doserMetric(metric);
  const unit = info?.unit ?? dz?.unit ?? '';
  const discrete = info?.discrete === true;
  const label = dz
    ? t(dz.labelKey, { n: dz.n })
    : info
      ? t(info.key)
      : metric;

  const spanMs = points.length >= 2 ? points[points.length - 1].ts - points[0].ts : 0;
  const fmtTick = (ts: number) => {
    const d = new Date(ts);
    return spanMs > 36 * 3_600_000
      ? d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  };
  const fmtTooltipTs = (ts: number) => new Date(ts).toLocaleString(locale, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const fmtValue = (v: number) => {
    const s = v.toLocaleString(locale, { maximumFractionDigits: 2 });
    return unit ? `${s} ${unit}` : s;
  };

  // Event-Punkte für die Marker-Linie (nur Eingriffe mit alt/neu, kein staleData)
  const eventPoints = events
    .filter((e) => e.newValue !== null)
    .map((e) => ({ ts: e.ts, value: e.newValue as number, reason: e.reason, oldValue: e.oldValue }));
  const eventTitle = (reason: string, oldV: number | null, newV: number) => {
    const key: MessageKey = reason === 'tooFull' ? 'history.event.tooFull' : 'history.event.tooEmpty';
    return t(key, { old: oldV ?? '?', new: newV });
  };

  return (
    <Card className="border-border bg-card/80 shadow-sm">
      <CardContent className="pt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('history.title')}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {metrics && metrics.length > 1 && (
              <Select value={metric} onValueChange={setMetric}>
                <SelectTrigger className="h-8 w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metrics.map((m) => {
                    const mi = METRIC_INFO[m.metric];
                    const md = doserMetric(m.metric);
                    return (
                      <SelectItem key={m.metric} value={m.metric}>
                        {md ? t(md.labelKey, { n: md.n }) : mi ? t(mi.key) : m.metric}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <Button
                  key={r.id}
                  size="sm"
                  variant={range === r.id ? 'default' : 'outline'}
                  className="h-8 px-2.5"
                  onClick={() => setRange(r.id)}
                >
                  {t(r.key)}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {error ? (
          <p className="py-8 text-center text-sm text-red-400">{error}</p>
        ) : points.length < 2 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {loading ? t('history.loading') : t('history.noData')}
          </p>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={[bounds.from || 'dataMin', bounds.to || 'dataMax']}
                  tickFormatter={fmtTick}
                  tick={{ fontSize: 11, fill: 'rgba(148,163,184,0.8)' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={discrete ? [0, (max: number) => Math.max(1, max)] : ['auto', 'auto']}
                  tick={{ fontSize: 11, fill: 'rgba(148,163,184,0.8)' }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(148,163,184,0.25)',
                    borderRadius: 8, fontSize: 12,
                  }}
                  labelFormatter={(ts) => fmtTooltipTs(Number(ts))}
                  formatter={(value) => [fmtValue(Number(value)), label]}
                />
                <Line
                  type={discrete ? 'stepAfter' : 'monotone'}
                  dataKey="value"
                  stroke="#38bdf8"
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
                {eventPoints.length > 0 && (
                  <Line
                    data={eventPoints}
                    dataKey="value"
                    stroke="none"
                    legendType="none"
                    dot={(p) => <EventDot {...p} titleOf={eventTitle} />}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
