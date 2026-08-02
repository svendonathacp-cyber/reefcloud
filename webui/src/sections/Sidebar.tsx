import { LayoutDashboard, Plus, ScrollText, Settings as SettingsIcon } from 'lucide-react';
import { deviceDisplayName, FAMILY_META } from './DeviceCard';
import { statusOf } from './DeviceTile';
import { useT } from '@/i18n/I18nContext';
import type { DeviceSnapshot } from '@/types/reef';
import logoUrl from '@/assets/logo.svg';

interface Props {
  devices: DeviceSnapshot[];
  selected: string; // 'dashboard' | 'log' | serial
  onSelect: (id: string) => void;
}

function NavRow({ id, selected, onSelect, Icon, label, dot }: {
  id: string; selected: string; onSelect: (id: string) => void;
  Icon: React.ComponentType<{ className?: string }>; label: string; dot?: 'online' | 'reachable' | 'offline';
}) {
  const active = selected === id;
  return (
    <button
      onClick={() => onSelect(id)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] ${
        active ? 'bg-[#009deb]/15 font-medium text-[#38bdf8]' : 'text-foreground/80 hover:bg-secondary'
      } ${dot && dot !== 'online' ? 'opacity-50' : ''}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {dot && (
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          dot === 'online' ? 'bg-emerald-400' : dot === 'reachable' ? 'border border-amber-400' : 'border border-muted-foreground/40'
        }`} />
      )}
    </button>
  );
}

// Linke Seitenleiste: Dashboard + Protokoll, darunter flache Geräteliste
// (nach Familie gruppiert — es gibt nur ein Aquarium, keine Tank-Ebene mehr)
export default function Sidebar({ devices, selected, onSelect }: Props) {
  const t = useT();

  // Familien in Reihenfolge ihres ersten Auftretens (devices ist vorsortiert)
  const groups: { family: string; items: DeviceSnapshot[] }[] = [];
  for (const d of devices) {
    const g = groups.find((x) => x.family === d.family);
    if (g) g.items.push(d);
    else groups.push({ family: d.family, items: [d] });
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-[#0d1526]">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <img src={logoUrl} alt="reef-cloud Logo" className="h-7 w-7 shrink-0" />
        <div className="leading-tight">
          <span className="bg-gradient-to-r from-[#009deb] to-[#17c3d6] bg-clip-text text-lg font-bold text-transparent">
            reef-cloud
          </span>
          <p className="text-[11px] text-muted-foreground">{t('app.subtitle')}</p>
        </div>
      </div>

      <nav className="space-y-0.5 px-3 pt-2">
        <NavRow id="dashboard" selected={selected} onSelect={onSelect} Icon={LayoutDashboard} label={t('nav.dashboard')} />
        <NavRow id="log" selected={selected} onSelect={onSelect} Icon={ScrollText} label={t('nav.log')} />
      </nav>

      <p className="px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('nav.devices')}</p>
      <div className="px-3 pb-2">
        <button
          onClick={() => onSelect('onboarding')}
          className={`flex w-full items-center gap-2.5 rounded-lg border border-dashed px-3 py-2 text-left text-sm transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] ${
            selected === 'onboarding'
              ? 'border-[#009deb] bg-[#009deb]/15 font-medium text-[#38bdf8]'
              : 'border-[#009deb]/50 text-[#38bdf8]/90 hover:bg-[#009deb]/10'
          }`}
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('onboarding.addDevice')}</span>
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        {groups.map((g) => {
          const meta = FAMILY_META[g.family] ?? FAMILY_META.unknown;
          return (
            <div key={g.family}>
              <p className="flex items-center gap-1.5 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
                {t(meta.nameKey)}
              </p>
              <div className="space-y-0.5">
                {g.items.map((d) => (
                  <NavRow
                    key={d.serial}
                    id={d.serial}
                    selected={selected}
                    onSelect={onSelect}
                    Icon={meta.Icon}
                    label={deviceDisplayName(d) || t(meta.nameKey)}
                    dot={statusOf(d)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Einstellungen fixiert am unteren Rand der Sidebar */}
      <div className="border-t border-border px-3 py-2">
        <NavRow id="settings" selected={selected} onSelect={onSelect} Icon={SettingsIcon} label={t('nav.settings')} />
      </div>
    </aside>
  );
}
