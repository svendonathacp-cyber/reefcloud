import { useState } from 'react';
import { AlertTriangle, LayoutDashboard, ScrollText } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { useReef } from '@/hooks/useReef';
import { useT } from '@/i18n/I18nContext';
import LanguageWelcome from '@/i18n/LanguageWelcome';
import type { DeviceSnapshot } from '@/types/reef';
import ReefHeader from '@/sections/ReefHeader';
import Sidebar from '@/sections/Sidebar';
import { deviceDisplayName, FAMILY_META } from '@/sections/DeviceCard';
import DeviceTile, { statusOf } from '@/sections/DeviceTile';
import DeviceDetail from '@/sections/DeviceDetail';
import LogView from '@/sections/LogView';

const GROUP_KEYS = [
  { titleKey: 'groups.pumpsFilters', families: ['basepump', 'wave', 'roller'] },
  { titleKey: 'groups.lighting', families: ['flare'] },
] as const;

const FAMILY_ORDER = ['basepump', 'wave', 'roller', 'flare', 'levelSensor', 'level', 'salinity', 'thermo', 'doser'];

function sortDevices(devices: DeviceSnapshot[]): DeviceSnapshot[] {
  return [...devices].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a.family);
    const ib = FAMILY_ORDER.indexOf(b.family);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.serial.localeCompare(b.serial);
  });
}

// Skeleton-Raster für den ersten Ladevorgang
function TileSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="rounded-xl border border-border/70 bg-card/80 p-3.5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
          </div>
          <Skeleton className="mt-4 h-7 w-1/3" />
          <Skeleton className="mt-3 h-2.5 w-full" />
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const t = useT();
  const { devices, now, tunnel, error, loading, captureOn, frames, sendCommand, setCapture, setNickname } = useReef();
  const [selected, setSelected] = useState(() => {
    // Optionaler Deep-Link: ?dev=<serial> öffnet direkt die Detailansicht
    try {
      const q = new URLSearchParams(window.location.search).get('dev');
      if (q && /^[\w-]{1,32}$/.test(q)) return q;
    } catch { /* ignore */ }
    return 'dashboard';
  });
  const sorted = sortDevices(devices);
  const online = devices.filter((d) => d.online).length;
  const currentDev = devices.find((d) => d.serial === selected);

  const title = selected === 'dashboard'
    ? t('nav.dashboard')
    : selected === 'log'
      ? t('home.logMonitor')
      : (currentDev ? deviceDisplayName(currentDev) || t('family.unknown') : t('family.unknown'));

  const grouped = GROUP_KEYS.map((g) => ({
    title: t(g.titleKey),
    devices: sorted.filter((d) => (g.families as readonly string[]).includes(d.family)),
  }));
  const rest = sorted.filter((d) => !GROUP_KEYS.some((g) => (g.families as readonly string[]).includes(d.family)));

  const openDetail = (serial: string) => {
    setSelected(serial);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="flex min-h-screen">
      <Toaster position="bottom-right" richColors />
      <LanguageWelcome />
      <div className="hidden lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar devices={sorted} selected={selected} onSelect={setSelected} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <ReefHeader title={title} tunnel={tunnel} online={online} total={devices.length}
          captureOn={captureOn} onCaptureChange={(on) => void setCapture(on)} lastUpdate={now} />

        {/* Mobile: Auswahl als Chips (Sidebar erst ab lg) */}
        <div className="flex gap-2 overflow-x-auto border-b border-border bg-[#0d1526] px-3 py-2 lg:hidden">
          <Chip active={selected === 'dashboard'} onClick={() => setSelected('dashboard')} Icon={LayoutDashboard} label={t('nav.dashboard')} />
          <Chip active={selected === 'log'} onClick={() => setSelected('log')} Icon={ScrollText} label={t('nav.log')} />
          {sorted.map((d) => {
            const meta = FAMILY_META[d.family] ?? FAMILY_META.unknown;
            return <Chip key={d.serial} active={selected === d.serial} onClick={() => setSelected(d.serial)} Icon={meta.Icon} label={deviceDisplayName(d) || t(meta.nameKey)} dim={statusOf(d) !== 'online'} />;
          })}
        </div>

        <main className="mx-auto max-w-7xl px-4 pb-12 pt-6">
          {error && (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{t('home.apiError', { error })}</span>
            </div>
          )}

          {selected === 'dashboard' && (
            <>
              {loading && devices.length === 0 && !error && (
                <>
                  <p className="mb-4 text-sm text-muted-foreground">{t('home.loading')}</p>
                  <TileSkeletons />
                </>
              )}
              {!loading && grouped.map((g) => g.devices.length > 0 && (
                <section key={g.title} className="mb-8">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {g.devices.map((d) => <DeviceTile key={d.serial} dev={d} now={now} onOpen={openDetail} />)}
                  </div>
                </section>
              ))}
              {!loading && rest.length > 0 && (
                <section className="mb-8">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('groups.sensors')}</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {rest.map((d) => <DeviceTile key={d.serial} dev={d} now={now} onOpen={openDetail} />)}
                  </div>
                </section>
              )}
              {!loading && devices.length === 0 && !error && (
                <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
                  <p className="text-sm text-muted-foreground">{t('home.noDevices')}</p>
                </div>
              )}
            </>
          )}

          {selected === 'log' && <LogView frames={frames} captureOn={captureOn} />}
          {currentDev && <DeviceDetail dev={currentDev} now={now} sendCommand={sendCommand} setNickname={setNickname} />}
        </main>
      </div>
    </div>
  );
}

function Chip({ active, onClick, Icon, label, dim }: {
  active: boolean; onClick: () => void;
  Icon: React.ComponentType<{ className?: string }>; label: string; dim?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] ${
        active ? 'border-[#009deb] bg-[#009deb]/15 text-[#38bdf8]' : 'border-border bg-card text-foreground/70'
      } ${dim ? 'opacity-50' : ''}`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="max-w-32 truncate">{label}</span>
    </button>
  );
}
