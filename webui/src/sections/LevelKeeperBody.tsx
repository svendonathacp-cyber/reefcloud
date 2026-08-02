import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { StepperInput } from '@/components/ui/stepper-input';
import { LK_MODE_KEYS, LK_STATUS_KEYS } from './DeviceCard';
import { useT } from '@/i18n/I18nContext';
import type { CommandFn, DeviceSnapshot } from '@/types/reef';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const NOTIFY_KEYS = [
  'lk.calibration.notify.0', 'lk.calibration.notify.1',
  'lk.calibration.notify.2', 'lk.calibration.notify.3',
] as const;

// Sekunden → m:ss (Anzeige wie im Onboard-UI)
function mmss(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// Level-Keeper-Detailkarte (Onboard-Protokoll): Status inkl. neuer Codes,
// Heute-Füllmenge (beide Endianness-Kandidaten, solange die Live-Verifikation
// läuft), Kalibrierdatum + fällig-Hinweis, Modus-Auswahl, manueller Refill
// und Kalibrier-Wizard — alle Aktionen über /api/command (lkSet/lkCalibration/
// lkManualRefill, siehe buildCommandFrame).
export default function LevelKeeperBody({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [refillMl, setRefillMl] = useState(100);
  const [calDuration, setCalDuration] = useState(10);
  const [calValue, setCalValue] = useState(100);

  const statusKey = LK_STATUS_KEYS[String(dev.state.status ?? '')];
  const statusLabel = statusKey ? t(statusKey) : t('lk.status.unknown');
  const mode = num(dev.state.mode, -1);
  const today = num(dev.state.todayMl, NaN);
  const todayBe = num(dev.state.todayMlBe, NaN);
  // Alternativ-Lesart nur zeigen, wenn sie vorhanden ist UND abweicht
  const showAlt = Number.isFinite(today) && Number.isFinite(todayBe) && todayBe !== today;
  const calDate = dev.state.calibrationDate as { day?: number; month?: number; year?: number } | undefined;
  const calDue = dev.state.calibrationDue === true;
  const refillDone = num(dev.state.manualRefillDoneMl, NaN);
  const refillTarget = num(dev.state.manualRefillTargetMl, NaN);
  const refillActive = Number.isFinite(refillDone) && Number.isFinite(refillTarget) && refillTarget > 0 && refillDone < refillTarget;
  const calCountdown = num(dev.state.calibrationCountdownS, 0);
  const circuitCountdown = num(dev.state.circuitCountdownS, 0);
  const tempOffRest = num(dev.state.temporaryOffRestS, 0);
  const maxRefill = num(dev.state.maxRefillRuntimeS, NaN);

  const run = async (action: string, params: Record<string, unknown>, label: string) => {
    setBusy(action);
    try {
      await sendCommand(dev.serial, action, params);
      toast.success(t('lk.sent', { label }));
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(null);
  };

  const setMode = async (m: number) => {
    if (m === mode || busy !== null) return;
    await run('setMode', { mode: m }, `${t('lk.mode')}: ${t(LK_MODE_KEYS[m])}`);
  };

  return (
    <>
      {/* Status + Heute-Füllmenge */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={calDue || String(dev.state.status) === 'high' || String(dev.state.status) === 'low' ? 'destructive' : 'secondary'}>
          {statusLabel}
        </Badge>
        {calDue && <Badge variant="destructive">{t('lk.calibrationDue')}</Badge>}
        {calCountdown > 0 && <Badge variant="secondary">{t('lk.countdown.calibration', { s: calCountdown })}</Badge>}
        {circuitCountdown > 0 && <Badge variant="secondary">{t('lk.countdown.circuit', { s: circuitCountdown })}</Badge>}
        {tempOffRest > 0 && <Badge variant="secondary">{t('lk.temporaryOff.rest', { s: tempOffRest })}</Badge>}
      </div>

      <div className="mt-3 space-y-1">
        <Row label={t('lk.today')}>
          <span className="font-mono">{Number.isFinite(today) ? `${today} ml` : '—'}</span>
        </Row>
        {showAlt && (
          <p className="text-right text-[11px] text-muted-foreground/70">{t('lk.todayAlt', { ml: todayBe })}</p>
        )}
        <Row label={t('lk.calibrationDate')}>
          <span className={`font-mono ${calDue ? 'font-semibold text-red-400' : ''}`}>
            {calDate && calDate.day ? `${calDate.day}.${calDate.month}.${calDate.year}` : '—'}
          </span>
        </Row>
        {Number.isFinite(maxRefill) && maxRefill > 0 && (
          <Row label={t('lk.maxRefillTime')}><span className="font-mono">{mmss(maxRefill)}</span></Row>
        )}
      </div>

      {/* Fortschritt manueller Refill */}
      {refillActive && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('lk.manualRefill.title')}</span>
            <span className="font-mono text-xs">{t('lk.manualRefill.progress', { done: refillDone, target: refillTarget })}</span>
          </div>
          <Progress value={Math.min(100, (refillDone / refillTarget) * 100)} className="mt-1.5 h-2" />
        </div>
      )}

      {/* Modus-Auswahl (Nachfüllzyklus 0–5) */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <p className="text-sm text-muted-foreground">{t('lk.mode')}</p>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((m) => (
            <Button key={m} size="sm" variant={mode === m ? 'default' : 'outline'}
              disabled={!dev.online || busy !== null} onClick={() => void setMode(m)}>
              {busy === 'setMode' && mode !== m ? '…' : t(LK_MODE_KEYS[m])}
            </Button>
          ))}
        </div>
      </div>

      {/* Manueller Refill */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <p className="text-sm text-muted-foreground">{t('lk.manualRefill.title')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AlertDialog onOpenChange={(open) => { if (open) setRefillMl(100); }}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
                {busy === 'manualRefill' ? '…' : t('lk.manualRefill.start')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('lk.manualRefill.start')}</AlertDialogTitle>
                <AlertDialogDescription>{t('lk.manualRefill.startDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5">
                <label className="text-sm text-muted-foreground">{t('lk.manualRefill.amount')}</label>
                <StepperInput min={1} max={100000} value={String(refillMl)} onChange={(v) => setRefillMl(Math.max(0, Number(v) || 0))} className="w-40" />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    if (!Number.isFinite(refillMl) || refillMl < 1 || refillMl > 100000) {
                      e.preventDefault();
                      toast.error(t('lk.manualRefill.invalid'));
                      return;
                    }
                    void run('manualRefill', { ml: refillMl }, t('lk.manualRefill.title'));
                  }}
                >
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null || !refillActive}>
                {busy === 'manualRefillStop' ? '…' : t('lk.manualRefill.stop')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('lk.manualRefill.stop')}</AlertDialogTitle>
                <AlertDialogDescription>{t('lk.manualRefill.stopDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run('manualRefillStop', {}, t('lk.manualRefill.stop'))}>
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Kalibrier-Wizard: Start (mit Dauer) / Stopp / Menge / Erinnerung */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <p className="text-sm text-muted-foreground">{t('lk.calibration.title')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <AlertDialog onOpenChange={(open) => { if (open) setCalDuration(10); }}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
                {busy === 'calibrateStart' ? '…' : t('lk.calibration.start')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('lk.calibration.start')}</AlertDialogTitle>
                <AlertDialogDescription>{t('lk.calibration.startDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5">
                <label className="text-sm text-muted-foreground">{t('lk.calibration.duration')}</label>
                <StepperInput min={1} max={255} value={String(calDuration)} onChange={(v) => setCalDuration(Math.max(0, Number(v) || 0))} className="w-40" />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async (e) => {
                    if (!Number.isInteger(calDuration) || calDuration < 1 || calDuration > 255) {
                      e.preventDefault();
                      return;
                    }
                    // Geräte-Ablauf: erst Dauer setzen, dann Start
                    await run('calibrateTime', { seconds: calDuration }, t('lk.calibration.duration'));
                    await run('calibrateStart', {}, t('lk.calibration.start'));
                  }}
                >
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null || calCountdown <= 0}>
                {busy === 'calibrateStop' ? '…' : t('lk.calibration.stop')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('lk.calibration.stop')}</AlertDialogTitle>
                <AlertDialogDescription>{t('lk.calibration.stopDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run('calibrateStop', {}, t('lk.calibration.stop'))}>
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog onOpenChange={(open) => { if (open) setCalValue(100); }}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
                {busy === 'calibrateValue' ? '…' : t('lk.calibration.value')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('lk.calibration.value')}</AlertDialogTitle>
                <AlertDialogDescription>{t('lk.calibration.valueDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5">
                <label className="text-sm text-muted-foreground">{t('lk.manualRefill.amount')}</label>
                <StepperInput min={0} max={100000} value={String(calValue)} onChange={(v) => setCalValue(Math.max(0, Number(v) || 0))} className="w-40" />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run('calibrateValue', { ml: calValue }, t('lk.calibration.value'))}>
                  {t('common.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!dev.online || busy !== null}>
                {busy === 'calibrateNotification' ? '…' : t('lk.calibration.notify')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('lk.calibration.notify')}</AlertDialogTitle>
                <AlertDialogDescription>{t('lk.calibration.notifyDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((idx) => (
                  <AlertDialogAction key={idx} asChild>
                    <Button variant="outline" onClick={() => void run('calibrateNotification', { index: idx }, t('lk.calibration.notify'))}>
                      {t(NOTIFY_KEYS[idx])}
                    </Button>
                  </AlertDialogAction>
                ))}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </>
  );
}
