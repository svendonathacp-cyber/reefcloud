import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

// Wireframe-Cube in Anlehnung an das Reef-Factory-Logo (Orange/Grün/Reef-Blau)
function CubeLogo() {
  return (
    <svg width="36" height="36" viewBox="0 0 40 40" fill="none" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M20 4 34 12 20 20 6 12Z" stroke="#f5a623" />
      <path d="M6 12 20 20 20 36 6 28Z" stroke="#3ecf6e" />
      <path d="M34 12 20 20 20 36 34 28Z" stroke="#009deb" />
    </svg>
  );
}

interface Props {
  online: number;
  total: number;
  captureOn: boolean;
  onCaptureChange: (on: boolean) => void;
  lastUpdate: number;
}

export default function ReefHeader({ online, total, captureOn, onCaptureChange, lastUpdate }: Props) {
  return (
    <header className="sticky top-0 z-10 border-b border-border/70 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <CubeLogo />
        <div className="flex flex-col leading-tight">
          <span className="bg-gradient-to-r from-[#009deb] to-[#17c3d6] bg-clip-text text-xl font-bold tracking-tight text-transparent">
            reefcloud
          </span>
          <span className="text-xs text-muted-foreground">Lokale Reef-Factory-Cloud</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <Badge variant={online > 0 ? 'default' : 'secondary'} className="gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${online > 0 ? 'bg-emerald-400' : 'bg-muted-foreground'}`} />
            {online}/{total} online
          </Badge>
          <div className="flex items-center gap-2">
            <Switch id="capture" checked={captureOn} onCheckedChange={onCaptureChange} />
            <Label htmlFor="capture" className="text-xs text-muted-foreground">Capture</Label>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            aktualisiert {new Date(lastUpdate).toLocaleTimeString('de-DE', { hour12: false })}
          </span>
        </div>
      </div>
    </header>
  );
}
