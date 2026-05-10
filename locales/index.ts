import en from './en';
import fr from './fr';
import es from './es';

const locales = { en, fr, es };
let currentLang: keyof typeof locales = 'en';

export function setLanguage(lang: keyof typeof locales) {
  currentLang = lang;
}

export function t(key: string, fallback?: string): string {
  const keys = key.split('.');
  let value: any = locales[currentLang];
  for (const k of keys) {
    value = value?.[k];
  }
  return value || fallback || key;
}

export { en, fr, es };
