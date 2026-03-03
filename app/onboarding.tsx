import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Dimensions,
} from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MessageCircle,
  Bitcoin,
  Globe,
  Radio,
  Lock,
  Users,
  DollarSign,
  ChevronRight,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import { useTranslation } from '@/utils/i18n';
import type { AppLanguage } from '@/providers/AppSettingsProvider';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ONBOARDING_KEY = 'BITMESH_ONBOARDING_DONE';
// Steps: 0=langSelect, 1-4=slides
const TOTAL_STEPS = 5;

function SlideIndicator({ active }: { active: boolean }) {
  return (
    <View
      style={[
        styles.indicator,
        {
          width: active ? 28 : 8,
          backgroundColor: active ? Colors.accent : Colors.textMuted,
        },
      ]}
    />
  );
}

// --- Language selector step ---
function LangSelectStep({ onSelect }: { onSelect: (lang: AppLanguage) => void }) {
  const langs: { code: AppLanguage; flag: string; label: string }[] = [
    { code: 'en', flag: '🇬🇧', label: 'English' },
    { code: 'fr', flag: '🇫🇷', label: 'Français' },
    { code: 'es', flag: '🇪🇸', label: 'Español' },
  ];

  return (
    <View style={styles.langContainer}>
      <Text style={styles.langTitle}>Choose / Choisissez / Elige</Text>
      <Text style={styles.langSubtitle}>Select your language</Text>
      <View style={styles.langButtonsContainer}>
        {langs.map(({ code, flag, label }) => (
          <TouchableOpacity
            key={code}
            style={styles.langButton}
            onPress={() => onSelect(code)}
            activeOpacity={0.7}
          >
            <Text style={styles.langFlag}>{flag}</Text>
            <Text style={styles.langLabel}>{label}</Text>
            <ChevronRight size={18} color={Colors.textMuted} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// --- Slide 1: Value prop ---
function Slide1({ t }: { t: (k: string) => string }) {
  return (
    <View style={styles.slideContainer}>
      <View style={[styles.iconContainer, { backgroundColor: Colors.accentGlow }]}>
        <MessageCircle size={80} color={Colors.accent} strokeWidth={1.5} />
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t('onboarding.slide1.title')}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{t('onboarding.slide1.badge')}</Text>
        </View>
      </View>
      <Text style={[styles.subtitle, { color: Colors.accent }]}>{t('onboarding.slide1.subtitle')}</Text>
      <Text style={styles.description}>{t('onboarding.slide1.description')}</Text>
      <View style={styles.featuresContainer}>
        <View style={styles.featureRow}>
          <Lock size={16} color={Colors.green} />
          <Text style={styles.featureText}>{t('onboarding.slide1.feat1')}</Text>
        </View>
        <View style={styles.featureRow}>
          <Users size={16} color={Colors.green} />
          <Text style={styles.featureText}>{t('onboarding.slide1.feat2')}</Text>
        </View>
        <View style={styles.featureRow}>
          <DollarSign size={16} color={Colors.green} />
          <Text style={styles.featureText}>{t('onboarding.slide1.feat3')}</Text>
        </View>
      </View>
    </View>
  );
}

// --- Slide 2: Two modes ---
function Slide2({ t }: { t: (k: string) => string }) {
  return (
    <View style={styles.slideContainer}>
      <View style={[styles.iconContainer, { backgroundColor: Colors.blueDim }]}>
        <Globe size={80} color={Colors.blue} strokeWidth={1.5} />
      </View>
      <Text style={styles.title}>{t('onboarding.slide2.title')}</Text>
      <Text style={[styles.subtitle, { color: Colors.blue }]}>{t('onboarding.slide2.subtitle')}</Text>

      <View style={styles.modeCard}>
        <View style={styles.modeCardHeader}>
          <Globe size={20} color={Colors.green} />
          <Text style={styles.modeCardTitle}>{t('onboarding.slide2.mode1Title')}</Text>
          <View style={[styles.modeBadge, { backgroundColor: Colors.greenDim }]}>
            <Text style={[styles.modeBadgeText, { color: Colors.green }]}>{t('onboarding.slide2.mode1Badge')}</Text>
          </View>
        </View>
        <Text style={styles.modeCardDesc}>{t('onboarding.slide2.mode1Desc')}</Text>
      </View>

      <View style={styles.modeCard}>
        <View style={styles.modeCardHeader}>
          <Radio size={20} color={Colors.accent} />
          <Text style={styles.modeCardTitle}>{t('onboarding.slide2.mode2Title')}</Text>
          <View style={[styles.modeBadge, { backgroundColor: Colors.accentGlow }]}>
            <Text style={[styles.modeBadgeText, { color: Colors.accent }]}>{t('onboarding.slide2.mode2Badge')}</Text>
          </View>
        </View>
        <Text style={styles.modeCardDesc}>{t('onboarding.slide2.mode2Desc')}</Text>
      </View>
    </View>
  );
}

// --- Slide 3: Bitcoin & Cashu ---
function Slide3({ t }: { t: (k: string) => string }) {
  return (
    <View style={styles.slideContainer}>
      <View style={[styles.iconContainer, { backgroundColor: Colors.accentGlow }]}>
        <Bitcoin size={80} color={Colors.accent} strokeWidth={1.5} />
      </View>
      <Text style={styles.title}>{t('onboarding.slide3.title')}</Text>
      <Text style={[styles.subtitle, { color: Colors.accent }]}>{t('onboarding.slide3.subtitle')}</Text>
      <Text style={styles.description}>{t('onboarding.slide3.description')}</Text>
    </View>
  );
}

// --- Slide 4: Ready ---
function Slide4({ t }: { t: (k: string) => string }) {
  return (
    <View style={styles.slideContainer}>
      <View style={[styles.iconContainer, { backgroundColor: Colors.greenDim }]}>
        <Text style={styles.readyEmoji}>🚀</Text>
      </View>
      <Text style={styles.title}>{t('onboarding.slide4.title')}</Text>
      <Text style={[styles.subtitle, { color: Colors.green }]}>{t('onboarding.slide4.subtitle')}</Text>
      <Text style={styles.description}>{t('onboarding.slide4.description')}</Text>
    </View>
  );
}

export default function OnboardingScreen() {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const { t } = useTranslation();

  // Determine initial step: skip lang select if user already chose a language
  const initialStep = !isLoading && settings.onboardingLangDone ? 1 : 0;
  const [step, setStep] = useState<number | null>(null); // null = waiting for settings to load

  // Step 0 ↔ slides transition
  const langFadeAnim = useRef(new Animated.Value(0)).current;
  const slidesFadeAnim = useRef(new Animated.Value(0)).current;

  // Horizontal slide offset for steps 1–4 (translateX = -(step-1) * SCREEN_WIDTH)
  const slideOffset = useRef(new Animated.Value(0)).current;

  // Once settings are loaded, set the initial step
  useEffect(() => {
    if (!isLoading && step === null) {
      const s = settings.onboardingLangDone ? 1 : 0;
      setStep(s);
      if (s === 0) {
        Animated.timing(langFadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
      } else {
        Animated.timing(slidesFadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
      }
    }
  }, [isLoading]);

  const goToSlides = (lang: AppLanguage) => {
    updateSettings({ language: lang, onboardingLangDone: true });
    // Fade out lang select, fade in slides
    Animated.timing(langFadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setStep(1);
      slideOffset.setValue(0);
      Animated.timing(slidesFadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    });
  };

  const handleNext = () => {
    if (step === null || step >= TOTAL_STEPS - 1) return;
    const nextStep = step + 1;
    // Horizontal spring to next slide
    Animated.spring(slideOffset, {
      toValue: -(nextStep - 1) * SCREEN_WIDTH,
      tension: 60,
      friction: 9,
      useNativeDriver: true,
    }).start();
    setStep(nextStep);
  };

  const handleSkip = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    router.replace('/(tabs)');
  };

  const handleFinish = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    router.replace('/(tabs)');
  };

  // Still loading settings
  if (step === null) {
    return <View style={styles.container} />;
  }

  const isLastSlide = step === TOTAL_STEPS - 1;
  const showDots = step > 0;
  // "Passer" visible on slides 2 and 3 only (not slide 1 — value prop must be read)
  const showSkip = step > 1 && step < TOTAL_STEPS - 1;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>MeshPay</Text>
        {showSkip && (
          <TouchableOpacity onPress={handleSkip}>
            <Text style={styles.skipButton}>{t('onboarding.skip')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Lang select (step 0) */}
      {step === 0 && (
        <Animated.View style={[styles.contentWrapper, { opacity: langFadeAnim }]}>
          <LangSelectStep onSelect={goToSlides} />
        </Animated.View>
      )}

      {/* Slides 1-4 with horizontal slide animation */}
      {step > 0 && (
        <Animated.View style={[styles.contentWrapper, { opacity: slidesFadeAnim, overflow: 'hidden' }]}>
          <Animated.View
            style={[
              styles.slidesRow,
              { transform: [{ translateX: slideOffset }] },
            ]}
          >
            <View style={styles.slideWrapper}><Slide1 t={t} /></View>
            <View style={styles.slideWrapper}><Slide2 t={t} /></View>
            <View style={styles.slideWrapper}><Slide3 t={t} /></View>
            <View style={styles.slideWrapper}><Slide4 t={t} /></View>
          </Animated.View>
        </Animated.View>
      )}

      {/* Dots */}
      {showDots && (
        <View style={styles.indicatorsContainer}>
          {[1, 2, 3, 4].map(i => (
            <SlideIndicator key={i} active={i === step} />
          ))}
        </View>
      )}

      {/* Bottom button — only for slides */}
      {step > 0 && (
        <View style={styles.buttonsContainer}>
          {isLastSlide ? (
            <TouchableOpacity style={styles.finishButton} onPress={handleFinish}>
              <Text style={styles.finishButtonText}>{t('onboarding.start')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
              <Text style={styles.nextButtonText}>{t('onboarding.next')}</Text>
              <ChevronRight size={20} color={Colors.background} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingTop: 60,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    marginBottom: 24,
    minHeight: 32,
  },
  logo: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.accent,
    fontFamily: 'monospace',
  },
  skipButton: {
    fontSize: 16,
    color: Colors.textMuted,
    fontWeight: '600',
  },
  contentWrapper: {
    flex: 1,
    justifyContent: 'center',
  },
  // Horizontal slides container
  slidesRow: {
    flexDirection: 'row',
    width: SCREEN_WIDTH * 4,
    flex: 1,
  },
  slideWrapper: {
    width: SCREEN_WIDTH,
    flex: 1,
    justifyContent: 'center',
  },
  // ---------- Language select ----------
  langContainer: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  langTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  langSubtitle: {
    fontSize: 15,
    color: Colors.textMuted,
    marginBottom: 48,
  },
  langButtonsContainer: {
    width: '100%',
    gap: 16,
  },
  langButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
  },
  langFlag: {
    fontSize: 28,
  },
  langLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
  },
  // ---------- Slides ----------
  slideContainer: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  iconContainer: {
    width: 140,
    height: 140,
    borderRadius: 70,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 28,
  },
  readyEmoji: {
    fontSize: 64,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
  },
  badge: {
    backgroundColor: Colors.accentGlow,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.accent,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 20,
  },
  description: {
    fontSize: 15,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 23,
    paddingHorizontal: 8,
  },
  featuresContainer: {
    marginTop: 28,
    gap: 14,
    alignSelf: 'stretch',
    paddingHorizontal: 16,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  featureText: {
    fontSize: 15,
    color: Colors.text,
    fontWeight: '500',
  },
  // mode cards (slide 2)
  modeCard: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    marginTop: 12,
  },
  modeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  modeCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
  },
  modeBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  modeBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  modeCardDesc: {
    fontSize: 13,
    color: Colors.textMuted,
    lineHeight: 19,
  },
  // ---------- Navigation ----------
  indicatorsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginVertical: 20,
  },
  indicator: {
    height: 8,
    borderRadius: 4,
  },
  buttonsContainer: {
    paddingHorizontal: 24,
  },
  nextButton: {
    backgroundColor: Colors.accent,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  nextButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.background,
  },
  finishButton: {
    backgroundColor: Colors.green,
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  finishButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.background,
  },
});
