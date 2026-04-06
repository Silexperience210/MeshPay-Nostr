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
  exportWallet: (password: string) => Promise<string>;
  importEncryptedWallet: (json: string, pwd: string) => Promise<void>;
}

type Step = 'bestPractices' | 'password' | 'scanning' | 'decrypting';

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
    NfcManager.isSupported().then(async (supported) => {
      setNfcSupported(supported);
      if (supported) {
        try { await NfcManager.start(); } catch { /* déjà démarré */ }
      }
    });
  }, []);

  useEffect(() => {
    if (visible) {
      // Mode lecture → pas besoin des bonnes pratiques d'écriture
      setStep(mode === 'read' ? 'password' : 'bestPractices');
    } else {
      setPassword('');
      setPasswordConfirm('');
      setError('');
      pulseLoop.current?.stop();
    }
  }, [visible, mode]);

  useEffect(() => {
    if (step === 'scanning' || step === 'decrypting') {
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
    // Afficher "chiffrement/déchiffrement" avant que PBKDF2 bloque le thread JS
    setStep('decrypting');
    setTimeout(() => {
      if (mode === 'write') doWrite();
      else doRead();
    }, 80);
  };

  const doWrite = async () => {
    try {
      // PBKDF2 — l'UI affiche déjà "Chiffrement en cours"
      const backupJson = await exportWallet(password);
      const bytes = Ndef.encodeMessage([Ndef.textRecord(backupJson)]);

      if (!bytes) throw new Error('Échec encodage NDEF');

      // Chiffrement terminé → attente de la carte NFC
      setStep('scanning');

      // Try NDEF first (pre-formatted tags)
      let written = false;
      try {
        await NfcManager.requestTechnology(NfcTech.Ndef);

        // Check tag capacity before writing
        const tag = await NfcManager.getTag();
        const maxSize = (tag as any)?.maxSize ?? (tag as any)?.ndefMessage?.[0]?.maxSize ?? 0;
        if (maxSize > 0 && bytes.length > maxSize) {
          await NfcManager.cancelTechnologyRequest();
          throw new Error(
            `Tag trop petit : ${maxSize} octets dispo, ${bytes.length} requis. Utilisez un tag NTAG216 (888 octets).`
          );
        }

        await NfcManager.ndefHandler.writeNdefMessage(bytes);
        await NfcManager.cancelTechnologyRequest();
        written = true;
      } catch (ndefErr: any) {
        await NfcManager.cancelTechnologyRequest().catch(() => {});

        // If tag is unformatted, try NdefFormatable (Android only)
        if (!written && ndefErr?.message?.toLowerCase?.()?.includes('unsupported')) {
          try {
            await NfcManager.requestTechnology(NfcTech.NdefFormatable);
            // formatNdef formats the tag and writes in one step
            await (NfcManager as any).ndefFormatableHandlerAndroid.formatNdef(bytes);
            await NfcManager.cancelTechnologyRequest();
            written = true;
          } catch (formatErr: any) {
            await NfcManager.cancelTechnologyRequest().catch(() => {});
            throw new Error(
              'Tag NFC non compatible. Essayez un tag NTAG213/215/216 vierge ou pré-formaté NDEF.'
            );
          }
        } else if (!written) {
          throw ndefErr;
        }
      }

      if (written) {
        Alert.alert('Succès', 'Backup chiffré écrit sur la carte NFC !');
        onClose();
      }
    } catch (err: any) {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
      setStep('password');
      setError(err?.message ?? 'Erreur NFC inconnue.');
    }
  };

  const doRead = async () => {
    try {
      // Attente de la carte NFC
      setStep('scanning');
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const tag = await NfcManager.getTag();
      await NfcManager.cancelTechnologyRequest();

      const payload = tag?.ndefMessage?.[0]?.payload;
      if (!payload) throw new Error('Tag NFC vide ou illisible.');
      const text = Ndef.text.decodePayload(payload as unknown as Uint8Array);

      // PBKDF2 synchrone (~10s) — afficher "Déchiffrement en cours"
      setStep('decrypting');
      await new Promise(resolve => setTimeout(resolve, 80)); // laisse React rendre

      try {
        await importEncryptedWallet(text, password);
      } catch (importErr: any) {
        setStep('password');
        setError(importErr?.message ?? 'Mot de passe incorrect ou backup invalide.');
        return;
      }

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

  const renderDecrypting = () => (
    <View style={styles.centerContent}>
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <Nfc size={72} color={Colors.yellow} />
      </Animated.View>
      <ActivityIndicator size="large" color={Colors.yellow} style={{ marginTop: 8 }} />
      <Text style={styles.scanTitle}>
        {mode === 'write' ? 'Chiffrement en cours...' : 'Déchiffrement en cours...'}
      </Text>
      <Text style={{ color: Colors.textMuted, fontSize: 13, textAlign: 'center' }}>
        PBKDF2 · AES-256{'\n'}Cela prend quelques secondes, c'est normal.
      </Text>
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
            : step === 'decrypting'
            ? renderDecrypting()
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
