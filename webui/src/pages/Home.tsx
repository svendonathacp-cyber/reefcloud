import { AlertTriangle } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { useReef } from '@/hooks/useReef';
import type { DeviceSnapshot } from '@/types/reef';
import ReefHeader from '@/sections/ReefHeader';
import DeviceCard from '@/sections/DeviceCard';
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
  const { devices, now, error, captureOn, frames, sendCommand, setCapture } = useReef();
  const sorted = sortDevices(devices);
  const online = devices.filter((d) => d.online).length;
  const grouped = GROUPS.map((g) => ({
    title: g.title,
    devices: sorted.filter((d) => g.families.includes(d.family)),
  }));
  const rest = sorted.filter((d) => !GROUPS.some((g) => g.families.includes(d.family)));

  return (
    <div className="min-h-screen">
      <Toaster position="bottom-right" theme="dark" richColors />
      <ReefHeader online={online} total={devices.length} captureOn={captureOn}
        onCaptureChange={(on) => void setCapture(on)} lastUpdate={now} />

      <main className="mx-auto max-w-7xl px-4 pb-12 pt-6">
        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              API nicht erreichbar ({error}) — läuft die reef-cloud-v2 mit Web-Modul auf Port 8080?
              Die Ansicht aktualisiert sich automatisch, sobald sie erreichbar ist.
            </span>
          </div>
        )}

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

        <LogView frames={frames} captureOn={captureOn} />
      </main>
    </div>
  );
}
