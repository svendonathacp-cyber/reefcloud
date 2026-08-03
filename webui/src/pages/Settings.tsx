import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BookOpenCheck, Check, CheckCircle2, Copy, ExternalLink, Eye, EyeOff,
  FileKey2, Network, RefreshCw, Server, Wand2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, useT } from '@/i18n/I18nContext';
import AddDeviceSection from '@/sections/AddDeviceSection';
import JebaoSection from '@/sections/JebaoSection';
import SystemSection from '@/sections/SystemSection';
import { useJebaoPumps } from '@/sections/jebao-shared';
import type { DeviceSnapshot } from '@/types/reef';

interface SettingsProps {
  devices?: DeviceSnapshot[]; // für den eingebetteten RF-Einlern-Assistenten
  onOpenDevice?: (serial: string) => void;
}

type TunnelType = 'webos' | 'homeassistant' | 'custom';
const TUNNEL_TYPES: TunnelType[] = ['webos', 'homeassistant', 'custom'];

interface SettingsData {
  tunnelUrl: string;
  tunnelType: TunnelType;
  tunnelLabel: string;
  hasToken: boolean;
  tunnelConnected: boolean;
}

interface SetupStatus {
  hasToken: boolean;
  tunnelUrl: string;
  tunnelType: TunnelType;
  tunnelLabel: string;
  tunnelConnected: boolean;
  cert?: { cn: string; fingerprint256?: string; notAfter?: string };
  lanIps?: { name: string; address: string }[];
}

