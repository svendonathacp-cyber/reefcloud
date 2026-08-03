import { Fan, Trash2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/i18n/I18nContext';
import type { JebaoPumpsApi } from '@/sections/jebao-shared';

// Jebao-Pumpen-Verwaltung: listet die bereits konfigurierten Pumpen aus
// jebao.json (über /api/jebao) und erlaubt das Entfernen. Das Hinzufügen
// (Discovery + manuell per IP) liegt in der Sektion „Geräte hinzufügen"
// (AddDeviceSection) — beide teilen sich denselben Hook-State aus Settings.
export default function JebaoSection({ jebao }: { jebao: JebaoPumpsApi }) {
  const t = useT();
  const { pumps, loadError, remove } = jebao;

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {t('settings.jebao')}
      </h2>
      <div className="rounded-xl border border-border/70 bg-card/80 p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">{t('jebao.settings.desc')}</p>

        {/* Konfigurierte Pumpen */}
        {pumps === null && !loadError && (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        )}
        {loadError && (
          <p className="mt-4 text-sm text-amber-400">{t('jebao.settings.scanError', { error: loadError })}</p>
        )}
        {pumps !== null && pumps.length === 0 && !loadError && (
          <p className="mt-4 text-sm text-muted-foreground">{t('jebao.settings.none')}</p>
        )}
        {pumps !== null && pumps.length > 0 && (
          <ul className="mt-4 space-y-2">
            {pumps.map((p) => (
              <li key={p.ip} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#60a5fa]/15 text-[#60a5fa]">
                  <Fan className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium">{p.name || t('family.jebao')}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {p.ip}{p.mac ? ` · ${p.mac}` : ''}{p.serial ? ` · ${p.serial}` : ''}
                  </span>
                </span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-400"
                      aria-label={t('jebao.settings.remove')}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('jebao.settings.removeTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('jebao.settings.removeConfirm', { name: p.name || p.ip, ip: p.ip })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void remove(p)}>{t('jebao.settings.remove')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
