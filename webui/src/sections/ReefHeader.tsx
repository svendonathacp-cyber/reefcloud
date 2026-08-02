import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Globe, Wifi, WifiOff } from 'lucide-react';
import { useI18n } from '@/i18n/I18nContext';
import logoUrl from '@/assets/logo.svg';

interface Props {
  title: string;
  tunnel: { connected: boolean; url?: string };
  online: number;
  total: number;
  captureOn: boolean;
  onCaptureChange: (on: boolean) => void;
  lastUpdate: number;
}

// Obere Statusleiste: VPS-Tunnel-Status, Online-Zähler, Capture-Schalter, Sprachwahl
export default function ReefHeader({ title, tunnel, online, total, captureOn, onCaptureChange, lastUpdate }: Props) {
  const { t, locale, effectiveLang, setLang } = useI18n();
  const tunnelHost = tunnel.url ? new URL(tunnel.url).host : '';
  const hostParam = { host: tunnelHost ? ` (${tunnelHost})` : '' };
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-white/85 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <img src={logoUrl} alt="reef-cloud Logo" className="h-7 w-7 shrink-0" />
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  tunnel.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                }`}>
                  {tunnel.connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">{t(tunnel.connected ? 'header.vpsConnected' : 'header.vpsDisconnected')}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t(tunnel.connected ? 'header.tunnelConnected' : 'header.tunnelDisconnected', hostParam)}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Badge variant={online > 0 ? 'default' : 'secondary'} className="gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${online > 0 ? 'bg-emerald-300' : 'bg-muted-foreground'}`} />
            {t('header.online', { online, total })}
          </Badge>
          <div className="flex items-center gap-2">
            <Switch id="capture" checked={captureOn} onCheckedChange={onCaptureChange} />
            <Label htmlFor="capture" className="text-xs text-muted-foreground">{t('header.capture')}</Label>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setLang(effectiveLang === 'de' ? 'en' : 'de')}
                  className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-[#009deb] hover:text-[#009deb]"
                  aria-label={t('lang.switchTooltip')}
                >
                  <Globe className="h-3.5 w-3.5" />
                  {effectiveLang.toUpperCase()}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('lang.switchTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="hidden text-xs text-muted-foreground md:inline">
            {new Date(lastUpdate).toLocaleTimeString(locale, { hour12: false })}
          </span>
        </div>
      </div>
    </header>
  );
}