// Defensiv: ältere Server-Versionen kennen /api/settings noch nicht und liefern
// über den SPA-Fallback HTML (index.html) — daran sauber erkennen statt zu crashen.
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
  if (e instanceof ApiUnavailableError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// Fingerprint für die Anzeige kürzen (Kopieren liefert weiterhin den vollen Wert)
function shortenFingerprint(fp: string): string {
  return fp.length > 27 ? `${fp.slice(0, 24)}…` : fp;
}

const URL_RE = /^wss?:\/\//;
const TOKEN_RE = /^[0-9a-f]{32,128}$/i;

export default function Settings({ devices = [], onOpenDevice }: SettingsProps = {}) {
  const t = useT();
  const { locale } = useI18n();
  // Geteilter Jebao-State: AddDeviceSection (Hinzufügen) und JebaoSection
  // (Verwaltung) arbeiten auf derselben Pumpenliste.
  const jebao = useJebaoPumps();

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Formularzustand
  const [type, setType] = useState<TunnelType>('webos');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const applySettings = useCallback((s: SettingsData) => {
    setSettings(s);
    setType(TUNNEL_TYPES.includes(s.tunnelType) ? s.tunnelType : 'webos');
    setLabel(s.tunnelLabel ?? '');
    setUrl(s.tunnelUrl ?? '');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // /api/settings ist Pflicht (Formular), /api/setup/status optional (Server-Infos)
      const s = await fetchJson('/api/settings');
      applySettings(s as unknown as SettingsData);
      try {
        const st = await fetchJson('/api/setup/status');
        setStatus(st as unknown as SetupStatus);
      } catch {
        setStatus(null); // Server-Infos sind optional — Abschnitt fällt weg
      }
      setLoadError(null);
    } catch (e) {
      // ApiUnavailableError: kein Roh-Code in der UI — der Folgesatz im
      // Banner erklärt die Lage bereits (alter Server ohne /api/settings)
      setLoadError(e instanceof ApiUnavailableError ? '' : errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => { void load(); }, [load]);

  // Clientseitige Validierung (Backend validiert zusätzlich)
  const urlError = url.length > 0 && !URL_RE.test(url) ? t('settings.validation.url') : null;
  const tokenError = token.length > 0 && !TOKEN_RE.test(token) ? t('settings.validation.token') : null;
  const urlMissing = url.trim().length === 0;
  const formInvalid = urlMissing || !!urlError || !!tokenError;

  const hasToken = settings?.hasToken ?? status?.hasToken ?? false;

  const onTest = async () => {
    setSubmitAttempted(true);
    if (formInvalid || !token) return; // ohne eingegebenes Token kein Test möglich
    setTesting(true);
    setTestResult(null);
    try {
      const j = await fetchJson('/api/setup/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tunnelUrl: url.trim(), tunnelToken: token.trim() }),
      });
      if (j.ok === true) setTestResult({ ok: true });
      else setTestResult({ ok: false, error: typeof j.error === 'string' ? j.error : 'unknown' });
    } catch (e) {
      setTestResult({ ok: false, error: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    setSubmitAttempted(true);
    if (formInvalid) return;
    setSaving(true);
    try {
      const j = await fetchJson('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tunnelUrl: url.trim(),
          tunnelType: type,
          tunnelLabel: label.trim(),
          tunnelToken: token.trim(), // leer = bestehendes Token behalten (Backend-Vertrag)
        }),
      });
      if (j.ok !== true) throw new Error(typeof j.error === 'string' ? j.error : 'unknown');
      toast.success(t('settings.saved'));
      setToken(''); // Token-Feld leeren — der Server speichert es, die UI nie
      setTestResult(null);
      await load(); // Status neu laden (verbunden/nicht verbunden)
    } catch (e) {
      toast.error(t('settings.saveFailed', { error: errMsg(e) }));
    } finally {
      setSaving(false);
    }
  };

  // Fingerprint kopieren: erst Clipboard-API (nur Secure Contexts), sonst
  // execCommand-Fallback — die UI läuft über http://<lan-ip>:8080, dort
  // existiert navigator.clipboard nicht bzw. schlägt fehl.
  const copyFingerprint = async () => {
    const fp = status?.cert?.fingerprint256;
    if (!fp) return;
    let ok = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(fp);
        ok = true;
      }
    } catch { /* fällt auf execCommand zurück */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = fp;
      ta.readOnly = true;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch { ok = false; }
      ta.remove();
    }
    if (ok) toast.success(t('settings.server.copied'));
    else toast.error(t('settings.server.copyFailed'));
  };

  const guides = useMemo(() => ([
    { href: '/guides/zertifikat.html', Icon: FileKey2, titleKey: 'settings.guide.cert.title', descKey: 'settings.guide.cert.desc' },
    { href: '/guides/dns.html', Icon: Network, titleKey: 'settings.guide.dns.title', descKey: 'settings.guide.dns.desc' },
    { href: '/setup', Icon: Wand2, titleKey: 'settings.guide.setup.title', descKey: 'settings.guide.setup.desc' },
  ] as const), []);

  const busy = saving || testing;

  return (
    <div className="max-w-3xl space-y-8">
      {loading && !settings && loadError === null && (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">{t('settings.loading')}</p>
          <div className="rounded-xl border border-border/70 bg-card/80 p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-4 h-3 w-2/3" />
            <div className="mt-6 space-y-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
          </div>
        </div>
      )}

      {loadError !== null && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <span>{loadError ? t('settings.loadError', { error: loadError }) : t('settings.loadErrorNoDetail')}</span>
            <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('settings.retry')}
            </Button>
          </div>
        </div>
      )}

      {settings && (
        <>
          {/* ===== Verbindung / Tunnel ===== */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t('settings.connection')}
            </h2>
            <div className="rounded-xl border border-border/70 bg-card/80 p-5">
              {/* Status-Zeile (Farbcodierung wie Geräte-Status) */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  settings.tunnelConnected ? 'bg-emerald-400/10 text-emerald-400' : 'bg-amber-400/10 text-amber-400'
                }`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${settings.tunnelConnected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  {t(settings.tunnelConnected ? 'settings.status.connected' : 'settings.status.disconnected')}
                </span>
                <span className="min-w-0 text-sm text-foreground/80">
                  <span className="text-muted-foreground">{t('settings.status.target')}: </span>
                  <span className="font-medium">{settings.tunnelLabel || t('settings.status.unnamed')}</span>
                  <span className="ml-1.5 break-all text-muted-foreground">{settings.tunnelUrl}</span>
                </span>
                <Badge variant="secondary" className="ml-auto">{t(`settings.form.type.${TUNNEL_TYPES.includes(settings.tunnelType) ? settings.tunnelType : 'custom'}`)}</Badge>
              </div>

              {/* Formular */}
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="tunnel-type">{t('settings.form.type')}</Label>
                  <Select value={type} onValueChange={(v) => setType(v as TunnelType)} disabled={busy}>
                    <SelectTrigger id="tunnel-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="webos">{t('settings.form.type.webos')}</SelectItem>
                      <SelectItem value="homeassistant">{t('settings.form.type.homeassistant')}</SelectItem>
                      <SelectItem value="custom">{t('settings.form.type.custom')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tunnel-label">{t('settings.form.label')}</Label>
                  <Input
                    id="tunnel-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('settings.form.labelPlaceholder')}
                    maxLength={80}
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="tunnel-url">{t('settings.form.url')}</Label>
                  <Input
                    id="tunnel-url"
                    value={url}
                    onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
                    placeholder="wss://example.org/ws"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    aria-invalid={!!urlError || (submitAttempted && urlMissing)}
                  />
                  {(urlError || (submitAttempted && urlMissing)) ? (
                    <p className="text-xs text-red-400">{urlError ?? t('settings.validation.url')}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('settings.form.urlHint')}</p>
                  )}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="tunnel-token">{t('settings.form.token')}</Label>
                  <div className="relative">
                    <Input
                      id="tunnel-token"
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      onChange={(e) => { setToken(e.target.value); setTestResult(null); }}
                      placeholder={hasToken ? t('settings.form.tokenSavedPlaceholder') : t('settings.form.tokenEmptyPlaceholder')}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={busy}
                      className="pr-10 font-mono"
                      aria-invalid={!!tokenError}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      aria-label={t(showToken ? 'settings.form.hideToken' : 'settings.form.showToken')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
                    >
                      {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {tokenError ? (
                    <p className="text-xs text-red-400">{tokenError}</p>
                  ) : hasToken ? (
                    <p className="text-xs text-muted-foreground">{t('settings.form.tokenHint')}</p>
                  ) : null}
                </div>
              </div>

              <p className="mt-4 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                {t('settings.haNote')}
              </p>

              {/* Aktionen */}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Span umschließt den Button, damit der Tooltip auch bei disabled greift */}
                      <span className="inline-flex">
                        <Button
                          variant="outline"
                          onClick={() => void onTest()}
                          disabled={busy || formInvalid || !token}
                          className="gap-1.5"
                        >
                          {testing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          {testing ? t('settings.testing') : t('settings.test')}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!token && (
                      <TooltipContent className="max-w-64">
                        <p>{t('settings.testNeedsToken')}</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
                <Button onClick={() => void onSave()} disabled={busy || formInvalid} className="gap-1.5">
                  {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {saving ? t('settings.saving') : t('settings.save')}
                </Button>
                {testResult && (
                  <span className={`inline-flex items-center gap-1.5 text-sm ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                    {testResult.ok ? t('settings.testOk') : t('settings.testFailed', { error: testResult.error ?? '?' })}
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* ===== Anleitungen ===== */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t('settings.guides')}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {guides.map(({ href, Icon, titleKey, descKey }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('settings.guide.open')}
                  className="group rounded-xl border border-border/70 bg-card/80 p-4 transition-colors hover:border-[#009deb]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#009deb]/15 text-[#38bdf8]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{t(titleKey)}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-[#38bdf8]" />
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{t(descKey)}</p>
                </a>
              ))}
            </div>
          </section>

          {/* ===== Server (read-only) ===== */}
          {status && (status.cert || (status.lanIps && status.lanIps.length > 0)) && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {t('settings.server')}
              </h2>
              <div className="rounded-xl border border-border/70 bg-card/80 p-5">
                <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
                  {status.cert && (
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <Server className="h-3.5 w-3.5" />
                        {t('settings.server.cert')}
                      </p>
                      <p className="mt-2 truncate text-sm font-medium" title={status.cert.cn}>{status.cert.cn}</p>
                      {status.cert.notAfter && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t('settings.server.validUntil', {
                            date: new Date(status.cert.notAfter).toLocaleDateString(locale, { dateStyle: 'medium' }),
                          })}
                        </p>
                      )}
                      {status.cert.fingerprint256 && (
                        <>
                          <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {t('settings.server.fingerprint')}
                          </p>
                          <div className="mt-1 flex items-center gap-1.5">
                            <code className="min-w-0 truncate rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80" title={status.cert.fingerprint256}>
                              {shortenFingerprint(status.cert.fingerprint256)}
                            </code>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    onClick={() => void copyFingerprint()}
                                    aria-label={t('settings.server.copy')}
                                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
                                  >
                                    <Copy className="h-3.5 w-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent><p>{t('settings.server.copy')}</p></TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <BookOpenCheck className="h-3.5 w-3.5" />
                      {t('settings.server.lanIps')}
                    </p>
                    {status.lanIps && status.lanIps.length > 0 ? (
                      <ul className="mt-2 space-y-1">
                        {status.lanIps.map((ip) => (
                          <li key={`${ip.name}-${ip.address}`} className="flex items-baseline gap-2 text-sm">
                            <code className="rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{ip.address}</code>
                            <span className="truncate text-xs text-muted-foreground">{ip.name}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">{t('settings.server.noLanIps')}</p>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">{t('settings.server.portHint')}</p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ===== Geräte hinzufügen (Discovery + RF-Einlernen) ===== */}
          <AddDeviceSection jebao={jebao} devices={devices} onOpenDevice={onOpenDevice ?? (() => { /* kein Kontext */ })} />

          {/* ===== Jebao-Pumpen (Gizwits-LAN) ===== */}
          <JebaoSection jebao={jebao} />

          {/* ===== System (Updates & Neustart) ===== */}
          <SystemSection />
        </>
      )}
    </div>
  );
}
