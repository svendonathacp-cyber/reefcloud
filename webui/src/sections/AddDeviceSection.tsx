import { useState } from 'react';
import { ChevronDown, Plus, RefreshCw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/I18nContext';
import OnboardingWizard from '@/sections/OnboardingWizard';
import { fetchJson, validIp, type JebaoPumpsApi } from '@/sections/jebao-shared';
import type { DeviceSnapshot, JebaoDiscovered, JebaoScanResponse } from '@/types/reef';

interface Props {
  jebao: JebaoPumpsApi; // geteilte Pumpenliste aus Settings (sync mit JebaoSection)
  devices: DeviceSnapshot[]; // live gepollt durch useReef() in Home — für den RF-Assistenten
  onOpenDevice: (serial: string) => void;
}

// Sektion „Geräte hinzufügen" in den Einstellungen:
// 1. Discovery als Hauptweg (GET /api/jebao/scan — Gizwits-LAN, UDP 12414)
// 2. Manuell per IP (kleiner Dialog)
// 3. Reef-Factory-Einlern-Assistent (OnboardingWizard) einklappbar — nur für
//    den Sonderfall, dass ein Gerät nicht mehr verbindet.
export default function AddDeviceSection({ jebao, devices, onOpenDevice }: Props) {
  const t = useT();
  const { pumps, busy, add } = jebao;

  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<JebaoDiscovered[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualIp, setManualIp] = useState('');
  const [manualName, setManualName] = useState('');
  const [addingIp, setAddingIp] = useState<string | null>(null); // Karten-Button, der gerade arbeitet

  const [rfOpen, setRfOpen] = useState(false); // RF-Assistent — default zu

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

  // „Bereits hinzugefügt"-Abgleich über MAC (stabil) oder IP (Fallback)
  const isConfigured = (d: JebaoDiscovered) =>
    (pumps ?? []).some((p) =>
      p.ip === d.ip || (d.mac && p.mac && p.mac.toLowerCase() === d.mac.toLowerCase()));

  const addDiscovered = async (d: JebaoDiscovered) => {
    setAddingIp(d.ip);
    await add(d.ip, '', d.productKey || undefined, t('addDevice.addedHint'));
    setAddingIp(null);
  };

  const manualIpValid = validIp(manualIp.trim());
  const addManual = async () => {
    const ok = await add(manualIp.trim(), manualName.trim(), undefined, t('addDevice.addedHint'));
    if (ok) {
      setManualOpen(false);
      setManualIp('');
      setManualName('');
    }
  };

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {t('settings.addDevice')}
      </h2>
      <div className="rounded-xl border border-border/70 bg-card/80 p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">{t('addDevice.desc')}</p>

        {/* Discovery als Hauptweg */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void scan()} disabled={scanning} className="gap-1.5">
            {scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {scanning ? t('jebao.settings.scanning') : t('jebao.settings.scan')}
          </Button>
          <Button variant="outline" onClick={() => setManualOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('addDevice.manualOpen')}
          </Button>
        </div>

        {scanError && (
          <p className="mt-3 text-sm text-amber-400">{t('jebao.settings.scanError', { error: scanError })}</p>
        )}
        {scanResult !== null && !scanError && scanResult.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">{t('jebao.settings.scanEmpty')}</p>
        )}
        {scanResult !== null && scanResult.length > 0 && (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {scanResult.map((d) => {
              const already = isConfigured(d);
              return (
                <li key={d.ip} className="rounded-lg border border-border/60 bg-secondary/30 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="secondary">{t('addDevice.brand')}</Badge>
                    {already ? (
                      <Badge variant="secondary">{t('jebao.settings.alreadyAdded')}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy || addingIp !== null}
                        className="gap-1"
                        onClick={() => void addDiscovered(d)}
                      >
                        {addingIp === d.ip
                          ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          : <Plus className="h-3.5 w-3.5" />}
                        {t('jebao.settings.add')}
                      </Button>
                    )}
                  </div>
                  <p className="mt-2.5 truncate font-mono text-sm font-medium">{d.ip}</p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {t('jebao.settings.mac')} {d.mac || '—'} · {d.firmware || '—'}
                    {d.productKey ? ` · ${d.productKey.slice(0, 8)}…` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        )}

        {/* Reef-Factory-Gerät einlernen (Sonderfall) — einklappbar, default zu */}
        <Collapsible open={rfOpen} onOpenChange={setRfOpen} className="mt-6 border-t border-border/60 pt-4">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-sm font-medium text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
            >
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${rfOpen ? '' : '-rotate-90'}`} />
              {t('addDevice.rf.title')}
            </button>
          </CollapsibleTrigger>
          <p className="mt-1.5 px-1 text-xs leading-relaxed text-muted-foreground">{t('addDevice.rf.desc')}</p>
          <CollapsibleContent className="mt-4">
            <OnboardingWizard
              devices={devices}
              onDone={() => setRfOpen(false)}
              onOpenDevice={onOpenDevice}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Manuell per IP hinzufügen */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('addDevice.manual.title')}</DialogTitle>
            <DialogDescription>{t('addDevice.manual.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="add-device-ip">{t('jebao.settings.ip')}</Label>
              <Input
                id="add-device-ip"
                value={manualIp}
                onChange={(e) => setManualIp(e.target.value)}
                placeholder="192.168.4.87"
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                aria-invalid={manualIp.length > 0 && !manualIpValid}
              />
              {manualIp.length > 0 && !manualIpValid && (
                <p className="text-xs text-red-400">{t('jebao.settings.invalidIp')}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-device-name">{t('jebao.settings.name')}</Label>
              <Input
                id="add-device-name"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder={t('jebao.settings.namePlaceholder')}
                maxLength={40}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy || !manualIpValid} className="gap-1" onClick={() => void addManual()}>
              {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t('jebao.settings.addManual')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
