/**
 * Identity Setup Screen - Optimized Version
 * 
 * Fixes applied:
 * - Removed all console.log statements causing freeze
 * - Memoized styles and colors
 * - Stabilized callback references
 * - Fixed ScrollView performance
 * - Fixed navigation to explicit route
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Clipboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/colors';
import { useUnifiedIdentity } from '../../engine/hooks/useUnifiedIdentity';

// ============================
// CONSTANTS (hors composant)
// ============================

const ONBOARDING_KEY = 'BITMESH_ONBOARDING_DONE';

const THEME_COLORS = {
  background: Colors.background,
  text: Colors.text,
  placeholder: Colors.textMuted,
  cardBackground: Colors.surface,
  border: Colors.border,
  accent: Colors.accent,
  success: Colors.green,
  warning: Colors.orange,
  danger: Colors.red,
  inputBackground: Colors.surfaceLight,
};

const IS_DARK = THEME_COLORS.background === '#000000' || THEME_COLORS.background === '#1a1a1a';

const MNEMONIC_STRENGTH_OPTIONS = [
  { label: '12 mots (128 bits)', value: 128, description: 'Standard - Recommandé' },
  { label: '15 mots (160 bits)', value: 160, description: 'Sécurité renforcée' },
  { label: '24 mots (256 bits)', value: 256, description: 'Paranoïa niveau maximum' },
];

// ============================
// TYPES
// ============================

type SetupStep = 'mode' | 'create' | 'restore' | 'password' | 'backup' | 'success';

// ============================
// STYLES MÉMOÏSÉS
// ============================

const STATIC_STYLES = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME_COLORS.background,
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
  },
  header: {
    marginBottom: 40,
    alignItems: 'center',
  },
  icon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: THEME_COLORS.accent + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: THEME_COLORS.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: THEME_COLORS.placeholder,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 20,
  },
  buttonGroup: {
    gap: 16,
  },
  primaryButton: {
    backgroundColor: THEME_COLORS.accent,
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: THEME_COLORS.placeholder,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: THEME_COLORS.border,
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: THEME_COLORS.text,
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  backButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  backButtonText: {
    color: THEME_COLORS.placeholder,
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    backgroundColor: THEME_COLORS.inputBackground,
    borderWidth: 1,
    borderColor: THEME_COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: THEME_COLORS.text,
    marginBottom: 16,
  },
  inputError: {
    borderColor: THEME_COLORS.danger,
  },
  strengthSelector: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  strengthOption: {
    flex: 1,
    backgroundColor: THEME_COLORS.cardBackground,
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  strengthOptionSelected: {
    borderColor: THEME_COLORS.accent,
  },
  strengthOptionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: THEME_COLORS.text,
    marginBottom: 4,
  },
  strengthOptionDescription: {
    fontSize: 12,
    color: THEME_COLORS.placeholder,
  },
  mnemonicCard: {
    backgroundColor: THEME_COLORS.cardBackground,
    borderRadius: 16,
    padding: 24,
    marginTop: 24,
  },
  mnemonicGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mnemonicWord: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME_COLORS.inputBackground,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  mnemonicWordNumber: {
    fontSize: 10,
    color: THEME_COLORS.placeholder,
    marginRight: 6,
    width: 20,
  },
  mnemonicWordText: {
    fontSize: 14,
    color: THEME_COLORS.text,
    fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 16,
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: THEME_COLORS.border,
  },
  copyButtonText: {
    marginLeft: 8,
    color: THEME_COLORS.accent,
    fontWeight: '600',
    fontSize: 14,
  },
  warningBox: {
    flexDirection: 'row',
    backgroundColor: THEME_COLORS.warning + '15',
    borderRadius: 12,
    padding: 16,
    marginTop: 24,
    gap: 12,
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    color: THEME_COLORS.warning,
    lineHeight: 20,
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    gap: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: THEME_COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: THEME_COLORS.accent,
    borderColor: THEME_COLORS.accent,
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
    color: THEME_COLORS.text,
  },
  successContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  successIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: THEME_COLORS.success + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  successTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: THEME_COLORS.text,
    marginBottom: 12,
  },
  successSubtitle: {
    fontSize: 16,
    color: THEME_COLORS.placeholder,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 40,
  },
  identitySummary: {
    width: '100%',
    backgroundColor: THEME_COLORS.cardBackground,
    borderRadius: 16,
    padding: 20,
    marginTop: 32,
  },
  identitySummaryTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: THEME_COLORS.text,
    marginBottom: 16,
  },
  identityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  identityIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: THEME_COLORS.accent + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  identityItemLabel: {
    fontSize: 12,
    color: THEME_COLORS.placeholder,
  },
  identityItemValue: {
    fontSize: 14,
    fontWeight: '500',
    color: THEME_COLORS.text,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  errorText: {
    color: THEME_COLORS.danger,
    fontSize: 13,
    marginTop: -12,
    marginBottom: 16,
  },
  progressContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: THEME_COLORS.border,
  },
  progressBar: {
    height: '100%',
    backgroundColor: THEME_COLORS.accent,
  },
});

// ============================
// MAIN COMPONENT
// ============================

export default function IdentitySetupScreen() {
  const router = useRouter();
  const { createWallet, restoreWallet, isLoading, error, clearError } = useUnifiedIdentity();

  // State
  const [step, setStep] = useState<SetupStep>('mode');
  const [mnemonic, setMnemonic] = useState('');
  const [mnemonicStrength, setMnemonicStrength] = useState(128);
  const [restoreInput, setRestoreInput] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);
  const [identitySummary, setIdentitySummary] = useState<{ bitcoinAddress?: string; nostrPubkey?: string; meshcoreNodeId?: string } | null>(null);

  // Refs pour anti-double-click
  const isCreatingRef = useRef(false);
  const isRestoringRef = useRef(false);
  const isNavigatingRef = useRef(false);

  // ============================
  // HANDLERS (stabilisés avec useCallback)
  // ============================

  const goToStep = useCallback((newStep: SetupStep) => {
    setStep(newStep);
    clearError();
  }, [clearError]);

  const goBack = useCallback(() => {
    switch (step) {
      case 'create':
      case 'restore':
        goToStep('mode');
        break;
      case 'password':
        goToStep('create');
        break;
      case 'backup':
        goToStep('password');
        break;
      default:
        break;
    }
  }, [step, goToStep]);

  const copyMnemonic = useCallback(async () => {
    if (!mnemonic) return;
    await Clipboard.setString(mnemonic);
    setMnemonicCopied(true);
    setTimeout(() => setMnemonicCopied(false), 2000);
  }, [mnemonic]);

  const handleCreateWallet = useCallback(async () => {
    if (isCreatingRef.current) return;
    isCreatingRef.current = true;
    
    try {
      // Convert strength (bits) to word count: 128->12, 160->15, 256->24
      const wordCount = mnemonicStrength === 128 ? 12 : mnemonicStrength === 160 ? 15 : 24;
      const generatedMnemonic = await createWallet(wordCount as 12 | 24, password);
      setMnemonic(generatedMnemonic);
      goToStep('backup');
    } finally {
      isCreatingRef.current = false;
    }
  }, [createWallet, mnemonicStrength, password, goToStep]);

  const handleRestoreWallet = useCallback(async () => {
    if (isRestoringRef.current) return;
    isRestoringRef.current = true;

    const cleanMnemonic = restoreInput.trim().toLowerCase();
    const words = cleanMnemonic.split(/\s+/);
    
    if (words.length !== 12 && words.length !== 15 && words.length !== 24) {
      Alert.alert('Phrase invalide', 'La phrase de récupération doit contenir 12, 15 ou 24 mots.');
      isRestoringRef.current = false;
      return;
    }

    try {
      await restoreWallet(cleanMnemonic, password);
      // L'identité est maintenant créée, récupérer le résumé depuis le store
      goToStep('success');
    } finally {
      isRestoringRef.current = false;
    }
  }, [restoreInput, password, restoreWallet, goToStep]);

  const handlePasswordSubmit = useCallback(async () => {
    setPasswordError('');

    if (password.length < 8) {
      setPasswordError('Le mot de passe doit contenir au moins 8 caractères');
      return;
    }

    if (password !== confirmPassword) {
      setPasswordError('Les mots de passe ne correspondent pas');
      return;
    }

    if (step === 'create') {
      await handleCreateWallet();
    } else if (step === 'restore') {
      await handleRestoreWallet();
    }
  }, [password, confirmPassword, step, handleCreateWallet, handleRestoreWallet]);

  const handleBackupConfirmed = useCallback(() => {
    if (!backupConfirmed) return;
    goToStep('success');
  }, [backupConfirmed, goToStep]);

  const handleComplete = useCallback(async () => {
    if (isNavigatingRef.current) return;
    isNavigatingRef.current = true;

    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      
      // Navigation avec délai pour éviter les conflits
      setTimeout(() => {
        router.push('/(tabs)/(messages)');
      }, 50);
    } catch {
      router.push('/(tabs)/(messages)');
    }
  }, [router]);

  // ============================
  // MEMOIZED VALUES
  // ============================

  const progressWidth = useMemo(() => {
    switch (step) {
      case 'create':
      case 'restore':
        return '33%';
      case 'password':
        return '66%';
      case 'backup':
        return '80%';
      case 'success':
        return '100%';
      default:
        return '0%';
    }
  }, [step]);

  const canSubmitPassword = password.length >= 8 && password === confirmPassword;

  // ============================
  // RENDER FUNCTIONS (composants internes pour éviter recréation)
  // ============================

  const renderModeStep = () => (
    <>
      <View style={STATIC_STYLES.header}>
        <View style={STATIC_STYLES.icon}>
          <Ionicons name="wallet-outline" size={40} color={THEME_COLORS.accent} />
        </View>
        <Text style={STATIC_STYLES.title}>Créer votre identité</Text>
        <Text style={STATIC_STYLES.subtitle}>
          Générez une clé unique pour Bitcoin, Nostr et MeshCore,{'\n'}
          ou restaurez une identité existante.
        </Text>
      </View>

      <View style={STATIC_STYLES.buttonGroup}>
        <TouchableOpacity
          style={STATIC_STYLES.primaryButton}
          onPress={() => goToStep('create')}
          activeOpacity={0.8}
        >
          <Ionicons name="add-circle-outline" size={20} color="#FFF" />
          <Text style={STATIC_STYLES.primaryButtonText}>Créer un nouveau portefeuille</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={STATIC_STYLES.secondaryButton}
          onPress={() => goToStep('restore')}
          activeOpacity={0.8}
        >
          <Ionicons name="refresh-outline" size={20} color={THEME_COLORS.text} />
          <Text style={STATIC_STYLES.secondaryButtonText}>Restaurer un portefeuille</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderCreateStep = () => (
    <>
      <View style={STATIC_STYLES.header}>
        <View style={[STATIC_STYLES.icon, { backgroundColor: THEME_COLORS.accent + '20' }]}>
          <Ionicons name="key-outline" size={40} color={THEME_COLORS.accent} />
        </View>
        <Text style={STATIC_STYLES.title}>Force de la clé</Text>
        <Text style={STATIC_STYLES.subtitle}>
          Choisissez le nombre de mots pour votre phrase de récupération.
        </Text>
      </View>

      <View style={STATIC_STYLES.strengthSelector}>
        {MNEMONIC_STRENGTH_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.value}
            style={[
              STATIC_STYLES.strengthOption,
              mnemonicStrength === option.value && STATIC_STYLES.strengthOptionSelected,
            ]}
            onPress={() => setMnemonicStrength(option.value)}
            activeOpacity={0.8}
          >
            <Text style={STATIC_STYLES.strengthOptionLabel}>{option.label}</Text>
            <Text style={STATIC_STYLES.strengthOptionDescription}>{option.description}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={[STATIC_STYLES.buttonGroup, { marginTop: 40 }]}>
        <TouchableOpacity
          style={STATIC_STYLES.primaryButton}
          onPress={() => goToStep('password')}
          activeOpacity={0.8}
        >
          <Text style={STATIC_STYLES.primaryButtonText}>Continuer</Text>
          <Ionicons name="arrow-forward" size={20} color="#FFF" />
        </TouchableOpacity>

        <TouchableOpacity style={STATIC_STYLES.backButton} onPress={goBack}>
          <Text style={STATIC_STYLES.backButtonText}>Retour</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderRestoreStep = () => (
    <>
      <View style={STATIC_STYLES.header}>
        <View style={[STATIC_STYLES.icon, { backgroundColor: THEME_COLORS.accent + '20' }]}>
          <Ionicons name="refresh-outline" size={40} color={THEME_COLORS.accent} />
        </View>
        <Text style={STATIC_STYLES.title}>Restaurer</Text>
        <Text style={STATIC_STYLES.subtitle}>
          Entrez votre phrase de récupération de 12, 15 ou 24 mots.
        </Text>
      </View>

      <TextInput
        style={[STATIC_STYLES.input, { height: 120, textAlignVertical: 'top' }]}
        placeholder="votre phrase de récupération..."
        placeholderTextColor={THEME_COLORS.placeholder}
        value={restoreInput}
        onChangeText={setRestoreInput}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={STATIC_STYLES.buttonGroup}>
        <TouchableOpacity
          style={[STATIC_STYLES.primaryButton, !restoreInput.trim() && STATIC_STYLES.primaryButtonDisabled]}
          onPress={() => goToStep('password')}
          disabled={!restoreInput.trim()}
          activeOpacity={0.8}
        >
          <Text style={STATIC_STYLES.primaryButtonText}>Continuer</Text>
          <Ionicons name="arrow-forward" size={20} color="#FFF" />
        </TouchableOpacity>

        <TouchableOpacity style={STATIC_STYLES.backButton} onPress={goBack}>
          <Text style={STATIC_STYLES.backButtonText}>Retour</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderPasswordStep = () => (
    <>
      <View style={STATIC_STYLES.header}>
        <View style={[STATIC_STYLES.icon, { backgroundColor: THEME_COLORS.accent + '20' }]}>
          <Ionicons name="lock-closed-outline" size={40} color={THEME_COLORS.accent} />
        </View>
        <Text style={STATIC_STYLES.title}>Mot de passe</Text>
        <Text style={STATIC_STYLES.subtitle}>
          Ce mot de passe chiffrera votre identité sur cet appareil.
        </Text>
      </View>

      <TextInput
        style={[STATIC_STYLES.input, passwordError && STATIC_STYLES.inputError]}
        placeholder="Mot de passe (min. 8 caractères)"
        placeholderTextColor={THEME_COLORS.placeholder}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
      />

      <TextInput
        style={[STATIC_STYLES.input, passwordError && STATIC_STYLES.inputError]}
        placeholder="Confirmer le mot de passe"
        placeholderTextColor={THEME_COLORS.placeholder}
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secureTextEntry
        autoCapitalize="none"
      />

      {passwordError ? <Text style={STATIC_STYLES.errorText}>{passwordError}</Text> : null}

      <View style={STATIC_STYLES.buttonGroup}>
        <TouchableOpacity
          style={[STATIC_STYLES.primaryButton, !canSubmitPassword && STATIC_STYLES.primaryButtonDisabled]}
          onPress={handlePasswordSubmit}
          disabled={!canSubmitPassword || isLoading}
          activeOpacity={0.8}
        >
          {isLoading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <>
              <Text style={STATIC_STYLES.primaryButtonText}>Créer l'identité</Text>
              <Ionicons name="shield-checkmark-outline" size={20} color="#FFF" />
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={STATIC_STYLES.backButton} onPress={goBack}>
          <Text style={STATIC_STYLES.backButtonText}>Retour</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderBackupStep = () => (
    <ScrollView
      style={STATIC_STYLES.scrollContainer}
      contentContainerStyle={STATIC_STYLES.scrollContent}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews={true}
    >
      <View style={STATIC_STYLES.header}>
        <View style={[STATIC_STYLES.icon, { backgroundColor: THEME_COLORS.warning + '20' }]}>
          <Ionicons name="warning-outline" size={40} color={THEME_COLORS.warning} />
        </View>
        <Text style={STATIC_STYLES.title}>Sauvegarde</Text>
        <Text style={STATIC_STYLES.subtitle}>
          Écrivez ces mots sur papier.{'\n'}Ils sont la SEULE façon de récupérer votre portefeuille.
        </Text>
      </View>

      <View style={STATIC_STYLES.mnemonicCard}>
        <View style={STATIC_STYLES.mnemonicGrid}>
          {mnemonic.split(' ').map((word, index) => (
            <View key={index} style={STATIC_STYLES.mnemonicWord}>
              <Text style={STATIC_STYLES.mnemonicWordNumber}>{index + 1}.</Text>
              <Text style={STATIC_STYLES.mnemonicWordText}>{word}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity style={STATIC_STYLES.copyButton} onPress={copyMnemonic}>
          <Ionicons name={mnemonicCopied ? 'checkmark-circle' : 'copy-outline'} size={18} color={THEME_COLORS.accent} />
          <Text style={STATIC_STYLES.copyButtonText}>
            {mnemonicCopied ? 'Copié !' : 'Copier'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={STATIC_STYLES.warningBox}>
        <Ionicons name="warning" size={24} color={THEME_COLORS.warning} />
        <Text style={STATIC_STYLES.warningText}>
          Ne faites jamais de capture d'écran.{'\n'}
          Ne partagez jamais ces mots.{'\n'}
          BitMesh ne peut PAS les récupérer.
        </Text>
      </View>

      <TouchableOpacity
        style={STATIC_STYLES.checkboxContainer}
        onPress={() => setBackupConfirmed(!backupConfirmed)}
        activeOpacity={0.8}
      >
        <View style={[STATIC_STYLES.checkbox, backupConfirmed && STATIC_STYLES.checkboxChecked]}>
          {backupConfirmed && <Ionicons name="checkmark" size={16} color="#FFF" />}
        </View>
        <Text style={STATIC_STYLES.checkboxLabel}>
          J'ai écrit ma phrase de récupération sur papier
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[STATIC_STYLES.primaryButton, { marginTop: 32 }, !backupConfirmed && STATIC_STYLES.primaryButtonDisabled]}
        onPress={handleBackupConfirmed}
        disabled={!backupConfirmed}
        activeOpacity={0.8}
      >
        <Text style={STATIC_STYLES.primaryButtonText}>Continuer</Text>
        <Ionicons name="arrow-forward" size={20} color="#FFF" />
      </TouchableOpacity>
    </ScrollView>
  );

  const renderSuccessStep = () => (
    <>
      <View style={STATIC_STYLES.successContainer}>
        <View style={STATIC_STYLES.successIcon}>
          <Ionicons name="checkmark" size={50} color={THEME_COLORS.success} />
        </View>

        <Text style={STATIC_STYLES.successTitle}>Identité créée !</Text>
        <Text style={STATIC_STYLES.successSubtitle}>
          Votre identité unifiée est prête.{'\n'}
          Vous pouvez maintenant commencer à utiliser BitMesh.
        </Text>

        {identitySummary && (
          <View style={STATIC_STYLES.identitySummary}>
            <Text style={STATIC_STYLES.identitySummaryTitle}>Résumé de l'identité</Text>

            <View style={STATIC_STYLES.identityItem}>
              <View style={STATIC_STYLES.identityIcon}>
                <Ionicons name="logo-bitcoin" size={18} color={THEME_COLORS.accent} />
              </View>
              <View>
                <Text style={STATIC_STYLES.identityItemLabel}>Bitcoin</Text>
                <Text style={STATIC_STYLES.identityItemValue}>
                  {identitySummary.bitcoinAddress?.slice(0, 20)}...
                </Text>
              </View>
            </View>

            <View style={STATIC_STYLES.identityItem}>
              <View style={STATIC_STYLES.identityIcon}>
                <Ionicons name="chatbubble-outline" size={18} color={THEME_COLORS.accent} />
              </View>
              <View>
                <Text style={STATIC_STYLES.identityItemLabel}>Nostr</Text>
                <Text style={STATIC_STYLES.identityItemValue}>
                  {identitySummary.nostrPubkey}
                </Text>
              </View>
            </View>

            <View style={STATIC_STYLES.identityItem}>
              <View style={STATIC_STYLES.identityIcon}>
                <Ionicons name="radio-outline" size={18} color={THEME_COLORS.accent} />
              </View>
              <View>
                <Text style={STATIC_STYLES.identityItemLabel}>MeshCore</Text>
                <Text style={STATIC_STYLES.identityItemValue}>
                  {identitySummary.meshcoreNodeId}
                </Text>
              </View>
            </View>
          </View>
        )}

        <TouchableOpacity
          style={[STATIC_STYLES.primaryButton, { marginTop: 40, width: '100%' }]}
          onPress={handleComplete}
          activeOpacity={0.8}
        >
          <Text style={STATIC_STYLES.primaryButtonText}>Commencer</Text>
          <Ionicons name="arrow-forward" size={20} color="#FFF" />
        </TouchableOpacity>
      </View>
    </>
  );

  // ============================
  // MAIN RENDER
  // ============================

  const renderContent = () => {
    switch (step) {
      case 'mode':
        return renderModeStep();
      case 'create':
        return renderCreateStep();
      case 'restore':
        return renderRestoreStep();
      case 'password':
        return renderPasswordStep();
      case 'backup':
        return renderBackupStep();
      case 'success':
        return renderSuccessStep();
      default:
        return null;
    }
  };

  const isScrollViewStep = step === 'backup';

  return (
    <View style={STATIC_STYLES.container}>
      <StatusBar style="light" />

      {step !== 'mode' && step !== 'success' && (
        <View style={STATIC_STYLES.progressContainer}>
          <View style={[STATIC_STYLES.progressBar, { width: progressWidth }]} />
        </View>
      )}

      {isScrollViewStep ? (
        renderContent()
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={STATIC_STYLES.container}
        >
          <ScrollView
            style={STATIC_STYLES.scrollContainer}
            contentContainerStyle={STATIC_STYLES.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View style={STATIC_STYLES.content}>
              {renderContent()}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
