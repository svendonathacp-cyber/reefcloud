import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { de, en, type MessageKey } from './messages';

export type Lang = 'de' | 'en';
const STORAGE_KEY = 'reefcloud.lang';
const DICTS: Record<Lang, Record<MessageKey, string>> = { de, en };

type Params = Record<string, string | number>;

function interpolate(s: string, params?: Params): string {
  if (!params) return s;
  let out = s;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

// Gespeicherte Sprache ohne Hook-Kontext lesen (z. B. für nicht-reaktive Callbacks)
export function storedLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'de' || v === 'en' ? v : 'de';
  } catch {
    return 'de';
  }
}

// Übersetzung außerhalb von React-Komponenten (nutzt die persistierte Sprache)
export function tStatic(key: MessageKey, params?: Params): string {
  return interpolate(DICTS[storedLang()][key] ?? de[key], params);
}

export function localeOf(lang: Lang): string {
  return lang === 'de' ? 'de-DE' : 'en-GB';
}

interface I18nValue {
  lang: Lang | null; // null = Nutzer hat noch nicht gewählt (First-Run)
  effectiveLang: Lang;
  locale: string; // 'de-DE' | 'en-GB' für Datums-/Zeitformate
  setLang: (l: Lang) => void;
  t: (key: MessageKey, params?: Params) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang | null>(() => {
    // Optionaler URL-Override (?lang=en) für teilbare Links — persistiert nichts
    try {
      const q = new URLSearchParams(window.location.search).get('lang');
      if (q === 'de' || q === 'en') return q;
    } catch { /* ignore */ }
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'de' || v === 'en' ? v : null;
    } catch {
      return null;
    }
  });

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch { /* localStorage kann fehlen — dann nur Session-Sprache */ }
  }, []);

  const effectiveLang: Lang = lang ?? 'de';
  const locale = localeOf(effectiveLang);

  // html lang-Attribut und Dokumenttitel synchron halten
  useEffect(() => {
    document.documentElement.lang = effectiveLang;
    document.title = DICTS[effectiveLang]['app.title'];
  }, [effectiveLang]);

  const t = useCallback(
    (key: MessageKey, params?: Params) => interpolate(DICTS[effectiveLang][key] ?? de[key], params),
    [effectiveLang],
  );

  const value = useMemo(
    () => ({ lang, effectiveLang, locale, setLang, t }),
    [lang, effectiveLang, locale, setLang, t],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n() außerhalb von <I18nProvider>');
  return ctx;
}

export function useT(): I18nValue['t'] {
  return useI18n().t;
}
