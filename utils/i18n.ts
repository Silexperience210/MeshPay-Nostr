import { useAppSettings } from '@/providers/AppSettingsProvider';
import en from '@/locales/en';
import fr from '@/locales/fr';
import es from '@/locales/es';
import type { AppLanguage } from '@/providers/AppSettingsProvider';

const LOCALES: Record<AppLanguage, typeof en> = { en, fr, es };

// Traverse a nested object with dot-separated key (e.g. "onboarding.slide1.title")
function resolve(obj: Record<string, unknown>, key: string): string {
  const result = key.split('.').reduce<unknown>((o, k) => {
    if (o && typeof o === 'object') return (o as Record<string, unknown>)[k];
    return undefined;
  }, obj);
  return typeof result === 'string' ? result : key;
}

export function useTranslation() {
  const { settings } = useAppSettings();
  const lang: AppLanguage = settings.language ?? 'en';
  const locale = LOCALES[lang] as unknown as Record<string, unknown>;

  const t = (key: string): string => resolve(locale, key);

  return { t, lang };
}
