/**
 * IdentitySetupScreen - Configuration de l'identité unifiée
 * 
 * Écran d'onboarding qui:
 * 1. Permet de créer un nouveau wallet ou restaurer depuis un backup/mnemonic
 * 2. Affiche le mnemonic pour sauvegarde (avec confirmation de copie)
 * 3. Demande un mot de passe pour le chiffrement
 * 4. Affiche un récapitulatif des 3 identités créées (Bitcoin, Nostr, MeshCore)
 * 
 * Cet écran est utilisé lors de la première utilisation ou lors de la migration
 * depuis l'ancien système.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  Clipboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import {
  Wallet,
  Key,
  Radio,
  ChevronRight,
  ChevronLeft,
  Copy,
  Check,
  Shield,
  AlertTriangle,
  Eye,
  EyeOff,
  FileText,
  Lock,
} from 'lucide-react-native';
import { StatusBar } from 'expo-status-bar';
import { useUnifiedIdentity } from '@/engine/hooks';
import { validateMnemonic } from '@/utils/bitcoin';
import Colors from '@/constants/colors';
import { useTranslation } from '@/utils/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

type SetupStep = 'mode' | 'create' | 'restore' | 'backup' | 'password' | 'confirm' | 'success';

interface IdentitySummary {
  bitcoin: { firstAddress: string };
  nostr: { npub: string };
  meshcore: { nodeId: string };
}

// ─── Composants ───────────────────────────────────────────────────────────────

export default function IdentitySetupScreen() {
  // Colors are defined as a single theme in this app
  const colors = {
    background: Colors.background,
    text: Colors.text,
    textMuted: Colors.textMuted,
    border: Colors.border,
    cardBackground: Colors.surface,
    inputBackground: Colors.surfaceLight,
  };

  // ─── Hook identity ─────────────────────────────────────────────────────────
  const {
    createWallet,
    restoreWallet,
    isLoading,
    error,
    clearError,
  } = useUnifiedIdentity();

  // ─── État local ────────────────────────────────────────────────────────────
  const [step, setStep] = useState<SetupStep>('mode');
  const [mnemonic, setMnemonic] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [mnemonicStrength, setMnemonicStrength] = useState<12 | 24>(12);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);
  const [identitySummary, setIdentitySummary] = useState<IdentitySummary | null>(null);
  const [restoreInput, setRestoreInput] = useState('');

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const goToStep = useCallback((newStep: SetupStep) => {
    setStep(newStep);
    clearError();
  }, [clearError]);

  const copyMnemonic = useCallback(() => {
    if (mnemonic) {
      Clipboard.setString(mnemonic);
      setMnemonicCopied(true);
      setTimeout(() => setMnemonicCopied(false), 2000);
    }
  }, [mnemonic]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  /**
   * Crée un nouveau wallet.
   */
  const handleCreateWallet = useCallback(async () => {
    try {
      const generatedMnemonic = await createWallet(mnemonicStrength, password);
      setMnemonic(generatedMnemonic);
      setStep('backup');
    } catch (err) {
      // L'erreur est gérée par le hook
      console.error('Failed to create wallet:', err);
    }
  }, [createWallet, mnemonicStrength, password]);

  /**
   * Restaure un wallet depuis un mnemonic.
   */
  const handleRestoreWallet = useCallback(async () => {
    const trimmedInput = restoreInput.trim().toLowerCase();
    
    if (!validateMnemonic(trimmedInput)) {
      Alert.alert('Invalid Mnemonic', 'Please enter a valid BIP39 mnemonic phrase.');
      return;
    }

    try {
      await restoreWallet(trimmedInput, password);
      setMnemonic(trimmedInput);
      // Aller directement à la confirmation
      setIdentitySummary({
        bitcoin: { firstAddress: '' }, // Sera récupéré après unlock
        nostr: { npub: '' },
        meshcore: { nodeId: '' },
      });
      setStep('success');
    } catch (err) {
      console.error('Failed to restore wallet:', err);
    }
  }, [restoreWallet, restoreInput, password]);

  /**
   * Valide le mot de passe et passe à l'étape suivante.
   */
  const handlePasswordSubmit = useCallback(() => {
    if (password.length < 8) {
      Alert.alert('Weak Password', 'Please use at least 8 characters for your password.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Password Mismatch', 'Passwords do not match.');
      return;
    }

    if (step === 'password' && mnemonic) {
      // Restauration: aller à la confirmation
      handleRestoreWallet();
    } else if (step === 'password') {
      // Création: générer le wallet
      handleCreateWallet();
    }
  }, [password, confirmPassword, step, mnemonic, handleCreateWallet, handleRestoreWallet]);

  /**
   * Confirme que l'utilisateur a sauvegardé son mnemonic.
   */
  const handleBackupConfirmed = useCallback(() => {
    if (!backupConfirmed) {
      Alert.alert('Backup Required', 'Please confirm you have written down your recovery phrase.');
      return;
    }
    setStep('success');
  }, [backupConfirmed]);

  /**
   * Termine l'onboarding et redirige vers l'app.
   */
  const handleComplete = useCallback(async () => {
    // Marquer l'onboarding comme terminé pour ne plus afficher le WelcomeModal
    await AsyncStorage.setItem('BITMESH_ONBOARDING_DONE', 'true');
    router.replace('/(tabs)');
  }, []);

  // ─── Rendu des étapes ───────────────────────────────────────────────────────

  /**
   * Étape 1: Choix du mode (créer ou restaurer).
   */
  const renderModeStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.iconContainer}>
        <Wallet size={64} color={Colors.accent} />
      </View>
      <Text style={[styles.title, { color: colors.text }]}>
        Set Up Your Identity
      </Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}
      numberOfLines={2} adjustsFontSizeToFit>
        Create a new wallet or restore from an existing backup. {'\n'}
        This will generate your Bitcoin, Nostr, and MeshCore identities.
      </Text>

      <View style={styles.buttonGroup}>
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: Colors.accent }]}
          onPress={() => goToStep('create')}
          activeOpacity={0.8}
        >
          <Key size={20} color="#fff" />
          <Text style={styles.primaryButtonText}>Create New Wallet</Text>
          <ChevronRight size={20} color="#fff" />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryButton, { borderColor: colors.border }]}
          onPress={() => goToStep('restore')}
          activeOpacity={0.8}
        >
          <FileText size={20} color={colors.text} />
          <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
            Restore from Backup
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  /**
   * Étape 2a: Configuration création (choix 12/24 mots).
   */
  const renderCreateStep = () => (
    <View style={styles.stepContainer}>
      <Text style={[styles.title, { color: colors.text }]}>
        Choose Security Level
      </Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}>
        Select the number of words for your recovery phrase.
      </Text>

      <View style={styles.optionContainer}>
        <TouchableOpacity
          style={[
            styles.optionCard,
            mnemonicStrength === 12 && styles.optionCardSelected,
            { borderColor: mnemonicStrength === 12 ? Colors.accent : colors.border },
          ]}
          onPress={() => setMnemonicStrength(12)}
        >
          <Shield size={32} color={mnemonicStrength === 12 ? Colors.accent : colors.textMuted} />
          <Text style={[styles.optionTitle, { color: colors.text }]}>12 Words</Text>
          <Text style={[styles.optionDesc, { color: colors.textMuted }]}>
            Standard security{'\n'}Recommended for most users
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.optionCard,
            mnemonicStrength === 24 && styles.optionCardSelected,
            { borderColor: mnemonicStrength === 24 ? Colors.accent : colors.border },
          ]}
          onPress={() => setMnemonicStrength(24)}
        >
          <Shield size={32} color={mnemonicStrength === 24 ? Colors.accent : colors.textMuted} />
          <Text style={[styles.optionTitle, { color: colors.text }]}>24 Words</Text>
          <Text style={[styles.optionDesc, { color: colors.textMuted }]}>
            Maximum security{'\n'}For advanced users
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: Colors.accent, marginTop: 32 }]}
        onPress={() => goToStep('password')}
      >
        <Text style={styles.primaryButtonText}>Continue</Text>
        <ChevronRight size={20} color="#fff" />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => goToStep('mode')}
      >
        <ChevronLeft size={20} color={colors.textMuted} />
        <Text style={[styles.backButtonText, { color: colors.textMuted }]}>Back</Text>
      </TouchableOpacity>
    </View>
  );

  /**
   * Étape 2b: Restauration depuis mnemonic.
   */
  const renderRestoreStep = () => (
    <View style={styles.stepContainer}>
      <Text style={[styles.title, { color: colors.text }]}>
        Restore Wallet
      </Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}>
        Enter your 12 or 24-word recovery phrase.
      </Text>

      <TextInput
        style={[
          styles.mnemonicInput,
          {
            backgroundColor: colors.inputBackground,
            borderColor: colors.border,
            color: colors.text,
          },
        ]}
        placeholder="Enter your recovery phrase..."
        placeholderTextColor={colors.textMuted}
        value={restoreInput}
        onChangeText={setRestoreInput}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: Colors.accent, marginTop: 24 }]}
        onPress={() => goToStep('password')}
        disabled={restoreInput.trim().split(/\s+/).length < 12}
      >
        <Text style={styles.primaryButtonText}>Continue</Text>
        <ChevronRight size={20} color="#fff" />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => goToStep('mode')}
      >
        <ChevronLeft size={20} color={colors.textMuted} />
        <Text style={[styles.backButtonText, { color: colors.textMuted }]}>Back</Text>
      </TouchableOpacity>
    </View>
  );

  /**
   * Étape 3: Mot de passe.
   */
  const renderPasswordStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.iconContainer}>
        <Lock size={48} color={Colors.accent} />
      </View>
      <Text style={[styles.title, { color: colors.text }]}>
        Set Password
      </Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}>
        This password will encrypt your private keys. {'\n'}
        Make sure to remember it!
      </Text>

      <View style={styles.inputContainer}>
        <TextInput
          style={[
            styles.passwordInput,
            {
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          placeholder="Enter password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
        />
        <TouchableOpacity
          style={styles.eyeButton}
          onPress={() => setShowPassword(!showPassword)}
        >
          {showPassword ? (
            <EyeOff size={20} color={colors.textMuted} />
          ) : (
            <Eye size={20} color={colors.textMuted} />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.inputContainer}>
        <TextInput
          style={[
            styles.passwordInput,
            {
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          placeholder="Confirm password"
          placeholderTextColor={colors.textMuted}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
        />
      </View>

      {password.length > 0 && password.length < 8 && (
        <Text style={styles.warningText}>
          Password must be at least 8 characters
        </Text>
      )}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          {
            backgroundColor: Colors.accent,
            marginTop: 24,
            opacity: password.length >= 8 && password === confirmPassword ? 1 : 0.5,
          },
        ]}
        onPress={handlePasswordSubmit}
        disabled={password.length < 8 || password !== confirmPassword || isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Text style={styles.primaryButtonText}>Create Wallet</Text>
            <ChevronRight size={20} color="#fff" />
          </>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => goToStep(mnemonic ? 'restore' : 'create')}
      >
        <ChevronLeft size={20} color={colors.textMuted} />
        <Text style={[styles.backButtonText, { color: colors.textMuted }]}>Back</Text>
      </TouchableOpacity>
    </View>
  );

  /**
   * Étape 4: Sauvegarde du mnemonic.
   */
  const renderBackupStep = () => (
    <ScrollView style={styles.scrollContainer} showsVerticalScrollIndicator={false}>
      <View style={styles.stepContainer}>
        <View style={styles.warningIconContainer}>
          <AlertTriangle size={48} color={Colors.orange} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>
          Write Down Your Recovery Phrase
        </Text>
        <Text style={[styles.subtitle, { color: Colors.orange, fontWeight: '600' }]}>
          This is the ONLY way to recover your wallet!
        </Text>

        <View style={[styles.mnemonicCard, { backgroundColor: colors.cardBackground }]}>
          <Text style={[styles.mnemonicText, { color: colors.text }]}>
            {mnemonic}
          </Text>
          <TouchableOpacity
            style={styles.copyButton}
            onPress={copyMnemonic}
          >
            {mnemonicCopied ? (
              <Check size={20} color={Colors.green} />
            ) : (
              <Copy size={20} color={colors.textMuted} />
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.warningBox, { backgroundColor: Colors.orange + '20' }]}>
          <AlertTriangle size={20} color={Colors.orange} />
          <Text style={[styles.warningBoxText, { color: Colors.orange }]}>
            Never share your recovery phrase with anyone. Store it in a safe place offline.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.confirmCheckbox}
          onPress={() => setBackupConfirmed(!backupConfirmed)}
        >
          <View style={[
            styles.checkbox,
            {
              borderColor: backupConfirmed ? Colors.accent : colors.border,
              backgroundColor: backupConfirmed ? Colors.accent : 'transparent',
            },
          ]}>
            {backupConfirmed && <Check size={16} color="#fff" />}
          </View>
          <Text style={[styles.checkboxLabel, { color: colors.text }]}>
            I have written down my recovery phrase
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            {
              backgroundColor: Colors.accent,
              marginTop: 24,
              opacity: backupConfirmed ? 1 : 0.5,
            },
          ]}
          onPress={handleBackupConfirmed}
          disabled={!backupConfirmed}
        >
          <Text style={styles.primaryButtonText}>Continue</Text>
          <ChevronRight size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  /**
   * Étape 5: Succès et récapitulatif.
   */
  const renderSuccessStep = () => (
    <View style={styles.stepContainer}>
      <View style={[styles.successIconContainer, { backgroundColor: Colors.green + '20' }]}>
        <Check size={64} color={Colors.green} />
      </View>
      <Text style={[styles.title, { color: colors.text }]}>
        Wallet Created!
      </Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}>
        Your unified identity is ready.
      </Text>

      <View style={[styles.identitySummary, { backgroundColor: colors.cardBackground }]}>
        <View style={styles.identityItem}>
          <Wallet size={24} color={Colors.accent} />
          <View style={styles.identityItemContent}>
            <Text style={[styles.identityItemLabel, { color: colors.textMuted }]}>
              Bitcoin
            </Text>
            <Text style={[styles.identityItemValue, { color: colors.text }]} numberOfLines={1}>
              {identitySummary?.bitcoin.firstAddress || 'Ready'}
            </Text>
          </View>
        </View>

        <View style={styles.identityDivider} />

        <View style={styles.identityItem}>
          <Key size={24} color={Colors.purple} />
          <View style={styles.identityItemContent}>
            <Text style={[styles.identityItemLabel, { color: colors.textMuted }]}>
              Nostr
            </Text>
            <Text style={[styles.identityItemValue, { color: colors.text }]} numberOfLines={1}>
              npub1...
            </Text>
          </View>
        </View>

        <View style={styles.identityDivider} />

        <View style={styles.identityItem}>
          <Radio size={24} color={Colors.orange} />
          <View style={styles.identityItemContent}>
            <Text style={[styles.identityItemLabel, { color: colors.textMuted }]}>
              MeshCore
            </Text>
            <Text style={[styles.identityItemValue, { color: colors.text }]} numberOfLines={1}>
              {identitySummary?.meshcore.nodeId || 'Ready'}
            </Text>
          </View>
        </View>
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: Colors.accent, marginTop: 32 }]}
        onPress={handleComplete}
      >
        <Text style={styles.primaryButtonText}>Get Started</Text>
        <ChevronRight size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  // ─── Rendu principal ────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      
      {/* Indicateur de progression */}
      {step !== 'mode' && step !== 'success' && (
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View 
              style={[
                styles.progressFill, 
                { 
                  width: step === 'create' || step === 'restore' ? '33%' : 
                         step === 'password' ? '66%' : 
                         step === 'backup' ? '80%' : '100%' 
                }
              ]} 
            />
          </View>
        </View>
      )}

      {/* Contenu de l'étape */}
      {step === 'mode' && renderModeStep()}
      {step === 'create' && renderCreateStep()}
      {step === 'restore' && renderRestoreStep()}
      {step === 'password' && renderPasswordStep()}
      {step === 'backup' && renderBackupStep()}
      {step === 'success' && renderSuccessStep()}

      {/* Affichage des erreurs */}
      {error && (
        <View style={[styles.errorContainer, { backgroundColor: Colors.red + '20' }]}>
          <Text style={[styles.errorText, { color: Colors.red }]}>{error}</Text>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  progressContainer: {
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  progressBar: {
    height: 4,
    backgroundColor: '#E5E5E5',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.accent,
    borderRadius: 2,
  },
  scrollContainer: {
    flex: 1,
  },
  stepContainer: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.accent + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  warningIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.orange + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  successIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  buttonGroup: {
    width: '100%',
    gap: 16,
    marginTop: 16,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    gap: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    padding: 8,
  },
  backButtonText: {
    fontSize: 14,
    marginLeft: 4,
  },
  optionContainer: {
    flexDirection: 'row',
    gap: 16,
    width: '100%',
  },
  optionCard: {
    flex: 1,
    padding: 20,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    gap: 8,
  },
  optionCardSelected: {
    backgroundColor: Colors.accent + '10',
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
  },
  optionDesc: {
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  mnemonicInput: {
    width: '100%',
    height: 120,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    lineHeight: 24,
  },
  inputContainer: {
    width: '100%',
    position: 'relative',
    marginBottom: 16,
  },
  passwordInput: {
    width: '100%',
    height: 56,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingRight: 50,
    fontSize: 16,
  },
  eyeButton: {
    position: 'absolute',
    right: 16,
    top: 18,
  },
  warningText: {
    color: Colors.orange,
    fontSize: 12,
    marginTop: -8,
    marginBottom: 16,
  },
  mnemonicCard: {
    width: '100%',
    padding: 20,
    borderRadius: 12,
    marginBottom: 16,
    position: 'relative',
  },
  mnemonicText: {
    fontSize: 18,
    lineHeight: 28,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  copyButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    padding: 8,
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    gap: 12,
    width: '100%',
  },
  warningBoxText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  confirmCheckbox: {
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxLabel: {
    fontSize: 14,
    flex: 1,
  },
  identitySummary: {
    width: '100%',
    borderRadius: 16,
    padding: 20,
    marginTop: 24,
  },
  identityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 12,
  },
  identityItemContent: {
    flex: 1,
  },
  identityItemLabel: {
    fontSize: 12,
    marginBottom: 2,
  },
  identityItemValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  identityDivider: {
    height: 1,
    backgroundColor: '#E5E5E5',
    marginVertical: 4,
  },
  errorContainer: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    right: 24,
    padding: 16,
    borderRadius: 12,
  },
  errorText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
