import { Globe } from 'lucide-react';
import { useI18n } from './I18nContext';

// Nicht blockierender Sprach-Dialog beim allerersten Start (kein gespeicherter
// localStorage-Wert). Verschwindet nach der Ein-Klick-Wahl endgültig.
export default function LanguageWelcome() {
  const { lang, setLang, t } = useI18n();
  if (lang !== null) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-border bg-card/95 px-4 py-3 shadow-xl shadow-black/40 backdrop-blur">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Globe className="h-4 w-4 text-[#38bdf8]" />
          {t('lang.choose')}
        </span>
        <span className="flex gap-2">
          <button
            onClick={() => setLang('de')}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:border-[#009deb] hover:bg-[#009deb]/15 hover:text-[#38bdf8]"
          >
            🇩🇪 Deutsch
          </button>
          <button
            onClick={() => setLang('en')}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:border-[#009deb] hover:bg-[#009deb]/15 hover:text-[#38bdf8]"
          >
            🇬🇧 English
          </button>
        </span>
      </div>
    </div>
  );
}
