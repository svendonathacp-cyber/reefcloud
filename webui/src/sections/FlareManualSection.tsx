import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { StepperInput } from '@/components/ui/stepper-input';
import { useT } from '@/i18n/I18nContext';
import type { MessageKey } from '@/i18n/messages';
import type { CommandFn, DeviceSnapshot } from '@/types/reef';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// 7 Kanäle der lokalen Firmware (Onboard-Report): Name + UI-Farbe (c1)
const CHANNELS: { key: MessageKey; color: string }[] = [
  { key: 'flareManual.channel.0', color: 'rgb(120,127,221)' }, // Violett
  { key: 'flareManual.channel.1', color: 'rgb(137,68,178)' },  // Purpur
  { key: 'flareManual.channel.2', color: 'rgb(114,139,230)' }, // Royalblau
  { key: 'flareManual.channel.3', color: 'rgb(66,148,232)' },  // Cyan
  { key: 'flareManual.channel.4', color: 'rgb(80,215,80)' },   // Grün
  { key: 'flareManual.channel.5', color: 'rgb(200,70,90)' },   // Rot
  { key: 'flareManual.channel.6', color: 'rgb(180,180,180)' }, // Weiß
];

// Flare-Modus-Auswahl (rfMode aus dem Onboard-Report §4: Methode = Modusname,
// kein Payload). Der aktuelle Modus ist nur ableitbar, wenn die Lampe zuletzt
// manualData/offData gepusht hat (state.rfOnboardMode = 'manual'|'off') —
// preciseData trägt keinen Modus, dort bleibt bewusst nichts markiert
// (keine Raterei).
export function FlareModeSwitch({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const current = dev.state.rfOnboardMode === 'manual' || dev.state.rfOnboardMode === 'off'
    ? dev.state.rfOnboardMode
    : null;
  const MODES: { id: 'off' | 'manual' | 'precise'; key: MessageKey }[] = [
    { id: 'off', key: 'flareMode.off' },
    { id: 'manual', key: 'flareMode.manual' },
    { id: 'precise', key: 'flareMode.precise' },
  ];

  const setMode = async (mode: 'off' | 'manual' | 'precise') => {
    if (busy !== null || mode === current) return;
    setBusy(mode);
    try {
      await sendCommand(dev.serial, 'setMode', { mode });
      toast.success(t('flareMode.sent'));
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(null);
  };

  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
      <span className="text-sm text-muted-foreground">{t('flareMode.title')}</span>
      <span className="flex gap-1.5">
        {MODES.map((m) => (
          <Button key={m.id} size="sm" variant={current === m.id ? 'default' : 'outline'}
            disabled={!dev.online || busy !== null} onClick={() => void setMode(m.id)}>
            {busy === m.id ? '…' : t(m.key)}
          </Button>
        ))}
      </span>
    </div>
  );
}

// Flare-Abschnitt „Manuell" (Onboard-Protokoll der lokalen Firmware): nur
// sichtbar, wenn die Lampe manualData gepusht hat (manualPresets im State).
// 7 Kanal-Slider (0–100 %), Gesamtintensität und Timer (Minuten oder „Always").
// Aktionen: rfManual/update + rfManual/time über /api/command.
// Die Programm-Editor-UI (preciseData, andere Firmware-Generation) bleibt
// unverändert daneben bestehen.
export default function FlareManualSection({ dev, sendCommand }: { dev: DeviceSnapshot; sendCommand: CommandFn }) {
  const t = useT();
  const [channels, setChannels] = useState<number[]>([0, 0, 0, 0, 0, 0, 0]);
  const [intensity, setIntensity] = useState(100);
  const [timerMin, setTimerMin] = useState(60);
  const [busy, setBusy] = useState<string | null>(null);

  const stateChannels = Array.isArray(dev.state.channelsManual)
    ? (dev.state.channelsManual as unknown[]).map((c) => num(c))
    : null;
  const stateIntensity = typeof dev.state.manualIntensity === 'number' ? dev.state.manualIntensity : null;
  // manualTimerS: null = „Always", Zahl = Restsekunden
  const timerS = dev.state.manualTimerS === null ? null : num(dev.state.manualTimerS, NaN);
  const presets = Array.isArray(dev.state.manualPresets) ? (dev.state.manualPresets as Record<string, unknown>[]) : [];
  const selIdx = num(dev.state.manualSelectedPreset, 0);
  const activeName = typeof presets[selIdx]?.name === 'string' ? (presets[selIdx].name as string) : null;

  // Lokale Edit-Werte nachziehen, wenn die Lampe neue Daten pusht
  useEffect(() => { if (stateChannels?.length === 7) setChannels(stateChannels); }, [JSON.stringify(stateChannels)]);
  useEffect(() => { if (stateIntensity !== null) setIntensity(stateIntensity); }, [stateIntensity]);

  const run = async (action: string, params: Record<string, unknown>, label: string) => {
    setBusy(action);
    try {
      await sendCommand(dev.serial, action, params);
      toast.success(label);
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(null);
  };

  const dirtyChannels = stateChannels?.length === 7
    ? channels.some((v, i) => v !== stateChannels[i]) || (stateIntensity !== null && intensity !== stateIntensity)
    : true;

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('flareManual.title')}</p>
        {activeName && <Badge variant="secondary">{t('flareManual.preset', { name: activeName })}</Badge>}
      </div>

      <div className="mt-3 space-y-2">
        {CHANNELS.map((ch, i) => (
          <div key={ch.key} className="flex items-center gap-2">
            <span className="flex w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ch.color }} />
              {t(ch.key)}
            </span>
            <Slider value={[channels[i]]} min={0} max={100} step={1} disabled={!dev.online || busy !== null}
              onValueChange={([v]) => setChannels((cs) => cs.map((c, j) => (j === i ? v : c)))} />
            <span className="w-10 shrink-0 text-right font-mono text-xs">{channels[i]} %</span>
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-border/40 pt-2">
          <span className="w-20 shrink-0 text-xs text-muted-foreground">{t('flareManual.intensity')}</span>
          <Slider value={[intensity]} min={0} max={100} step={1} disabled={!dev.online || busy !== null}
            onValueChange={([v]) => setIntensity(v)} />
          <span className="w-10 shrink-0 text-right font-mono text-xs">{intensity} %</span>
        </div>
        <Button size="sm" className="w-full" disabled={!dev.online || busy !== null || !dirtyChannels}
          onClick={() => void run('setManual', { channels, intensity }, t('flareManual.sent'))}>
          {busy === 'setManual' ? '…' : t('common.apply')}
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-border/40 pt-3">
        <span className="w-20 shrink-0 text-xs text-muted-foreground">{t('flareManual.timer')}</span>
        <StepperInput min={1} max={240} value={String(timerMin)} disabled={!dev.online}
          onChange={(v) => setTimerMin(Math.max(1, Number(v) || 1))} className="w-28" />
        <span className="text-xs text-muted-foreground">{t('flareManual.minutes')}</span>
        <Button size="sm" variant="secondary" disabled={!dev.online || busy !== null}
          onClick={() => void run('manualTime', { seconds: timerMin * 60 }, t('flareManual.timerSent'))}>
          {busy === 'manualTime' ? '…' : t('common.apply')}
        </Button>
        <Button size="sm" variant={timerS === null ? 'default' : 'outline'} disabled={!dev.online || busy !== null}
          onClick={() => void run('manualTime', { seconds: 'always' }, t('flareManual.timerSent'))}>
          {t('flareManual.always')}
        </Button>
      </div>
    </div>
  );
}
