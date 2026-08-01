import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CaptureFrame } from '@/types/reef';

interface Props {
  frames: CaptureFrame[];
  captureOn: boolean;
}

// Protokoll-Monitor: letzte Frames der Gerätestrecke (Ringpuffer der reef-cloud).
export default function LogView({ frames, captureOn }: Props) {
  const shown = [...frames].reverse().slice(0, 120);
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Protokoll-Monitor</h2>
        <span className="text-xs text-muted-foreground">
          {captureOn ? `${frames.length} Frames im Puffer` : 'Capture aus — oben rechts aktivieren'}
        </span>
      </div>
      <div className="rounded-xl border border-border/70 bg-card/60">
        <ScrollArea className="h-72">
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Keine Frames im Puffer.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {shown.map((f, i) => (
                  <tr key={`${f.ts}-${i}`} className="border-b border-border/40 last:border-0 hover:bg-secondary/40">
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                      {new Date(f.ts).toLocaleTimeString('de-DE', { hour12: false })}
                    </td>
                    <td className={`px-2 py-1.5 font-mono font-bold ${f.direction === 'out' ? 'text-[#17c3d6]' : 'text-emerald-400'}`}>
                      {f.direction === 'out' ? '→' : '←'}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono">{f.serial}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Badge variant="secondary" className="font-mono text-[10px]">{f.class}/{f.method}</Badge>
                    </td>
                    <td className="max-w-0 truncate px-3 py-1.5 font-mono text-muted-foreground">
                      {f.payloadUtf8 ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ScrollArea>
      </div>
    </section>
  );
}
