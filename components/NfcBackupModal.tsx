/**
 * Modal NFC Backup — Écriture et lecture de backup chiffré sur tag NFC
 * 3 étapes : bonnes pratiques → mot de passe → scan NFC
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  Alert,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { X, Nfc, AlertTriangle } from 'lucide-react-native';
import NfcManager, { NfcTech, Ndef } from 'react-native-nfc-manager';
import Colors from '@/constants/colors';

export interface NfcBackupModalProps {
  visible: boolean;
  mode: 'write' | 'read';
  onClose: () => void;
  exportWallet: (password: string) => string;
  importEncryptedWallet: (json: string, pwd: string) => void;
}

type Step = 'bestPractices' | 'password' | 'scanning';

export default function NfcBackupModal({
  visible,
  mode,
  onClose,
  exportWallet,
  importEncryptedWallet,
}: NfcBackupModalProps) {
  const [step, setStep] = useState<Step>('bestPractices');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [nfcSupported, setNfcSupported] = useState<boolean | null>(null);

  // Pulse animation for NFC icon
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    NfcManager.isSupported().then(setNfcSupported);
  }, []);

  useEffect(() => {
    if (!visible) {
      // Reset state on close
      setStep('bestPractices');
      setPassword('');
      setPasswordConfirm('');
      setError('');
      pulseLoop.current?.stop();
    }
  }, [visible]);

  useEffect(() => {
    if (step === 'scanning') {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.3, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      pulseAnim.setValue(1);
    }
  }, [step]);

  const handlePasswordNext = () => {
    setError('');
    if (password.length < 8) {
      setError('Le mot de passe doit faire au moins 8 caractères.');
      return;
    }
    if (mode === 'write' && password !== passwordConfirm) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    setStep('scanning');
    if (mode === 'write') {
      doWrite();
    } else {
      doRead();
    }
  };

  const doWrite = async () => {
    try {
      const backupJson = exportWallet(password);
      await NfcManager.start();
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const bytes = Ndef.encodeMessage([Ndef.textRecord(backupJson)]);
      await NfcManager.ndefHandler.writeNdefMessage(bytes);
      await NfcManager.cancelTechnologyRequest();
      Alert.alert('Succès', 'Backup chiffré écrit sur la carte NFC !');
      onClose();
    } catch (err: any) {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
      setStep('password');
      setError(err?.message ?? 'Erreur NFC inconnue.');
    }
  };

  const doRead = async () => {
    try {
      await NfcManager.start();
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const tag = await NfcManager.getTag();
      const payload = tag?.ndefMessage?.[0]?.payload;
      if (!payload) throw new Error('Tag NFC vide ou illisible.');
      const text = Ndef.text.decodePayload(payload as unknown as Uint8Array);
      await NfcManager.cancelTechnologyRequest();
      importEncryptedWallet(text, password);
      Alert.alert('Succès', 'Wallet importé depuis la carte NFC !');
      onClose();
    } catch (err: any) {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
      setStep('password');
      setError(err?.message ?? 'Erreur NFC inconnue.');
    }
  };

  const handleCancel = async () => {
    await NfcManager.cancelTechnologyRequest().catch(() => {});
    setStep('password');
    setError('');
  };

  const renderNotSupported = () => (
    <View style={styles.centerContent}>
      <AlertTriangle size={48} color={Colors.red} />
      <Text style={styles.notSupportedTitle}>NFC non supporté</Text>
      <Text style={styles.notSupportedDesc}>
        Ce téléphone ne dispose pas de NFC. Utilisez le backup par presse-papier.
      </Text>
      <TouchableOpacity style={styles.closeButton} onPress={onClose} activeOpacity={0.7}>
        <Text style={styles.closeButtonText}>Fermer</Text>
      </TouchableOpacity>
    </View>
  );

  const renderBestPractices = () => (
    <View>
      <View style={styles.iconRow}>
        <Nfc size={36} color={Colors.accent} />
        <Text style={styles.title}>Backup NFC</Text>
      </View>

      <View style={styles.practiceList}>
        {[
          { ok: true, text: 'Backup chiffré AES-256 — la carte seule est inutile sans mot de passe' },
          { ok: true, text: 'Stockez la carte séparément de votre téléphone' },
          { ok: true, text: 'Mot de passe ≥ 12 caractères recommandé' },
          { ok: true, text: 'Faites 2 copies NFC (primaire + secours)' },
          { ok: false, text: 'Si carte perdue + mot de passe oublié → seed irrécupérable' },
          { ok: false, text: 'Ne partagez jamais cette carte' },
        ].map((item, i) => (
          <View key={i} style={styles.practiceItem}>
            <Text style={[styles.practiceIcon, item.ok ? styles.practiceOk : styles.practiceWarn]}>
              {item.ok ? '✅' : '⚠️'}
            </Text>
            <Text style={styles.practiceText}>{item.text}</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity style={styles.primaryButton} onPress={() => setStep('password')} activeOpacity={0.7}>
        <Text style={styles.primaryButtonText}>J'ai compris →</Text>
      </TouchableOpacity>
    </View>
  );

  const renderPassword = () => (
    <View>
      <View style={styles.iconRow}>
        <Nfc size={28} color={Colors.accent} />
        <Text style={styles.title}>
          {mode === 'write' ? 'Écrire sur NFC' : 'Lire depuis NFC'}
        </Text>
      </View>

      <TextInput
        style={styles.input}
        placeholder="Mot de passe (min 8 car.)"
        placeholderTextColor={Colors.textMuted}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />

      {mode === 'write' && (
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          placeholder="Confirmer le mot de passe"
          placeholderTextColor={Colors.textMuted}
          value={passwordConfirm}
          onChangeText={setPasswordConfirm}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      {!!error && <Text style={styles.errorText}>{error}</Text>}

      <TouchableOpacity style={styles.primaryButton} onPress={handlePasswordNext} activeOpacity={0.7}>
        <Text style={styles.primaryButtonText}>
          {mode === 'write' ? 'Écrire sur la carte NFC →' : 'Lire depuis la carte NFC →'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep('bestPractices')} activeOpacity={0.7}>
        <Text style={styles.secondaryButtonText}>← Retour</Text>
      </TouchableOpacity>
    </View>
  );

  const renderScanning = () => (
    <View style={styles.centerContent}>
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <Nfc size={72} color={Colors.accent} />
      </Animated.View>
      <Text style={styles.scanTitle}>Approchez la carte NFC de votre téléphone...</Text>
      {!!error && <Text style={styles.errorText}>{error}</Text>}
      <TouchableOpacity style={styles.secondaryButton} onPress={handleCancel} activeOpacity={0.7}>
        <Text style={styles.secondaryButtonText}>Annuler</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Handle bar */}
          <View style={styles.handle} />

          {/* Close button */}
          <TouchableOpacity style={styles.xButton} onPress={onClose} activeOpacity={0.7}>
            <X size={20} color={Colors.textMuted} />
          </TouchableOpacity>

          {nfcSupported === false
            ? renderNotSupported()
            : nfcSupported === null
            ? <ActivityIndicator color={Colors.accent} style={{ marginVertical: 32 }} />
            : step === 'bestPractices'
            ? renderBestPractices()
            : step === 'password'
            ? renderPassword()
            : renderScanning()
          }
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  xButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    padding: 4,
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
    marginTop: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.text,
  },
  practiceList: {
    gap: 10,
    marginBottom: 24,
  },
  practiceItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  practiceIcon: {
    fontSize: 14,
    marginTop: 1,
  },
  practiceOk: {
    color: '#22C55E',
  },
  practiceWarn: {
    color: '#F59E0B',
  },
  practiceText: {
    flex: 1,
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  primaryButton: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: Colors.black,
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    padding: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: {
    color: Colors.textMuted,
    fontSize: 14,
  },
  input: {
    backgroundColor: Colors.surfaceLight,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 14,
    color: Colors.text,
    fontSize: 15,
  },
  errorText: {
    color: Colors.red,
    fontSize: 13,
    marginTop: 8,
  },
  centerContent: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 16,
  },
  scanTitle: {
    fontSize: 16,
    color: Colors.text,
    textAlign: 'center',
    fontWeight: '600',
  },
  notSupportedTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
    textAlign: 'center',
  },
  notSupportedDesc: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  closeButton: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    paddingHorizontal: 32,
    marginTop: 8,
  },
  closeButtonText: {
    color: Colors.text,
    fontWeight: '600',
  },
});
