import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
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
  const { settings, updateSettings } = useAppSettings();
  const { t } = useTranslation();

  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const animateTransition = (cb: () => void) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      cb();
      Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    });
  };

  useEffect(() => {
    // Entrance animation
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
  }, []);

  const handleSelectLang = (lang: AppLanguage) => {
    updateSettings({ language: lang });
    animateTransition(() => setStep(1));
  };

  const handleNext = () => {
    animateTransition(() => setStep(s => s + 1));
  };

  const handleSkip = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    router.replace('/(tabs)');
  };

  const handleFinish = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    router.replace('/(tabs)');
  };

  const isLastSlide = step === TOTAL_STEPS - 1;
  // Dots shown from step 1 onward (step 0 = lang select has no dots)
  const showDots = step > 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>MeshPay</Text>
        {step > 0 && step < TOTAL_STEPS - 1 && (
          <TouchableOpacity onPress={handleSkip}>
            <Text style={styles.skipButton}>{t('onboarding.skip')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Content */}
      <Animated.View style={[styles.contentWrapper, { opacity: fadeAnim }]}>
        {step === 0 && <LangSelectStep onSelect={handleSelectLang} />}
        {step === 1 && <Slide1 t={t} />}
        {step === 2 && <Slide2 t={t} />}
        {step === 3 && <Slide3 t={t} />}
        {step === 4 && <Slide4 t={t} />}
      </Animated.View>

      {/* Dots */}
      {showDots && (
        <View style={styles.indicatorsContainer}>
          {[1, 2, 3, 4].map(i => (
            <SlideIndicator key={i} active={i === step} />
          ))}
        </View>
      )}

      {/* Bottom button (not shown on step 0 — lang buttons are the CTA) */}
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
