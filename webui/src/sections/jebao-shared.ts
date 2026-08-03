import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useT } from '@/i18n/I18nContext';
import type { JebaoPump } from '@/types/reef';

// Gemeinsame Jebao-Helfer für AddDeviceSection (Discovery/Hinzufügen) und
// JebaoSection (Verwaltung). Der Hook wird einmal in Settings instanziiert
// und an beide Sektionen weitergereicht, damit die konfigurierte Pumpenliste
// nach einem Hinzufügen überall konsistent aktualisiert wird.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const validIp = (ip: string) => IPV4_RE.test(ip) && ip.split('.').every((o) => Number(o) <= 255);

export async function fetchJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
}

export interface JebaoPumpsApi {
  pumps: JebaoPump[] | null; // null = noch ladend
  loadError: string | null;
  busy: boolean;
  load: () => Promise<void>;
  /** Fügt eine Pumpe hinzu. Rückgabe: true bei Erfolg. successHint wird als Toast-Beschreibung angehängt. */
  add: (ip: string, name: string, productKey?: string, successHint?: string) => Promise<boolean>;
  remove: (p: JebaoPump) => Promise<void>;
}

// Konfigurierte Pumpen (jebao.json über /api/jebao) laden, hinzufügen, entfernen.
export function useJebaoPumps(): JebaoPumpsApi {
  const t = useT();
  const [pumps, setPumps] = useState<JebaoPump[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetchJson('/api/jebao');
      setPumps(Array.isArray(j.pumps) ? (j.pumps as JebaoPump[]) : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = useCallback(async (ip: string, name: string, productKey?: string, successHint?: string) => {
    setBusy(true);
    try {
      await fetchJson('/api/jebao', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip, name, ...(productKey ? { productKey } : {}) }),
      });
      toast.success(t('jebao.settings.added'), successHint ? { description: successHint } : undefined);
      await load();
      return true;
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const remove = useCallback(async (p: JebaoPump) => {
    try {
      await fetchJson('/api/jebao', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: p.ip }),
      });
      toast.success(t('jebao.settings.removed'));
      await load();
    } catch (e) {
      toast.error(t('common.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [load, t]);

  return { pumps, loadError, busy, load, add, remove };
}
