import { useCallback, useEffect, useState } from 'react';
import { Fan, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/i18n/I18nContext';
import type { JebaoDiscovered, JebaoPump, JebaoScanResponse } from '@/types/reef';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validIp = (ip: string) => IPV4_RE.test(ip) && ip.split('.').every((o) => Number(o) <= 255);

async function fetchJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
}

// Jebao-Pumpen-Verwaltung (jebao.json über /api/jebao): konfigurierte Pumpen
// auflisten/entfernen, per UDP-Discovery (Gizwits 12414) im LAN suchen oder
// manuell per IP hinzufügen. Die Pumpe erscheint danach als Gerät (family
// 'jebao') auf dem Dashboard.
export default function JebaoSection() {
  const t = useT();
  const [pumps, setPumps] = useState<JebaoPump[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<JebaoDiscovered[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualIp, setManualIp] = useState('');
  const [manualName, setManualName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetchJson('/api/jebao');
      setPumps(Array.isArray(j.pumps) ? (j.pumps as JebaoPump[]) : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async (ip: string, name: string, productKey?: string) => {
    setBusy(true);
    try {
      await fetchJson('/api/jebao', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip, name, ...(productKey ? { productKey } : {}) }),
      });
      toast.success(t('jebao.settings.added'));
      setManualIp('');
      setManualName('');
      await load();
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(false);
  };

  const remove = async (p: JebaoPump) => {
    try {
      await fetchJson('/api/jebao', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: p.ip }),
      });
      toast.success(t('jebao.settings.removed'));
      await load();
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const j = (await fetchJson('/api/jebao/scan')) as unknown as JebaoScanResponse;
      setScanResult(Array.isArray(j.devices) ? j.devices : []);
      if (j.error) setScanError(j.error);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
      setScanResult(null);
    }
    setScanning(false);
  };

  const configuredIps = new Set((pumps ?? []).map((p) => p.ip));
  const manualIpValid = validIp(manualIp.trim());

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {t('settings.jebao')}
      </h2>
      <div className="rounded-xl border border-border/70 bg-card/80 p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">{t('jebao.settings.desc')}</p>

        {/* Konfigurierte Pumpen */}
        {pumps === null && !loadError && (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        )}
        {loadError && (
          <p className="mt-4 text-sm text-amber-400">{t('jebao.settings.scanError', { error: loadError })}</p>
        )}
        {pumps !== null && pumps.length === 0 && !loadError && (
          <p className="mt-4 text-sm text-muted-foreground">{t('jebao.settings.none')}</p>
        )}
        {pumps !== null && pumps.length > 0 && (
          <ul className="mt-4 space-y-2">
            {pumps.map((p) => (
              <li key={p.ip} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#60a5fa]/15 text-[#60a5fa]">
                  <Fan className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium">{p.name || t('family.jebao')}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {p.ip}{p.mac ? ` · ${p.mac}` : ''}{p.serial ? ` · ${p.serial}` : ''}
                  </span>
                </span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-400"
                      aria-label={t('jebao.settings.remove')}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('jebao.settings.removeTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('jebao.settings.removeConfirm', { name: p.name || p.ip, ip: p.ip })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void remove(p)}>{t('jebao.settings.remove')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}

        {/* Scan */}
        <div className="mt-5 border-t border-border/60 pt-4">
          <Button variant="outline" size="sm" onClick={() => void scan()} disabled={scanning} className="gap-1.5">
            {scanning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {scanning ? t('jebao.settings.scanning') : t('jebao.settings.scan')}
          </Button>
          {scanError && (
            <p className="mt-2 text-sm text-amber-400">{t('jebao.settings.scanError', { error: scanError })}</p>
          )}
          {scanResult !== null && !scanError && scanResult.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">{t('jebao.settings.scanEmpty')}</p>
          )}
          {scanResult !== null && scanResult.length > 0 && (
            <ul className="mt-3 space-y-2">
              {scanResult.map((d) => {
                const already = configuredIps.has(d.ip);
                return (
                  <li key={d.ip} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate font-mono text-sm">{d.ip}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {t('jebao.settings.mac')} {d.mac || '—'} · {d.firmware || '—'}
                        {d.productKey ? ` · ${d.productKey.slice(0, 8)}…` : ''}
                      </span>
                    </span>
                    {already ? (
                      <Badge variant="secondary">{t('jebao.settings.alreadyAdded')}</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={busy} className="gap-1"
                        onClick={() => void add(d.ip, '', d.productKey)}>
                        <Plus className="h-3.5 w-3.5" />
                        {t('jebao.settings.add')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Manuell hinzufügen */}
        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="jebao-ip">{t('jebao.settings.ip')}</Label>
              <Input id="jebao-ip" value={manualIp} onChange={(e) => setManualIp(e.target.value)}
                placeholder="192.168.4.87" spellCheck={false} autoComplete="off" className="font-mono"
                aria-invalid={manualIp.length > 0 && !manualIpValid} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jebao-name">{t('jebao.settings.name')}</Label>
              <Input id="jebao-name" value={manualName} onChange={(e) => setManualName(e.target.value)}
                placeholder={t('jebao.settings.namePlaceholder')} maxLength={40} />
            </div>
            <Button size="sm" disabled={busy || !manualIpValid} className="gap-1"
              onClick={() => void add(manualIp.trim(), manualName.trim())}>
              <Plus className="h-3.5 w-3.5" />
              {t('jebao.settings.addManual')}
            </Button>
          </div>
          {manualIp.length > 0 && !manualIpValid && (
            <p className="mt-1.5 text-xs text-red-400">{t('jebao.settings.invalidIp')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
