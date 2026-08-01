import { ChevronDown, LayoutDashboard, ScrollText } from 'lucide-react';
import { FAMILY_META } from './DeviceCard';
import type { DeviceSnapshot } from '@/types/reef';

function CubeLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M20 4 34 12 20 20 6 12Z" stroke="#f5a623" />
      <path d="M6 12 20 20 20 36 6 28Z" stroke="#3ecf6e" />
      <path d="M34 12 20 20 20 36 34 28Z" stroke="#009deb" />
    </svg>
  );
}

interface Props {
  tank: string | null;
  devices: DeviceSnapshot[];
  selected: string; // 'dashboard' | 'log' | serial
  onSelect: (id: string) => void;
}

function NavRow({ id, selected, onSelect, Icon, label, online }: {
  id: string; selected: string; onSelect: (id: string) => void;
  Icon: React.ComponentType<{ className?: string }>; label: string; online?: boolean;
}) {
  const active = selected === id;
  return (
    <button
      onClick={() => onSelect(id)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        active ? 'bg-[#e6f4fd] font-medium text-[#009deb]' : 'text-foreground/80 hover:bg-secondary'
      } ${online === false ? 'opacity-50' : ''}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {online !== undefined && (
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
      )}
    </button>
  );
}

// Linke Seitenleiste im Stil der Reef-Factory-Web-Cloud
export default function Sidebar({ tank, devices, selected, onSelect }: Props) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-[#f6f9fb]">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <CubeLogo />
        <div className="leading-tight">
          <span className="bg-gradient-to-r from-[#009deb] to-[#17c3d6] bg-clip-text text-lg font-bold text-transparent">
            reefcloud
          </span>
          <p className="text-[11px] text-muted-foreground">Lokale Reef-Factory-Cloud</p>
        </div>
      </div>

      <div className="px-3 pb-1 pt-2">
        <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Aquarienliste</p>
        <button className="flex w-full items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium shadow-sm">
          <span className="min-w-0 flex-1 truncate text-left">{tank ?? 'Aquarium'}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <nav className="space-y-0.5 px-3 pt-2">
        <NavRow id="dashboard" selected={selected} onSelect={onSelect} Icon={LayoutDashboard} label="Dashboard" />
        <NavRow id="log" selected={selected} onSelect={onSelect} Icon={ScrollText} label="Protokoll" />
      </nav>

      <p className="px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Geräte</p>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        {devices.map((d) => {
          const meta = FAMILY_META[d.family] ?? FAMILY_META.unknown;
          return (
            <NavRow
              key={d.serial}
              id={d.serial}
              selected={selected}
              onSelect={onSelect}
              Icon={meta.Icon}
              label={d.name ?? meta.name}
              online={d.online}
            />
          );
        })}
      </div>
    </aside>
  );
}
