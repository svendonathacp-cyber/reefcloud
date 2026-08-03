import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n, useT } from '@/i18n/I18nContext';
import type { MessageKey } from '@/i18n/messages';
import type { CommandFn, DeviceSnapshot, DoserHistoryEntry, DoserPump } from '@/types/reef';
import { doserPumps } from '@/types/reef';

// Pumpen-Modi (reef-doser.mjs DZ_MODE) → i18n
const MODE_KEYS: Record<number, MessageKey> = {
  0: 'doser.mode.0', 1: 'doser.mode.1', 2: 'doser.mode.2', 3: 'doser.mode.3', 4: 'doser.mode.4',
};

// Wochentag-Bits: bit0=So … bit6=Sa (Geräte-JS getDay()-Konvention)
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const; // Anzeige Mo…So
const WEEKDAY_KEYS: Record<number, MessageKey> = {
  0: 'doser.weekday.0', 1: 'doser.weekday.1', 2: 'doser.weekday.2', 3: 'doser.weekday.3',
  4: 'doser.weekday.4', 5: 'doser.weekday.5', 6: 'doser.weekday.6',
};

const num = (v: unknown, d = NaN) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function fmtClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// History-Typ → i18n-Key (Geräte-JS: 1=Auto, 2=manuell, 3=beides, 4=Skip %,
// 5/6=verzögert, 7-10=Korrektur ml/%, 11=übersprungen)
function historyTypeKey(type: number): MessageKey {
  if (type === 1) return 'doser.history.auto';
  if (type === 2 || type === 5 || type === 6) return 'doser.history.manual';
  if (type === 3) return 'doser.history.dose';
  if (type === 4 || type === 11) return 'doser.history.skipped';
  if (type >= 7 && type <= 10) return 'doser.history.adjust';
  return 'doser.history.event';
}

