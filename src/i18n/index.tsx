import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { SupportedLanguage, Translations } from './types';
import { en } from './translations/en';
import { pt } from './translations/pt';
import { fr } from './translations/fr';
import { es } from './translations/es';
import { saveUiLanguage } from '../services/tauriBridge';

export * from './types';

const TRANSLATIONS: Record<SupportedLanguage, Translations> = {
  en,
  pt,
  fr,
  es,
};

interface I18nContextType {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType>({
  language: 'en',
  setLanguage: () => {},
  t: (path: string) => path,
});

const STORAGE_KEY = 'kwrl_language';

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (saved === 'en' || saved === 'pt' || saved === 'fr' || saved === 'es')) {
        return saved as SupportedLanguage;
      }
    }
    return 'en'; // Strict default: English
  });

  const setLanguage = (lang: SupportedLanguage) => {
    setLanguageState(lang);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, lang);
      document.documentElement.lang = lang;
    }
    // Sincroniza de forma assíncrona com o SQLite no backend Rust
    saveUiLanguage(lang).catch(() => {});
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      document.documentElement.lang = language;
    }
  }, [language]);

  const t = useMemo(() => {
    return (path: string, params?: Record<string, string | number>): string => {
      const parts = path.split('.');
      let current: any = TRANSLATIONS[language];
      let fallback: any = TRANSLATIONS.en;

      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          current = undefined;
        }

        if (fallback && typeof fallback === 'object' && part in fallback) {
          fallback = fallback[part];
        } else {
          fallback = undefined;
        }
      }

      let result = (typeof current === 'string' ? current : (typeof fallback === 'string' ? fallback : path));

      if (params && typeof result === 'string') {
        for (const [key, val] of Object.entries(params)) {
          result = result.replace(new RegExp(`{${key}}`, 'g'), String(val));
        }
      }

      return result;
    };
  }, [language]);

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
