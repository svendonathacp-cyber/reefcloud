import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, RefreshCw, RotateCcw, Server } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nContext';

interface UpdateStatus {
  supported: boolean;
  supportedKnown: boolean;
  reason: string;
  current: string;
  behind: number;
  latestMsg: string;
  lastCheck: number;
  checking: boolean;
  updating: boolean;
  autoRestart: boolean;
  error: string;
}

// Defensiv wie in Settings.tsx: ältere Server-Versionen kennen die
// /api/update-/*-Endpunkte noch nicht und liefern über den SPA-Fallback HTML
// (index.html) — daran sauber erkennen statt zu crashen.
class ApiUnavailableError extends Error {
  constructor() { super('api-unavailable'); }
}

async function fetchJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(path, init);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new ApiUnavailableError();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// System-Abschnitt der Einstellungen: Update-Status (täglicher Server-Check
// gegen origin/main), manueller Check, Update-Installation und Server-Neustart.
// Installiert wird NIE automatisch — nur nach Bestätigung im Dialog.
export default function SystemSection() {
  const t = useT();
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busyCheck, setBusyCheck] = useState(false);
  const [busyInstall, setBusyInstall] = useState(false);
  const [busyRestart, setBusyRestart] = useState(false);
  // Nach Update/Neustart: Server ist kurz weg — Overlay wartet auf die
  // Rückkehr und lädt die Seite dann neu (neuer Code/frischer State).
  const [waiting, setWaiting] = useState<{ manual: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetchJson('/api/update/status');
      setSt(j as unknown as UpdateStatus);
      setUnavailable(false);
    } catch (e) {
      if (e instanceof ApiUnavailableError) setUnavailable(true);
      // sonstige Fehler (kurzer Netzaussetzer): alten Stand behalten
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000); // tägliche Server-Checks einsammeln
    return () => clearInterval(iv);
  }, [load]);

  // Warte-Schleife: erst muss der Server WEG gewesen sein (Self-Exit),
  // dann auf die erste erfolgreiche Antwort → Seite neu laden.
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    let sawDown = false;
    const iv = setInterval(async () => {
      try {
        await fetchJson('/api/settings');
        if (sawDown && alive) window.location.reload();
      } catch {
        sawDown = true; // Server ist weg — jetzt auf die Rückkehr warten
      }
    }, 2_000);
    return () => { alive = false; clearInterval(iv); };
  }, [waiting]);

  const ago = (ts: number): string => {
    if (!ts) return t('time.never');
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return t('time.secondsAgo', { s });
    if (s < 3600) return t('time.minutesAgo', { m: Math.round(s / 60) });
    return t('time.hoursAgo', { h: Math.round(s / 3600) });
  };

  const onCheck = async () => {
    setBusyCheck(true);
    try {
      const j = await fetchJson('/api/update/check', { method: 'POST' });
      setSt(j as unknown as UpdateStatus);
    } catch (e) {
      toast.error(t('system.checkFailed', { error: errMsg(e) }));
    } finally {
      setBusyCheck(false);
    }
  };

  const onInstall = async () => {
    setBusyInstall(true);
    try {
      const j = await fetchJson('/api/update/install', { method: 'POST' });
      if (j.ok !== true) throw new Error(typeof j.error === 'string' ? j.error : 'unknown');
      setWaiting({ manual: j.autoRestart !== true });
    } catch (e) {
      toast.error(t('system.installFailed', { error: errMsg(e) }));
    } finally {
      setBusyInstall(false);
    }
  };

  const onRestart = async () => {
    setBusyRestart(true);
    try {
      const j = await fetchJson('/api/server/restart', { method: 'POST' });
      if (j.ok !== true) throw new Error(typeof j.error === 'string' ? j.error : 'unknown');
      setWaiting({ manual: j.autoRestart !== true });
    } catch (e) {
      toast.error(t('system.restartFailed', { error: errMsg(e) }));
    } finally {
      setBusyRestart(false);
    }
  };

  const checking = busyCheck || st?.checking === true;
  const updating = busyInstall || st?.updating === true;

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {t('settings.system')}
      </h2>
      <div className="rounded-xl border border-border/70 bg-card/80 p-5">
        {unavailable ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            {t('system.apiUnavailable')}
          </p>
        ) : (
          <>
            {/* ===== Updates ===== */}
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ArrowUpCircle className="h-3.5 w-3.5" />
                {t('system.updates')}
              </p>
              {!st || !st.supportedKnown ? (
                <p className="mt-2 text-sm text-muted-foreground">{t('settings.loading')}</p>
              ) : !st.supported ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('system.unsupported', { reason: st.reason || '?' })}
                </p>
              ) : (
                <div className="mt-2.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <code className="rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                      {t('system.currentVersion', { hash: st.current || '?' })}
                    </code>
                    <span className="text-xs text-muted-foreground">{t('system.lastCheck', { ago: ago(st.lastCheck) })}</span>
                  </div>
                  {st.error ? (
                    <p className="flex items-center gap-1.5 text-sm text-amber-400">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      {t('system.checkFailed', { error: st.error })}
                    </p>
                  ) : st.behind > 0 ? (
                    <p className="flex items-center gap-1.5 text-sm font-medium text-[#38bdf8]">
                      <ArrowUpCircle className="h-4 w-4 shrink-0" />
                      {t('system.updateAvailable', { count: st.behind, msg: st.latestMsg })}
                    </p>
                  ) : (
                    <p className="flex items-center gap-1.5 text-sm text-emerald-400">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      {t('system.upToDate')}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => void onCheck()}
                  disabled={checking || updating || !st?.supported} className="gap-1.5">
                  <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
                  {checking ? t('system.checking') : t('system.checkNow')}
                </Button>
                {st && st.supported && st.behind > 0 && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" disabled={checking || updating} className="gap-1.5">
                        {updating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                        {updating ? t('system.installing') : t('system.install')}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('system.installConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('system.installConfirmDesc', { count: st.behind })}{' '}
                          {t(st.autoRestart ? 'system.installConfirmAutoRestart' : 'system.installConfirmManualRestart')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void onInstall()}>{t('common.confirm')}</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>

            {/* ===== Neustart ===== */}
            <div className="mt-6 border-t border-border/60 pt-5">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Server className="h-3.5 w-3.5" />
                {t('settings.server')}
              </p>
              <div className="mt-3">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={busyRestart || updating} className="gap-1.5">
                      {busyRestart ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      {busyRestart ? t('system.restarting') : t('system.restart')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('system.restartConfirmTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('system.restartConfirmDesc')}{' '}
                        {t(st?.autoRestart ? 'system.restartConfirmAutoRestart' : 'system.restartConfirmManualRestart')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void onRestart()}>{t('common.confirm')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Warte-Overlay nach Update/Neustart (Server ist kurz weg) */}
      {waiting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border/70 bg-card p-6 text-center shadow-lg">
            <RefreshCw className="mx-auto h-6 w-6 animate-spin text-[#38bdf8]" />
            <p className="mt-3 text-sm font-medium">{t('system.waitingForRestart')}</p>
            {waiting.manual && (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('system.waitingManualHint')}</p>
            )}
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setWaiting(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