// „Nächste Dosierung" clientseitig aus dem Zeitplan (wie das Geräte-UI):
// frühester belegter Slot (ml > 0) mit Zeit > jetzt am heutigen Wochentag,
// sonst erster Slot des nächsten aktivierten Wochentags (bis 7 Tage voraus).
function nextDose(pump: DoserPump, now: number): { ml: number; minutes: number; dayOffset: number } | null {
  const slots = (pump.schedule ?? []).filter((s) => s && s.ml > 0);
  if (!slots.length) return null;
  const mask = pump.weekdayMask ?? 0x7f;
  const d = new Date(now);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  for (let off = 0; off <= 7; off++) {
    const wd = (d.getDay() + off) % 7;
    if (!(mask & (1 << wd))) continue;
    const cand = slots
      .filter((s) => off > 0 || s.minutes > nowMin)
      .sort((a, b) => a.minutes - b.minutes)[0];
    if (cand) return { ml: cand.ml, minutes: cand.minutes, dayOffset: off };
  }
  return null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

type RunFn = (action: string, params: Record<string, unknown>, label: string) => Promise<void>;

interface DialogProps {
  dev: DeviceSnapshot;
  pump: DoserPump;
  busy: string | null;
  run: RunFn;
}

// ---------- Behälter bearbeiten (dzSet/container) ----------
function ContainerDialog({ dev, pump, busy, run }: DialogProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [capacity, setCapacity] = useState('');
  const save = async () => {
    const c = Number(current.replace(',', '.'));
    const k = Number(capacity.replace(',', '.'));
    if (!Number.isFinite(c) || c < 0 || c > 100000 || !Number.isFinite(k) || k <= 0 || k > 100000) {
      toast.error(t('doser.container.invalid'));
      return;
    }
    await run('setContainer', { pump: pump.index, currentMl: c, capacityMl: k }, t('doser.action.container'));
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o) { setCurrent(String(num(pump.fillMl, 0))); setCapacity(String(num(pump.capacityMl, 0))); }
    }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
          {busy === 'setContainer' ? '…' : t('doser.action.container')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('doser.container.title')}</DialogTitle>
          <DialogDescription>{t('doser.container.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">{t('doser.container.current')}</label>
            <Input inputMode="decimal" value={current} onChange={(e) => setCurrent(e.target.value)} className="w-44" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">{t('doser.container.capacity')}</label>
            <Input inputMode="decimal" value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-44" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={busy !== null}>{t('common.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Kalibrierung (dzCalibration start/value/stop/notification) ----------
function CalibrateDialog({ dev, pump, busy, run }: DialogProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [ml, setMl] = useState('');
  const calibrating = num(pump.mode) === 4;
  const countdown = num(pump.calCountdownS, 0);
  const NOTIFY: MessageKey[] = [
    'doser.calibrate.notify.0', 'doser.calibrate.notify.1',
    'doser.calibrate.notify.2', 'doser.calibrate.notify.3',
  ];
  const sendValue = async () => {
    const v = Number(ml.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > 100000) {
      toast.error(t('doser.manual.invalid'));
      return;
    }
    await run('calibrateValue', { pump: pump.index, ml: v }, t('doser.calibrate.value'));
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
          {t('doser.action.calibrate')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('doser.calibrate.title')}</DialogTitle>
          <DialogDescription>{t('doser.calibrate.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {calibrating && (
            <Badge variant="secondary">{t('doser.calibrate.running', { s: countdown })}</Badge>
          )}
          {/* Schritt 1: Start / Stopp */}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!dev.online || busy !== null || calibrating}
              onClick={() => void run('calibrateStart', { pump: pump.index }, t('doser.calibrate.start'))}>
              {busy === 'calibrateStart' ? '…' : t('doser.calibrate.start')}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={!dev.online || busy !== null || !calibrating}>
                  {busy === 'calibrateStop' ? '…' : t('doser.calibrate.stop')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('doser.calibrate.stop')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('doser.calibrate.stopDesc')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void run('calibrateStop', { pump: pump.index }, t('doser.calibrate.stop'))}>
                    {t('common.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          {/* Schritt 2: gemessene Menge eintragen + senden */}
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <label className="text-sm text-muted-foreground">{t('doser.calibrate.value')}</label>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" value={ml} onChange={(e) => setMl(e.target.value)} className="w-44" />
              <Button size="sm" variant="secondary" disabled={!dev.online || busy !== null || !ml}
                onClick={() => void sendValue()}>
                {busy === 'calibrateValue' ? '…' : t('doser.calibrate.send')}
              </Button>
            </div>
          </div>
          {/* Erinnerungs-Intervall */}
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <p className="text-sm text-muted-foreground">{t('doser.calibrate.notify')}</p>
            <p className="text-xs text-muted-foreground/70">{t('doser.calibrate.notifyDesc')}</p>
            <div className="grid grid-cols-2 gap-2">
              {NOTIFY.map((key, idx) => (
                <Button key={key} size="sm" variant="outline" disabled={!dev.online || busy !== null}
                  onClick={() => void run('calibrateNotification', { pump: pump.index, interval: idx }, t('doser.calibrate.notify'))}>
                  {busy === 'calibrateNotification' ? '…' : t(key)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Manuelles Dosieren (dzManualRefill start/stop, Modus 0 = sofort) ----------
function ManualDoseDialog({ dev, pump, busy, run }: DialogProps) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [ml, setMl] = useState('');
  const running = num(pump.mode) === 2;
  const done = num(pump.refillDoneMl, NaN);
  const target = num(pump.refillTargetMl, NaN);
  const fmt = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 2 });
  const start = async () => {
    const v = Number(ml.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > 100000) {
      toast.error(t('doser.manual.invalid'));
      return;
    }
    await run('manualDose', { pump: pump.index, ml: v }, t('doser.action.manual'));
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setMl(''); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
          {t('doser.action.manual')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('doser.manual.title')}</DialogTitle>
          <DialogDescription>{t('doser.manual.desc')}</DialogDescription>
        </DialogHeader>
        {running && Number.isFinite(done) && Number.isFinite(target) && target > 0 && (
          <div>
            <p className="text-sm text-muted-foreground">
              {t('doser.manual.progress', { done: fmt(done), target: fmt(target) })}
            </p>
            <Progress value={Math.min(100, (done / target) * 100)} className="mt-1.5 h-2" />
          </div>
        )}
        <div className="space-y-1.5">
          <label className="text-sm text-muted-foreground">{t('doser.manual.amount')}</label>
          <Input inputMode="decimal" value={ml} onChange={(e) => setMl(e.target.value)} className="w-44" />
        </div>
        <DialogFooter>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={!dev.online || busy !== null || !running}>
                {busy === 'manualStop' ? '…' : t('doser.manual.stop')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('doser.manual.stop')}</AlertDialogTitle>
                <AlertDialogDescription>{t('doser.manual.stopDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run('manualStop', { pump: pump.index }, t('doser.manual.stop'))}>
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button onClick={() => void start()} disabled={!dev.online || busy !== null || !ml}>
            {busy === 'manualDose' ? '…' : t('doser.manual.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Zeitplan-Editor (dzSet/doses: bis 24 Slots + Wochentage) ----------
interface SlotEdit { time: string; ml: string }

function ScheduleDialog({ dev, pump, busy, run }: DialogProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<SlotEdit[]>([]);
  const [mask, setMask] = useState(0x7f);

  const openEditor = (o: boolean) => {
    setOpen(o);
    if (o) {
      const used = (pump.schedule ?? []).filter((s) => s && s.ml > 0);
      setSlots(used.length
        ? used.map((s) => ({ time: fmtClock(s.minutes), ml: String(s.ml) }))
        : [{ time: '', ml: '' }]);
      setMask(pump.weekdayMask ?? 0x7f);
    }
  };

  const setSlot = (i: number, patch: Partial<SlotEdit>) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = async () => {
    const parsed: { ml: number; minutes: number }[] = [];
    for (const s of slots) {
      if (!s.time && !s.ml) continue; // komplett leere Zeile ignorieren
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.time.trim());
      const v = Number(s.ml.replace(',', '.'));
      if (!m || !Number.isFinite(v) || v <= 0 || v > 100000) {
        toast.error(t('doser.schedule.invalid'));
        return;
      }
      parsed.push({ ml: v, minutes: Number(m[1]) * 60 + Number(m[2]) });
    }
    if (!parsed.length) {
      toast.error(t('doser.schedule.empty'));
      return;
    }
    if (parsed.length > 24) {
      toast.error(t('doser.schedule.invalid'));
      return;
    }
    await run('setSchedule', { pump: pump.index, slots: parsed, weekdayMask: mask }, t('doser.action.schedule'));
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={openEditor}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
          {t('doser.action.schedule')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('doser.schedule.title')}</DialogTitle>
          <DialogDescription>{t('doser.schedule.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_auto] items-center gap-2 text-xs text-muted-foreground">
            <span>{t('doser.schedule.time')}</span>
            <span className="pr-8">{t('doser.schedule.amount')}</span>
          </div>
          {slots.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
              <Input inputMode="numeric" placeholder="HH:MM" value={s.time}
                onChange={(e) => setSlot(i, { time: e.target.value })} className="w-24" />
              <Input inputMode="decimal" placeholder="ml" value={s.ml}
                onChange={(e) => setSlot(i, { ml: e.target.value })} className="w-24" />
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-red-400"
                disabled={slots.length <= 1}
                onClick={() => setSlots((prev) => prev.filter((_, j) => j !== i))}
                aria-label={t('common.cancel')}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" disabled={slots.length >= 24}
            onClick={() => setSlots((prev) => [...prev, { time: '', ml: '' }])}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('doser.schedule.add')}
          </Button>
        </div>
        <div className="space-y-1.5 border-t border-border/60 pt-3">
          <p className="text-sm text-muted-foreground">{t('doser.schedule.weekdays')}</p>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_ORDER.map((wd) => (
              <Button key={wd} size="sm" variant={mask & (1 << wd) ? 'default' : 'outline'}
                onClick={() => setMask((m) => m ^ (1 << wd))}>
                {t(WEEKDAY_KEYS[wd])}
              </Button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={busy !== null}>
            {busy === 'setSchedule' ? '…' : t('doser.schedule.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Pumpe umbenennen (dzSet/name, UTF-16BE, max. 16 Zeichen) ----------
function RenameDialog({ dev, pump, busy, run }: DialogProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const save = async () => {
    const n = name.trim();
    if (!n || [...n].length > 16) {
      toast.error(t('doser.rename.invalid'));
      return;
    }
    await run('setName', { pump: pump.index, name: n }, t('doser.action.rename'));
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setName(pump.name ?? ''); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
          {t('doser.action.rename')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('doser.rename.title')}</DialogTitle>
          <DialogDescription>{t('doser.rename.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-sm text-muted-foreground">{t('doser.rename.name')}</label>
          <Input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} className="w-56" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={busy !== null}>{t('common.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Pumpen-Panel: Anzeige + Aktionen einer Pumpe ----------
function PumpPanel({ dev, pump, now, busy, run }: DialogProps & { now: number }) {
  const t = useT();
  const { locale } = useI18n();
  const fmt = (v: unknown, d = 2) => {
    const n = num(v, NaN);
    return Number.isFinite(n)
      ? n.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d })
      : '—';
  };

  const mode = num(pump.mode, 0);
  const modeKey = MODE_KEYS[mode];
  const today = num(pump.todayMl, 0);
  const target = num(pump.targetMl, 0);
  const fill = num(pump.fillMl, NaN);
  const capacity = num(pump.capacityMl, NaN);
  const fillPct = Number.isFinite(fill) && Number.isFinite(capacity) && capacity > 0
    ? (100 * fill) / capacity : null;
  const remainingDays = Number.isFinite(fill) && target > 0 ? Math.round(fill / target) : null;
  const autoActive = pump.autoActive !== false;
  const next = nextDose(pump, now);
  const todayBit = 1 << new Date(now).getDay();
  const todayEnabled = ((pump.weekdayMask ?? 0x7f) & todayBit) !== 0;
  const calDate = pump.calDate;
  const calOverdue = pump.calOverdue === true;

  // Letzte Aktivität: jüngster History-Eintrag (ts aus den Gerätefeldern)
  const last: DoserHistoryEntry | null = (pump.history ?? [])
    .filter((h) => h && h.ts > 0)
    .sort((a, b) => b.ts - a.ts)[0] ?? null;
  const lastTxt = last
    ? `${t(historyTypeKey(last.type))}: ${fmt(last.doseMl || last.manualMl)} ml · ${new Date(last.ts).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : t('doser.lastActivity.none');

  const nextTxt = !autoActive
    ? t('doser.nextDose.skipped')
    : !next
      ? t('doser.nextDose.none')
      : next.dayOffset === 0
        ? t('doser.nextDose.at', { time: fmtClock(next.minutes), ml: fmt(next.ml) })
        : t('doser.nextDose.day', {
            day: next.dayOffset === 1 ? t('doser.nextDose.tomorrow') : t(WEEKDAY_KEYS[(new Date(now).getDay() + next.dayOffset) % 7]),
            time: fmtClock(next.minutes),
            ml: fmt(next.ml),
          });

  return (
    <div className="space-y-4 pt-3">
      {/* Status-Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={calOverdue ? 'destructive' : 'secondary'}>{modeKey ? t(modeKey) : '—'}</Badge>
        {calOverdue && <Badge variant="destructive">{t('doser.calibrationOverdue')}</Badge>}
        {!autoActive && <Badge variant="secondary">{t('doser.nextDose.skipped')}</Badge>}
        {mode === 4 && num(pump.calCountdownS, 0) > 0 && (
          <Badge variant="secondary">{t('doser.mode.countdown', { s: num(pump.calCountdownS) })}</Badge>
        )}
        {mode === 3 && num(pump.circuitCountdownS, 0) > 0 && (
          <Badge variant="secondary">{t('doser.mode.countdown', { s: num(pump.circuitCountdownS) })}</Badge>
        )}
      </div>

      {/* Heute x ml / y ml + Fortschritt */}
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">{t('doser.today')}</span>
          <span className="font-mono text-xl font-semibold text-[#38bdf8]">
            {t('doser.todayOf', { today: fmt(today), target: fmt(target) })}
          </span>
        </div>
        <Progress value={target > 0 ? Math.min(100, (today / target) * 100) : 0} className="mt-1.5 h-2" />
      </div>

      <div className="space-y-1 border-t border-border/60 pt-3">
        <Row label={t('doser.lastActivity')}><span className="font-mono text-xs">{lastTxt}</span></Row>
        <Row label={t('doser.autoDose')}>
          <span className="font-mono text-xs">
            {autoActive ? `${t('doser.nextDose')} ${nextTxt}` : t('doser.autoOff')}
          </span>
        </Row>
        {autoActive && !todayEnabled && (
          <p className="text-right text-[11px] text-muted-foreground/70">{t('doser.todayOff')}</p>
        )}
      </div>

      {/* Behälter: Füllstand + Restzeit */}
      <div className="space-y-1 border-t border-border/60 pt-3">
        <Row label={t('doser.container')}>
          <span className="font-mono text-xs">
            {t('doser.container.fillOf', { fill: fmt(fill), capacity: fmt(capacity) })}
          </span>
        </Row>
        <Progress value={fillPct ?? 0} className="h-2" />
        <Row label={t('doser.remaining')}>
          <span className="font-mono text-xs">
            {remainingDays !== null && fillPct !== null
              ? t('doser.remaining.value', {
                  days: remainingDays,
                  pct: fillPct.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                })
              : '—'}
          </span>
        </Row>
      </div>

      {/* Nächste Kalibrierung */}
      <div className="space-y-1 border-t border-border/60 pt-3">
        <Row label={t('doser.nextCalibration')}>
          <span className={`font-mono text-xs ${calOverdue ? 'font-semibold text-red-400' : ''}`}>
            {calDate && calDate.year
              ? new Date(calDate.year, calDate.month - 1, calDate.day).toLocaleDateString(locale)
              : '—'}
          </span>
        </Row>
      </div>

      {/* Aktionen */}
      <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
        <ContainerDialog dev={dev} pump={pump} busy={busy} run={run} />
        <CalibrateDialog dev={dev} pump={pump} busy={busy} run={run} />
        <ManualDoseDialog dev={dev} pump={pump} busy={busy} run={run} />
        {autoActive ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
                {busy === 'skipNext' ? '…' : t('doser.action.skip')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('doser.skip.title')}</AlertDialogTitle>
                <AlertDialogDescription>{t('doser.skip.desc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run('skipNext', { pump: pump.index }, t('doser.action.skip'))}>
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
                {busy === 'cancelSkip' ? '…' : t('doser.action.skipCancel')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('doser.action.skipCancel')}</AlertDialogTitle>
                <AlertDialogDescription>{t('doser.skip.cancelDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run('cancelSkip', { pump: pump.index }, t('doser.action.skipCancel'))}>
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <ScheduleDialog dev={dev} pump={pump} busy={busy} run={run} />
        <RenameDialog dev={dev} pump={pump} busy={busy} run={run} />
      </div>
    </div>
  );
}

// Doser-Detailkarte (Onboard-Protokoll): Pumpen-Tabs (Namen aus dem State),
// je Pumpe Tagesfortschritt, letzte Aktivität, nächste Dosierung (clientseitig
// aus dem Zeitplan), Behälter mit Restzeit, Kalibriertermin und alle Aktionen
// über /api/command (dzSet/dzCalibration/dzManualRefill, siehe buildCommandFrame).
export default function DoserBody({ dev, now, sendCommand }: { dev: DeviceSnapshot; now: number; sendCommand: CommandFn }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const pumps = doserPumps(dev).sort((a, b) => a.index - b.index);
  const [tab, setTab] = useState<string>('');
  const activeTab = pumps.some((p) => String(p.index) === tab) ? tab : String(pumps[0]?.index ?? '1');

  const run: RunFn = async (action, params, label) => {
    setBusy(action);
    try {
      await sendCommand(dev.serial, action, params);
      toast.success(t('doser.sent', { label }));
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(null);
  };

  if (!pumps.length) {
    return <p className="text-sm text-muted-foreground">{t('doser.noData')}</p>;
  }

  return (
    <Tabs value={activeTab} onValueChange={setTab}>
      <TabsList>
        {pumps.map((p) => (
          <TabsTrigger key={p.index} value={String(p.index)}>{p.name || t('doser.pump', { n: p.index })}</TabsTrigger>
        ))}
      </TabsList>
      {pumps.map((p) => (
        <TabsContent key={p.index} value={String(p.index)}>
          <PumpPanel dev={dev} pump={p} now={now} busy={busy} run={run} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
