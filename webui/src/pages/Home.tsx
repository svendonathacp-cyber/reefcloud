import { useState } from 'react';
import { AlertTriangle, LayoutDashboard, ScrollText } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { useReef } from '@/hooks/useReef';
import type { DeviceSnapshot } from '@/types/reef';
import ReefHeader from '@/sections/ReefHeader';
import Sidebar from '@/sections/Sidebar';
import DeviceCard, { FAMILY_META } from '@/sections/DeviceCard';
import DeviceDetail from '@/sections/DeviceDetail';
import LogView from '@/sections/LogView';

const GROUPS: { title: string; families: string[] }[] = [
  { title: 'Pumpen & Filter', families: ['basepump', 'wave', 'roller'] },
  { title: 'Beleuchtung', families: ['flare'] },
];

const FAMILY_ORDER = ['basepump', 'wave', 'roller', 'flare', 'levelSensor', 'level', 'salinity', 'thermo', 'doser'];

function sortDevices(devices: DeviceSnapshot[]): DeviceSnapshot[] {
  return [...devices].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a.family);
    const ib = FAMILY_ORDER.indexOf(b.family);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.serial.localeCompare(b.serial);
  });
}

export default function Home() {
  const { devices, now, tank, tunnel, error, captureOn, frames, sendCommand, setCapture } = useReef();
  const [selected, setSelected] = useState('dashboard');
  const sorted = sortDevices(devices);
  const online = devices.filter((d) => d.online).length;
  const currentDev = devices.find((d) => d.serial === selected);

  const title = selected === 'dashboard'
    ? `Dashboard${tank ? ` — ${tank}` : ''}`
    : selected === 'log'
      ? 'Protokoll-Monitor'
      : (currentDev?.name ?? 'Gerät');

  const grouped = GROUPS.map((g) => ({
    title: g.title,
    devices: sorted.filter((d) => g.families.includes(d.family)),
  }));
  const rest = sorted.filter((d) => !GROUPS.some((g) => g.families.includes(d.family)));

  return (
    <div className="flex min-h-screen">
      <Toaster position="bottom-right" richColors />
      <div className="hidden lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar tank={tank} devices={sorted} selected={selected} onSelect={setSelected} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <ReefHeader title={title} tunnel={tunnel} online={online} total={devices.length}
          captureOn={captureOn} onCaptureChange={(on) => void setCapture(on)} lastUpdate={now} />

        {/* Mobile: Auswahl als Chips (Sidebar erst ab lg) */}
        <div className="flex gap-2 overflow-x-auto border-b border-border bg-[#f6f9fb] px-3 py-2 lg:hidden">
          <Chip active={selected === 'dashboard'} onClick={() => setSelected('dashboard')} Icon={LayoutDashboard} label="Dashboard" />
          <Chip active={selected === 'log'} onClick={() => setSelected('log')} Icon={ScrollText} label="Protokoll" />
          {sorted.map((d) => {
            const meta = FAMILY_META[d.family] ?? FAMILY_META.unknown;
            return <Chip key={d.serial} active={selected === d.serial} onClick={() => setSelected(d.serial)} Icon={meta.Icon} label={d.name ?? meta.name} dim={!d.online} />;
          })}
        </div>

        <main className="mx-auto max-w-7xl px-4 pb-12 pt-6">
          {error && (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                API nicht erreichbar ({error}) — läuft die reef-cloud-v2 mit Web-Modul auf Port 8080?
                Die Ansicht aktualisiert sich automatisch, sobald sie erreichbar ist.
              </span>
            </div>
          )}

          {selected === 'dashboard' && (
            <>
              {grouped.map((g) => g.devices.length > 0 && (
                <section key={g.title} className="mb-8">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h2>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {g.devices.map((d) => <DeviceCard key={d.serial} dev={d} now={now} sendCommand={sendCommand} />)}
                  </div>
                </section>
              ))}
              {rest.length > 0 && (
                <section className="mb-8">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sensoren & Technik</h2>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {rest.map((d) => <DeviceCard key={d.serial} dev={d} now={now} sendCommand={sendCommand} />)}
                  </div>
                </section>
              )}
              {devices.length === 0 && !error && (
                <p className="text-sm text-muted-foreground">Noch keine Geräte bekannt — sie erscheinen nach ihrem Login an der Cloud.</p>
              )}
            </>
          )}

          {selected === 'log' && <LogView frames={frames} captureOn={captureOn} />}
          {currentDev && <DeviceDetail dev={currentDev} now={now} sendCommand={sendCommand} />}
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
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'border-[#009deb] bg-[#e6f4fd] text-[#009deb]' : 'border-border bg-white text-foreground/70'
      } ${dim ? 'opacity-50' : ''}`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="max-w-32 truncate">{label}</span>
    </button>
  );
}
