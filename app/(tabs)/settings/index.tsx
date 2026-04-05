import React, { useCallback, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  TextInput,
  Animated,
  ActivityIndicator,
  Modal,
  Dimensions,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {
  Radio,
  Shield,
  Key,
  Bell,
  HardDrive,
  Info,
  ChevronRight,
  Bluetooth,
  Cpu,
  Eye,
  EyeOff,
  Trash2,
  Download,
  Plus,
  Copy,
  Check,
  Fingerprint,
  Globe,
  Server,
  Landmark,
  RefreshCw,
  ExternalLink,
  CircleCheck,
  CircleX,
  QrCode,
  Pencil,
  X,
  Star,
  Users,
  UserPlus,
  Nfc,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import Colors from '@/constants/colors';
import { useWalletSeed } from '@/providers/WalletSeedProvider';
import { useBitcoin } from '@/providers/BitcoinProvider';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import SeedQRScanner from '@/components/SeedQRScanner';
import { useGateway } from '@/providers/GatewayProvider';
import { type ConnectionMode, type AppLanguage } from '@/providers/AppSettingsProvider';
import { useTranslation } from '@/utils/i18n';
import { useMessages } from '@/providers/MessagesProvider';
import { useBle } from '@/providers/BleProvider';
import { useNostr } from '@/providers/NostrProvider';
import { type NostrRelayConfig } from '@/providers/AppSettingsProvider';
import { type RelayInfo } from '@/utils/nostr-client';
import { useTxRelay } from '@/providers/TxRelayProvider';
import * as Location from 'expo-location';
import { testMempoolConnection } from '@/utils/mempool';
import { UpdateChecker } from '@/components/UpdateChecker';
import NfcBackupModal from '@/components/NfcBackupModal';
import GatewayScanModal from '@/components/GatewayScanModal';
import { testMintConnection, formatMintUrl } from '@/utils/cashu';
import { type GatewayRelayJob } from '@/utils/gateway';

interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  hasChevron?: boolean;
  onPress?: () => void;
  destructive?: boolean;
}

function SettingRow({ icon, label, value, hasChevron = true, onPress, destructive }: SettingRowProps) {
  return (
    <TouchableOpacity
      style={styles.settingRow}
      onPress={onPress}
      activeOpacity={0.6}
    >
      <View style={styles.settingLeft}>
        {icon}
        <Text style={[styles.settingLabel, destructive && styles.settingLabelDestructive]}>{label}</Text>
      </View>
      <View style={styles.settingRight}>
        {value && <Text style={styles.settingValue} numberOfLines={1}>{value}</Text>}
        {hasChevron && <ChevronRight size={16} color={Colors.textMuted} />}
      </View>
    </TouchableOpacity>
  );
}

interface SettingToggleProps {
  icon: React.ReactNode;
  label: string;
  value: boolean;
  onToggle: (val: boolean) => void;
}

function SettingToggle({ icon, label, value, onToggle }: SettingToggleProps) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingLeft}>
        {icon}
        <Text style={styles.settingLabel}>{label}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: Colors.surfaceHighlight, true: Colors.accentDim }}
        thumbColor={value ? Colors.accent : Colors.textMuted}
      />
    </View>
  );
}

function SeedWordChip({ word, index }: { word: string; index: number }) {
  return (
    <View style={styles.seedWordChip}>
      <Text style={styles.seedWordIndex}>{index + 1}</Text>
      <Text style={styles.seedWordText}>{word}</Text>
    </View>
  );
}

function SeedManagementCard() {
  const {
    mnemonic,
    walletInfo,
    isInitialized,
    isLoading,
    isGenerating,
    isImporting,
    generateError,
    importError,
    generateNewWallet,
    importWallet,
    deleteWallet,
    getFormattedAddress,
    exportWallet,
    importEncryptedWallet,
  } = useWalletSeed();

  const [showSeed, setShowSeed] = useState<boolean>(false);
  const [showImport, setShowImport] = useState<boolean>(false);
  const [showSeedQRScanner, setShowSeedQRScanner] = useState<boolean>(false);
  const [importText, setImportText] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  // Export chiffré
  const [showExport, setShowExport] = useState(false);
  const [exportPwd, setExportPwd] = useState('');
  const [exportPwdConfirm, setExportPwdConfirm] = useState('');
  // Import chiffré
  const [showImportEncrypted, setShowImportEncrypted] = useState(false);
  const [importBackupJson, setImportBackupJson] = useState('');
  const [importBackupPwd, setImportBackupPwd] = useState('');
  // NFC backup
  const [showNfc, setShowNfc] = useState(false);
  const [nfcMode, setNfcMode] = useState<'write' | 'read'>('write');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, friction: 8, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, scaleAnim]);

  // Afficher les erreurs de génération/import
  useEffect(() => {
    if (generateError) {
      Alert.alert(
        'Erreur Génération Wallet',
        `Impossible de générer le wallet:\n${generateError.message}\n\nVérifiez les logs pour plus de détails.`,
        [{ text: 'OK', onPress: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error) }]
      );
    }
  }, [generateError]);

  useEffect(() => {
    if (importError) {
      Alert.alert(
        'Erreur Import Wallet',
        `Impossible d'importer le wallet:\n${importError.message}`,
        [{ text: 'OK', onPress: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error) }]
      );
    }
  }, [importError]);

  const handleGenerate = useCallback(async (strength: 12 | 24 = 12) => {
    if (isInitialized) {
      Alert.alert(
        'Replace Wallet?',
        'This will generate a new seed and replace your current wallet. Make sure you have backed up your current seed phrase!',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Replace',
            style: 'destructive',
            onPress: async () => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              try {
                await generateNewWallet(strength);
              } catch (e) {
                // Erreur déjà gérée dans le store via generateError
              }
            },
          },
        ]
      );
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        await generateNewWallet(strength);
      } catch (e) {
        // Erreur déjà gérée dans le store via generateError
      }
    }
  }, [isInitialized, generateNewWallet]);

  const handleImport = useCallback(async () => {
    if (!importText.trim()) {
      Alert.alert('Error', 'Please enter your seed phrase');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await importWallet(importText);
      setShowImport(false);
      setImportText('');
    } catch (e) {
      // Erreur déjà gérée dans le store via importError
    }
  }, [importText, importWallet]);

  const handleSeedQRScanned = useCallback(async (mnemonic: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      await importWallet(mnemonic);
      setShowSeedQRScanner(false);
      Alert.alert('Succès', 'Seed importée depuis SeedQR');
    } catch (e) {
      // Erreur déjà gérée dans le store
    }
  }, [importWallet]);

  const handleDelete = useCallback(() => {
    Alert.alert(
      'Delete Wallet',
      'This will permanently delete your wallet seed from this device. Make sure you have a backup!',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            deleteWallet();
            setShowSeed(false);
          },
        },
      ]
    );
  }, [deleteWallet]);

  const handleCopyAddress = useCallback(() => {
    if (walletInfo?.firstReceiveAddress) {
      Clipboard.setStringAsync(walletInfo.firstReceiveAddress).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [walletInfo]);

  const handleToggleSeed = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowSeed(prev => !prev);
  }, []);

  const handleExportEncrypted = useCallback(async () => {
    if (exportPwd.length < 8) {
      Alert.alert('Erreur', 'Le mot de passe doit faire au moins 8 caractères.');
      return;
    }
    if (exportPwd !== exportPwdConfirm) {
      Alert.alert('Erreur', 'Les mots de passe ne correspondent pas.');
      return;
    }
    try {
      const json = await exportWallet(exportPwd);
      Clipboard.setStringAsync(json).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Backup copié !', 'Le backup chiffré a été copié dans le presse-papier. Collez-le dans un endroit sûr (notes, gestionnaire de mots de passe…).');
      setShowExport(false);
      setExportPwd('');
      setExportPwdConfirm('');
    } catch (err: any) {
      Alert.alert('Erreur export', err.message);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [exportPwd, exportPwdConfirm, exportWallet]);

  const handleImportEncrypted = useCallback(async () => {
    if (!importBackupJson.trim()) {
      Alert.alert('Erreur', 'Collez le JSON de backup chiffré.');
      return;
    }
    if (!importBackupPwd) {
      Alert.alert('Erreur', 'Entrez le mot de passe de déchiffrement.');
      return;
    }
    try {
      await importEncryptedWallet(importBackupJson.trim(), importBackupPwd);
      setShowImportEncrypted(false);
      setImportBackupJson('');
      setImportBackupPwd('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Import échoué', err.message);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [importBackupJson, importBackupPwd, importEncryptedWallet]);

  if (isLoading) {
    return (
      <View style={styles.seedCard}>
        <View style={styles.seedLoadingContainer}>
          <ActivityIndicator color={Colors.accent} size="small" />
          <Text style={styles.seedLoadingText}>Loading wallet...</Text>
        </View>
      </View>
    );
  }

  const words = mnemonic ? mnemonic.split(' ') : [];

  return (
    <Animated.View style={[styles.seedCard, { opacity: fadeAnim, transform: [{ scale: scaleAnim }] }]}>
      <View style={styles.seedCardHeader}>
        <View style={styles.seedCardTitleRow}>
          <Fingerprint size={18} color={Colors.accent} />
          <Text style={styles.seedCardTitle}>Wallet Seed</Text>
        </View>
        <View style={[
          styles.seedStatusBadge,
          isInitialized ? styles.seedStatusActive : styles.seedStatusInactive,
        ]}>
          <Text style={[
            styles.seedStatusText,
            isInitialized ? styles.seedStatusTextActive : styles.seedStatusTextInactive,
          ]}>
            {isInitialized ? 'ACTIVE' : 'NO SEED'}
          </Text>
        </View>
      </View>

      {isInitialized && walletInfo ? (
        <>
          <View style={styles.walletInfoRow}>
            <Text style={styles.walletInfoLabel}>Address</Text>
            <TouchableOpacity
              style={styles.addressCopyRow}
              onPress={handleCopyAddress}
              activeOpacity={0.7}
            >
              <Text style={styles.walletInfoValue}>{getFormattedAddress()}</Text>
              {copied ? (
                <Check size={14} color={Colors.green} />
              ) : (
                <Copy size={14} color={Colors.textMuted} />
              )}
            </TouchableOpacity>
          </View>
          <View style={styles.walletInfoRow}>
            <Text style={styles.walletInfoLabel}>Fingerprint</Text>
            <Text style={styles.walletInfoValue}>{walletInfo.fingerprint}</Text>
          </View>
          <View style={styles.walletInfoRow}>
            <Text style={styles.walletInfoLabel}>Type</Text>
            <Text style={styles.walletInfoValue}>BIP84 Native SegWit</Text>
          </View>
          <View style={styles.walletInfoRow}>
            <Text style={styles.walletInfoLabel}>Words</Text>
            <Text style={styles.walletInfoValue}>{words.length} words</Text>
          </View>

          <TouchableOpacity
            style={styles.showSeedButton}
            onPress={handleToggleSeed}
            activeOpacity={0.7}
          >
            {showSeed ? (
              <EyeOff size={16} color={Colors.accent} />
            ) : (
              <Eye size={16} color={Colors.accent} />
            )}
            <Text style={styles.showSeedText}>
              {showSeed ? 'Hide Seed Phrase' : 'Reveal Seed Phrase'}
            </Text>
          </TouchableOpacity>

          {showSeed && (
            <View style={styles.seedWordsContainer}>
              <View style={styles.seedWarningBanner}>
                <Shield size={14} color={Colors.yellow} />
                <Text style={styles.seedWarningText}>
                  Never share your seed phrase. Anyone with it can access your funds.
                </Text>
              </View>
              <View style={styles.seedWordsGrid}>
                {words.map((word, i) => (
                  <SeedWordChip key={`${i}-${word}`} word={word} index={i} />
                ))}
              </View>
            </View>
          )}

          <View style={styles.seedActionsRow}>
            <TouchableOpacity
              style={styles.seedActionSmall}
              onPress={() => handleGenerate(12)}
              activeOpacity={0.7}
            >
              {isGenerating ? (
                <ActivityIndicator color={Colors.accent} size="small" />
              ) : (
                <>
                  <Plus size={14} color={Colors.accent} />
                  <Text style={styles.seedActionSmallText}>New 12w</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.seedActionSmall}
              onPress={() => handleGenerate(24)}
              activeOpacity={0.7}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <ActivityIndicator color={Colors.accent} size="small" />
              ) : (
                <>
                  <Plus size={14} color={Colors.accent} />
                  <Text style={styles.seedActionSmallText}>New 24w</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.seedActionSmall, styles.seedActionDestructive]}
              onPress={handleDelete}
              activeOpacity={0.7}
            >
              <Trash2 size={14} color={Colors.red} />
              <Text style={styles.seedActionDestructiveText}>Delete</Text>
            </TouchableOpacity>
          </View>

          {/* ── Export backup chiffré ── */}
          <TouchableOpacity
            style={styles.importToggle}
            onPress={() => setShowExport(prev => !prev)}
            activeOpacity={0.7}
          >
            <HardDrive size={16} color={Colors.textSecondary} />
            <Text style={styles.importToggleText}>
              {showExport ? 'Annuler export' : 'Exporter backup chiffré'}
            </Text>
          </TouchableOpacity>

          {showExport && (
            <View style={styles.importContainer}>
              <TextInput
                style={styles.importInput}
                placeholder="Mot de passe (min 8 car.)"
                placeholderTextColor={Colors.textMuted}
                value={exportPwd}
                onChangeText={setExportPwd}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={[styles.importInput, { marginTop: 8 }]}
                placeholder="Confirmer le mot de passe"
                placeholderTextColor={Colors.textMuted}
                value={exportPwdConfirm}
                onChangeText={setExportPwdConfirm}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.importButton}
                onPress={handleExportEncrypted}
                activeOpacity={0.7}
              >
                <Text style={styles.importButtonText}>Copier le backup chiffré</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── NFC ── */}
          <TouchableOpacity
            style={styles.importToggle}
            onPress={() => { setNfcMode('write'); setShowNfc(true); }}
            activeOpacity={0.7}
          >
            <Nfc size={16} color={Colors.cyan} />
            <Text style={[styles.importToggleText, { color: Colors.cyan }]}>Écrire backup sur carte NFC</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.importToggle}
            onPress={() => { setNfcMode('read'); setShowNfc(true); }}
            activeOpacity={0.7}
          >
            <Nfc size={16} color={Colors.cyan} />
            <Text style={[styles.importToggleText, { color: Colors.cyan }]}>Importer backup depuis NFC</Text>
          </TouchableOpacity>

          <NfcBackupModal
            visible={showNfc}
            mode={nfcMode}
            onClose={() => setShowNfc(false)}
            exportWallet={exportWallet}
            importEncryptedWallet={importEncryptedWallet}
          />
        </>
      ) : (
        <>
          <Text style={styles.noSeedDesc}>
            Generate a new BIP39 seed phrase or import an existing one to create your Bitcoin wallet.
          </Text>

          <View style={styles.generateButtons}>
            <TouchableOpacity
              style={styles.generateButton}
              onPress={() => handleGenerate(12)}
              activeOpacity={0.7}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <ActivityIndicator color={Colors.black} size="small" />
              ) : (
                <>
                  <Key size={18} color={Colors.black} />
                  <Text style={styles.generateButtonText}>Generate 12 Words</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.generateButton24}
              onPress={() => handleGenerate(24)}
              activeOpacity={0.7}
              disabled={isGenerating}
            >
              <Key size={18} color={Colors.accent} />
              <Text style={styles.generateButton24Text}>Generate 24 Words</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.importToggle}
            onPress={() => setShowImport(prev => !prev)}
            activeOpacity={0.7}
          >
            <Download size={16} color={Colors.textSecondary} />
            <Text style={styles.importToggleText}>
              {showImport ? 'Cancel Import' : 'Import Existing Seed'}
            </Text>
          </TouchableOpacity>

          {showImport && (
            <View style={styles.importContainer}>
              <TextInput
                style={styles.importInput}
                placeholder="Enter your 12 or 24 word seed phrase..."
                placeholderTextColor={Colors.textMuted}
                value={importText}
                onChangeText={setImportText}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                testID="import-seed-input"
              />

              {/* Boutons d'import alternatifs : SeedQR + NFC */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <TouchableOpacity
                  style={[styles.scanQRButton, { flex: 1 }]}
                  onPress={() => setShowSeedQRScanner(true)}
                  activeOpacity={0.7}
                >
                  <QrCode size={18} color={Colors.background} />
                  <Text style={styles.scanQRButtonText}>Scan SeedQR</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.scanQRButton, { flex: 1, backgroundColor: Colors.cyan }]}
                  onPress={() => { setNfcMode('read'); setShowNfc(true); }}
                  activeOpacity={0.7}
                >
                  <Nfc size={18} color={Colors.background} />
                  <Text style={styles.scanQRButtonText}>Import NFC</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.importButton}
                onPress={handleImport}
                activeOpacity={0.7}
                disabled={isImporting}
              >
                {isImporting ? (
                  <ActivityIndicator color={Colors.black} size="small" />
                ) : (
                  <Text style={styles.importButtonText}>Import Wallet</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* ── Import backup chiffré ── */}
          <TouchableOpacity
            style={styles.importToggle}
            onPress={() => setShowImportEncrypted(prev => !prev)}
            activeOpacity={0.7}
          >
            <Shield size={16} color={Colors.textSecondary} />
            <Text style={styles.importToggleText}>
              {showImportEncrypted ? 'Annuler import chiffré' : 'Importer backup chiffré'}
            </Text>
          </TouchableOpacity>

          {showImportEncrypted && (
            <View style={styles.importContainer}>
              <TextInput
                style={styles.importInput}
                placeholder="Coller le JSON de backup chiffré..."
                placeholderTextColor={Colors.textMuted}
                value={importBackupJson}
                onChangeText={setImportBackupJson}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={[styles.importInput, { marginTop: 8 }]}
                placeholder="Mot de passe de déchiffrement"
                placeholderTextColor={Colors.textMuted}
                value={importBackupPwd}
                onChangeText={setImportBackupPwd}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.importButton}
                onPress={handleImportEncrypted}
                activeOpacity={0.7}
                disabled={isImporting}
              >
                {isImporting ? (
                  <ActivityIndicator color={Colors.black} size="small" />
                ) : (
                  <Text style={styles.importButtonText}>Importer backup chiffré</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </Animated.View>
  );
}

function EndpointConfigCard() {
  const { settings, updateSettings, getMempoolUrl, getCashuMintUrl } = useAppSettings();
  const [mempoolInput, setMempoolInput] = useState<string>(settings.customMempoolUrl);
  const [cashuInput, setCashuInput] = useState<string>(settings.customCashuMint);
  const [testingMempool, setTestingMempool] = useState<boolean>(false);
  const [testingCashu, setTestingCashu] = useState<boolean>(false);
  const [mempoolStatus, setMempoolStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [cashuStatus, setCashuStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [cashuMintName, setCashuMintName] = useState<string>('');

  useEffect(() => {
    setMempoolInput(settings.customMempoolUrl);
    setCashuInput(settings.customCashuMint);
  }, [settings.customMempoolUrl, settings.customCashuMint]);

  const handleTestMempool = useCallback(async () => {
    const urlToTest = settings.useCustomMempool && mempoolInput.trim()
      ? mempoolInput.trim().replace(/\/$/, '')
      : settings.mempoolUrl;
    setTestingMempool(true);
    setMempoolStatus('idle');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const ok = await testMempoolConnection(urlToTest);
      setMempoolStatus(ok ? 'ok' : 'fail');
      Haptics.notificationAsync(
        ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
      );
    } catch {
      setMempoolStatus('fail');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setTestingMempool(false);
    }
  }, [settings, mempoolInput]);

  const handleTestCashu = useCallback(async () => {
    const urlToTest = settings.useCustomCashuMint && cashuInput.trim()
      ? formatMintUrl(cashuInput.trim())
      : settings.defaultCashuMint;
    setTestingCashu(true);
    setCashuStatus('idle');
    setCashuMintName('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await testMintConnection(urlToTest);
      setCashuStatus(result.ok ? 'ok' : 'fail');
      if (result.ok && result.name) setCashuMintName(result.name);
      Haptics.notificationAsync(
        result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
      );
    } catch {
      setCashuStatus('fail');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setTestingCashu(false);
    }
  }, [settings, cashuInput]);

  const handleSaveMempoolCustom = useCallback(() => {
    updateSettings({ customMempoolUrl: mempoolInput.trim().replace(/\/$/, '') });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('Saved', 'Custom Mempool URL saved');
  }, [mempoolInput, updateSettings]);

  const handleSaveCashuCustom = useCallback(() => {
    updateSettings({ customCashuMint: formatMintUrl(cashuInput.trim()) });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('Saved', 'Custom Cashu Mint URL saved');
  }, [cashuInput, updateSettings]);

  return (
    <>
      <View style={styles.endpointCard}>
        <View style={styles.endpointHeader}>
          <Globe size={16} color={Colors.accent} />
          <Text style={styles.endpointTitle}>Mempool API</Text>
          {mempoolStatus === 'ok' && <CircleCheck size={14} color={Colors.green} />}
          {mempoolStatus === 'fail' && <CircleX size={14} color={Colors.red} />}
        </View>

        <View style={styles.endpointRow}>
          <Text style={styles.endpointLabel}>Default</Text>
          <Text style={styles.endpointUrl}>{settings.mempoolUrl}</Text>
        </View>

        <View style={styles.endpointRow}>
          <Text style={styles.endpointLabel}>Active</Text>
          <Text style={[styles.endpointUrl, styles.endpointUrlActive]}>{getMempoolUrl()}</Text>
        </View>

        <SettingToggle
          icon={<Server size={16} color={Colors.blue} />}
          label="Use Custom Endpoint"
          value={settings.useCustomMempool}
          onToggle={(val) => updateSettings({ useCustomMempool: val })}
        />

        {settings.useCustomMempool && (
          <View style={styles.customEndpointContainer}>
            <TextInput
              style={styles.endpointInput}
              placeholder="https://your-mempool-instance.com"
              placeholderTextColor={Colors.textMuted}
              value={mempoolInput}
              onChangeText={setMempoolInput}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              testID="custom-mempool-input"
            />
            <TouchableOpacity
              style={styles.saveEndpointBtn}
              onPress={handleSaveMempoolCustom}
              activeOpacity={0.7}
            >
              <Check size={16} color={Colors.accent} />
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={styles.testButton}
          onPress={handleTestMempool}
          activeOpacity={0.7}
          disabled={testingMempool}
        >
          {testingMempool ? (
            <ActivityIndicator color={Colors.accent} size="small" />
          ) : (
            <>
              <RefreshCw size={14} color={Colors.accent} />
              <Text style={styles.testButtonText}>Test Connection</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.endpointCard}>
        <View style={styles.endpointHeader}>
          <Landmark size={16} color={Colors.cyan} />
          <Text style={styles.endpointTitle}>Cashu Mint</Text>
          {cashuStatus === 'ok' && <CircleCheck size={14} color={Colors.green} />}
          {cashuStatus === 'fail' && <CircleX size={14} color={Colors.red} />}
        </View>

        <View style={styles.endpointRow}>
          <Text style={styles.endpointLabel}>Default</Text>
          <Text style={styles.endpointUrl} numberOfLines={1}>{settings.defaultCashuMint}</Text>
        </View>

        <View style={styles.endpointRow}>
          <Text style={styles.endpointLabel}>Active</Text>
          <Text style={[styles.endpointUrl, styles.endpointUrlCashu]} numberOfLines={1}>{getCashuMintUrl()}</Text>
        </View>

        {cashuMintName !== '' && (
          <View style={styles.endpointRow}>
            <Text style={styles.endpointLabel}>Name</Text>
            <Text style={styles.endpointUrlCashu}>{cashuMintName}</Text>
          </View>
        )}

        <SettingToggle
          icon={<Server size={16} color={Colors.cyan} />}
          label="Use Custom Mint"
          value={settings.useCustomCashuMint}
          onToggle={(val) => updateSettings({ useCustomCashuMint: val })}
        />

        {settings.useCustomCashuMint && (
          <View style={styles.customEndpointContainer}>
            <TextInput
              style={styles.endpointInput}
              placeholder="https://your-mint.com"
              placeholderTextColor={Colors.textMuted}
              value={cashuInput}
              onChangeText={setCashuInput}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              testID="custom-cashu-input"
            />
            <TouchableOpacity
              style={styles.saveEndpointBtn}
              onPress={handleSaveCashuCustom}
              activeOpacity={0.7}
            >
              <Check size={16} color={Colors.cyan} />
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={[styles.testButton, styles.testButtonCashu]}
          onPress={handleTestCashu}
          activeOpacity={0.7}
          disabled={testingCashu}
        >
          {testingCashu ? (
            <ActivityIndicator color={Colors.cyan} size="small" />
          ) : (
            <>
              <RefreshCw size={14} color={Colors.cyan} />
              <Text style={[styles.testButtonText, styles.testButtonTextCashu]}>Test Connection</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </>
  );
}

function GatewayModeCard() {
  const {
    gatewayState,
    settings: gwSettings,
    updateSettings: updateGwSettings,
    activateGateway: activateGw,
    deactivateGateway: deactivateGw,
    toggleService,
    getUptime,
    isActivating,
    isDeactivating,
  } = useGateway();

  const [showRelayLog, setShowRelayLog] = useState<boolean>(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, [fadeAnim]);

  useEffect(() => {
    if (gatewayState.isActive) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 0, duration: 1200, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(0);
    }
  }, [gatewayState.isActive, pulseAnim]);

  const handleToggleMode = useCallback(() => {
    if (gatewayState.isActive) {
      Alert.alert(
        'Deactivate Gateway',
        'This will stop relaying transactions. Continue?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Deactivate',
            style: 'destructive',
            onPress: () => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              deactivateGw();
            },
          },
        ]
      );
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      activateGw();
    }
  }, [gatewayState.isActive, activateGw, deactivateGw]);

  const pulseOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 1],
  });

  const statusColor = gatewayState.isActive ? Colors.green : Colors.textMuted;
  const stats = gatewayState.stats;

  return (
    <Animated.View style={[styles.gatewayCard, { opacity: fadeAnim }]}>
      <View style={styles.gatewayHeader}>
        <View style={styles.gatewayTitleRow}>
          <Server size={18} color={gatewayState.isActive ? Colors.green : Colors.purple} />
          <Text style={styles.gatewayTitle}>Gateway Mode</Text>
        </View>
        <View style={styles.gatewayStatusRow}>
          {gatewayState.isActive && (
            <Animated.View style={[styles.gatewayPulseDot, { opacity: pulseOpacity, backgroundColor: Colors.green }]} />
          )}
          <View style={[
            styles.gatewayModeBadge,
            gatewayState.isActive ? styles.gatewayModeBadgeActive : styles.gatewayModeBadgeInactive,
          ]}>
            <Text style={[
              styles.gatewayModeText,
              gatewayState.isActive ? styles.gatewayModeTextActive : styles.gatewayModeTextInactive,
            ]}>
              {gatewayState.isActive ? 'GATEWAY' : 'CLIENT'}
            </Text>
          </View>
        </View>
      </View>

      <Text style={styles.gatewayDesc}>
        {gatewayState.isActive
          ? 'Relaying BTC transactions, Cashu tokens, and chunked messages for mesh peers.'
          : 'Activate to relay LoRa messages to Mempool and Cashu mints.'}
      </Text>

      <TouchableOpacity
        style={[
          styles.gatewayToggleBtn,
          gatewayState.isActive ? styles.gatewayToggleBtnActive : styles.gatewayToggleBtnInactive,
        ]}
        onPress={handleToggleMode}
        activeOpacity={0.7}
        disabled={isActivating || isDeactivating}
        testID="gateway-toggle-button"
      >
        {isActivating || isDeactivating ? (
          <ActivityIndicator color={gatewayState.isActive ? Colors.red : Colors.green} size="small" />
        ) : (
          <>
            <Server size={16} color={gatewayState.isActive ? Colors.red : Colors.green} />
            <Text style={[
              styles.gatewayToggleText,
              gatewayState.isActive ? styles.gatewayToggleTextDeactivate : styles.gatewayToggleTextActivate,
            ]}>
              {gatewayState.isActive ? 'Deactivate Gateway' : 'Activate Gateway'}
            </Text>
          </>
        )}
      </TouchableOpacity>

      {gatewayState.isActive && (
        <View style={styles.gatewayStatsGrid}>
          <View style={styles.gatewayStatItem}>
            <Text style={styles.gatewayStatValue}>{stats.txRelayed}</Text>
            <Text style={styles.gatewayStatLabel}>TX Relayed</Text>
          </View>
          <View style={styles.gatewayStatItem}>
            <Text style={[styles.gatewayStatValue, { color: Colors.cyan }]}>{stats.cashuRelayed}</Text>
            <Text style={styles.gatewayStatLabel}>Cashu</Text>
          </View>
          <View style={styles.gatewayStatItem}>
            <Text style={styles.gatewayStatValue}>{stats.chunksProcessed}</Text>
            <Text style={styles.gatewayStatLabel}>Chunks</Text>
          </View>
          <View style={styles.gatewayStatItem}>
            <Text style={[styles.gatewayStatValue, { color: Colors.green }]}>{stats.peersServed}</Text>
            <Text style={styles.gatewayStatLabel}>Peers</Text>
          </View>
        </View>
      )}

      <View style={styles.gatewayServicesSection}>
        <Text style={styles.gatewayServicesTitle}>Relay Services</Text>
        <SettingToggle
          icon={<Globe size={16} color={Colors.accent} />}
          label="Mempool Broadcast"
          value={gwSettings.services.mempool}
          onToggle={(val) => toggleService('mempool', val)}
        />
        <SettingToggle
          icon={<Landmark size={16} color={Colors.cyan} />}
          label="Cashu Relay"
          value={gwSettings.services.cashu}
          onToggle={(val) => toggleService('cashu', val)}
        />
        <SettingToggle
          icon={<Radio size={16} color={Colors.green} />}
          label="LoRa Forwarding"
          value={gwSettings.services.lora}
          onToggle={(val) => toggleService('lora', val)}
        />
      </View>

      <TouchableOpacity
        style={styles.relayLogToggle}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setShowRelayLog((prev) => !prev);
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.relayLogToggleText}>
          {showRelayLog ? 'Hide Relay Log' : 'Show Relay Log'}
        </Text>
      </TouchableOpacity>

      {showRelayLog && (
        <View style={styles.relayLogContainer}>
          {gatewayState.relayJobs.length === 0 ? (
            <Text style={{ color: Colors.textMuted, fontSize: 12, textAlign: 'center', padding: 12 }}>
              Aucune activité pour l'instant
            </Text>
          ) : (
            [...gatewayState.relayJobs].reverse().slice(0, 20).map((entry) => (
              <RelayLogItem key={entry.id} entry={entry} />
            ))
          )}
        </View>
      )}
    </Animated.View>
  );
}

function RelayLogItem({ entry }: { entry: GatewayRelayJob }) {
  const typeColorMap: Record<string, string> = {
    tx_broadcast: Colors.accent,
    cashu_relay: Colors.cyan,
    cashu_redeem: Colors.cyan,
    chunk_reassembly: Colors.blue,
    payment_forward: Colors.purple,
  };
  const color = typeColorMap[entry.type] ?? Colors.textMuted;
  const statusIcon = entry.status === 'completed'
    ? <CircleCheck size={12} color={Colors.green} />
    : entry.status === 'failed'
    ? <CircleX size={12} color={Colors.red} />
    : <RefreshCw size={12} color={Colors.yellow} />;
  const elapsed = Date.now() - entry.timestamp;
  const minutes = Math.floor(elapsed / 60000);
  const timeLabel = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  const detail = entry.result || entry.error || entry.payload?.slice(0, 60) || '—';
  const bytesRelayed = entry.payload?.length ?? 0;

  return (
    <View style={styles.relayLogItem}>
      <View style={[styles.relayLogDot, { backgroundColor: color }]} />
      <View style={styles.relayLogContent}>
        <View style={styles.relayLogTop}>
          <Text style={[styles.relayLogType, { color }]}>
            {entry.type.replace(/_/g, ' ').toUpperCase()}
          </Text>
          {statusIcon}
          <Text style={styles.relayLogTime}>{timeLabel}</Text>
        </View>
        <Text style={styles.relayLogDetail} numberOfLines={2}>{detail}</Text>
        <Text style={styles.relayLogMeta}>
          From: {entry.sourceNodeId} · {bytesRelayed}B
        </Text>
      </View>
    </View>
  );
}

function ConnectionModeSelector() {
  const { settings, updateSettings } = useAppSettings();

  const modes: { key: ConnectionMode; label: string; desc: string; color: string; icon: React.ReactNode }[] = [
    {
      key: 'internet',
      label: 'Internet',
      desc: 'No LoRa needed. Route via Nostr relays.',
      color: Colors.blue,
      icon: <Globe size={18} color={Colors.blue} />,
    },
    {
      key: 'lora',
      label: 'LoRa Mesh',
      desc: 'Direct LoRa radio. Fully off-grid.',
      color: Colors.green,
      icon: <Radio size={18} color={Colors.green} />,
    },
    {
      key: 'bridge',
      label: 'Bridge',
      desc: 'Both LoRa and Internet for max reach.',
      color: Colors.cyan,
      icon: <Server size={18} color={Colors.cyan} />,
    },
  ];

  const handleSelect = useCallback((mode: ConnectionMode) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    updateSettings({ connectionMode: mode });
  }, [updateSettings]);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Connection Mode</Text>
      <View style={styles.connectionModeContainer}>
        {modes.map((mode) => {
          const isActive = settings.connectionMode === mode.key;
          return (
            <TouchableOpacity
              key={mode.key}
              style={[
                styles.connectionModeCard,
                isActive && { borderColor: mode.color, backgroundColor: mode.color + '10' },
              ]}
              onPress={() => handleSelect(mode.key)}
              activeOpacity={0.7}
            >
              <View style={[
                styles.connectionModeIconWrap,
                { backgroundColor: isActive ? mode.color + '20' : Colors.surfaceLight },
              ]}>
                {mode.icon}
              </View>
              <Text style={[
                styles.connectionModeLabel,
                isActive && { color: mode.color },
              ]}>
                {mode.label}
              </Text>
              <Text style={styles.connectionModeDesc} numberOfLines={2}>
                {mode.desc}
              </Text>
              {isActive && (
                <View style={[styles.connectionModeActiveDot, { backgroundColor: mode.color }]} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function NetworkSettingsCard() {
  const { settings, updateSettings } = useAppSettings();

  const handleNetworkChange = useCallback(() => {
    Alert.alert(
      'Bitcoin Network',
      'Select network',
      [
        {
          text: 'Mainnet',
          onPress: () => {
            updateSettings({ bitcoinNetwork: 'mainnet' });
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
        {
          text: 'Testnet',
          onPress: () => {
            updateSettings({ bitcoinNetwork: 'testnet' });
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  }, [updateSettings]);

  const handleCurrencyChange = useCallback(() => {
    Alert.alert(
      'Fiat Currency',
      'Select your preferred currency',
      [
        { text: 'EUR', onPress: () => updateSettings({ fiatCurrency: 'EUR' }) },
        { text: 'USD', onPress: () => updateSettings({ fiatCurrency: 'USD' }) },
        { text: 'GBP', onPress: () => updateSettings({ fiatCurrency: 'GBP' }) },
        { text: 'CHF', onPress: () => updateSettings({ fiatCurrency: 'CHF' }) },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  }, [updateSettings]);

  return (
    <View style={styles.sectionCard}>
      <SettingRow
        icon={<Globe size={18} color={Colors.accent} />}
        label="Network"
        value={settings.bitcoinNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}
        onPress={handleNetworkChange}
      />
      <SettingRow
        icon={<ExternalLink size={18} color={Colors.blue} />}
        label="Fiat Currency"
        value={settings.fiatCurrency}
        onPress={handleCurrencyChange}
      />
    </View>
  );
}

function NostrSettingsCard() {
  const { npub, relays, isConnected, isConnecting, reconnectRelays } = useNostr();
  const { gatewayStats, isGateway, pendingRelays } = useTxRelay();
  const { settings, updateSettings } = useAppSettings();
  const [copiedNpub, setCopiedNpub] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [customRelayInput, setCustomRelayInput] = useState('');
  const [addingRelay, setAddingRelay] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);

  const handleCopyNpub = useCallback(async () => {
    if (!npub) return;
    await Clipboard.setStringAsync(npub);
    setCopiedNpub(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setCopiedNpub(false), 2000);
  }, [npub]);

  const handleToggleLocation = useCallback(async (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    updateSettings({ shareLocation: val });
    if (!val) return;
    setLocationLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission GPS', 'Accès à la localisation refusé.');
        updateSettings({ shareLocation: false });
      }
    } catch {
      updateSettings({ shareLocation: false });
    } finally {
      setLocationLoading(false);
    }
  }, [updateSettings]);

  /** Active/désactive un relay et reconnecte */
  const handleToggleRelay = useCallback((url: string, enabled: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const updated = settings.nostrRelays.map(r =>
      r.url === url ? { ...r, enabled } : r
    );
    updateSettings({ nostrRelays: updated });
    // Reconnexion différée pour laisser le state se propager
    setTimeout(() => reconnectRelays(), 300);
  }, [settings.nostrRelays, updateSettings, reconnectRelays]);

  /** Supprime un relay custom */
  const handleDeleteRelay = useCallback((url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const updated = settings.nostrRelays.filter(r => r.url !== url);
    updateSettings({ nostrRelays: updated });
    setTimeout(() => reconnectRelays(), 300);
  }, [settings.nostrRelays, updateSettings, reconnectRelays]);

  /** Ajoute un relay custom */
  const handleAddRelay = useCallback(async () => {
    const raw = customRelayInput.trim().toLowerCase();
    if (!raw) return;
    const url = raw.startsWith('wss://') || raw.startsWith('ws://')
      ? raw
      : `wss://${raw}`;

    if (settings.nostrRelays.some(r => r.url === url)) {
      Alert.alert('Relay existant', 'Ce relay est déjà dans la liste.');
      return;
    }
    if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
      Alert.alert('URL invalide', 'L\'URL doit commencer par wss:// ou ws://');
      return;
    }

    setAddingRelay(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const newRelay: NostrRelayConfig = { url, enabled: true, custom: true };
    const updated = [...settings.nostrRelays, newRelay];
    updateSettings({ nostrRelays: updated });
    setCustomRelayInput('');
    setShowAddInput(false);
    setTimeout(() => reconnectRelays(), 300);
    setAddingRelay(false);
  }, [customRelayInput, settings.nostrRelays, updateSettings, reconnectRelays]);

  const statusColor = isConnecting ? Colors.yellow : isConnected ? Colors.green : Colors.red;
  const statusLabel = isConnecting ? 'Connexion...' : isConnected ? 'Connecté' : 'Déconnecté';
  const pendingCount = pendingRelays.filter(r => r.status === 'pending').length;

  /** Statut de connexion pour un URL donné (depuis l'état live des relays) */
  const getLiveStatus = (url: string): RelayInfo | undefined =>
    relays.find(r => r.url === url);

  const getRelayColor = (status: string) => {
    if (status === 'connected') return Colors.green;
    if (status === 'connecting') return Colors.yellow;
    return Colors.red;
  };

  return (
    <View style={styles.sectionCard}>
      {/* Statut global */}
      <View style={styles.settingRow}>
        <View style={styles.settingLeft}>
          <Globe size={18} color={statusColor} />
          <Text style={[styles.settingLabel, { marginLeft: 10 }]}>Nostr</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: statusColor }} />
          <Text style={[styles.settingValue, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      {/* npub copiable */}
      {npub && (
        <TouchableOpacity style={styles.settingRow} onPress={handleCopyNpub} activeOpacity={0.6}>
          <View style={styles.settingLeft}>
            <Key size={18} color={Colors.purple} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.settingLabel}>Clé publique (npub)</Text>
              <Text style={[styles.settingValue, { fontSize: 10, fontFamily: 'monospace' }]} numberOfLines={1}>
                {npub.slice(0, 12)}…{npub.slice(-6)}
              </Text>
            </View>
          </View>
          {copiedNpub
            ? <Check size={16} color={Colors.green} />
            : <Copy size={16} color={Colors.textMuted} />}
        </TouchableOpacity>
      )}

      {/* Liste relays avec toggles */}
      <View style={nostrStyles.relayList}>
        <View style={nostrStyles.relayListHeader}>
          <Text style={nostrStyles.relayListTitle}>Relays</Text>
          <TouchableOpacity
            style={nostrStyles.addRelayBtn}
            onPress={() => setShowAddInput(v => !v)}
            activeOpacity={0.7}
          >
            <Plus size={13} color={Colors.accent} />
            <Text style={nostrStyles.addRelayBtnText}>Ajouter</Text>
          </TouchableOpacity>
        </View>

        {settings.nostrRelays.map(relay => {
          const live = getLiveStatus(relay.url);
          const dotColor = !relay.enabled
            ? Colors.textMuted
            : live ? getRelayColor(live.status) : Colors.textMuted;
          const statusText = !relay.enabled
            ? 'désactivé'
            : live?.status ?? '—';

          return (
            <View key={relay.url} style={nostrStyles.relayRow}>
              <View style={[nostrStyles.relayDot, { backgroundColor: dotColor }]} />
              <View style={{ flex: 1 }}>
                <Text
                  style={[nostrStyles.relayUrl, !relay.enabled && { color: Colors.textMuted }]}
                  numberOfLines={1}
                >
                  {relay.url.replace('wss://', '')}
                </Text>
                <Text style={[nostrStyles.relayStatus, { color: dotColor }]}>
                  {statusText}
                </Text>
              </View>
              {/* Bouton supprimer (relays custom uniquement) */}
              {relay.custom && (
                <TouchableOpacity
                  onPress={() => handleDeleteRelay(relay.url)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
                  style={{ marginRight: 6 }}
                >
                  <X size={13} color={Colors.red} />
                </TouchableOpacity>
              )}
              {/* Toggle ON/OFF */}
              <Switch
                value={relay.enabled}
                onValueChange={(val) => handleToggleRelay(relay.url, val)}
                trackColor={{ false: Colors.border, true: Colors.accentGlow }}
                thumbColor={relay.enabled ? Colors.accent : Colors.textMuted}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>
          );
        })}

        {/* Input ajout relay custom */}
        {showAddInput && (
          <View style={nostrStyles.addRelayRow}>
            <TextInput
              style={nostrStyles.addRelayInput}
              placeholder="wss://your-relay.com"
              placeholderTextColor={Colors.textMuted}
              value={customRelayInput}
              onChangeText={setCustomRelayInput}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onSubmitEditing={handleAddRelay}
            />
            <TouchableOpacity
              style={nostrStyles.addRelayConfirm}
              onPress={handleAddRelay}
              disabled={addingRelay || !customRelayInput.trim()}
              activeOpacity={0.7}
            >
              {addingRelay
                ? <ActivityIndicator size={14} color={Colors.accent} />
                : <Check size={14} color={Colors.accent} />}
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Gateway stats */}
      {isGateway && (
        <View style={nostrStyles.gatewayStats}>
          <Text style={nostrStyles.gatewayStatsTitle}>Gateway actif</Text>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
            <Text style={{ color: Colors.green, fontSize: 12 }}>{gatewayStats.relayedCount} relayés</Text>
            {gatewayStats.errorCount > 0 && (
              <Text style={{ color: Colors.red, fontSize: 12 }}>{gatewayStats.errorCount} erreurs</Text>
            )}
            {pendingCount > 0 && (
              <Text style={{ color: Colors.yellow, fontSize: 12 }}>{pendingCount} en cours</Text>
            )}
          </View>
        </View>
      )}

      {/* Toggle GPS présence */}
      <SettingToggle
        icon={locationLoading
          ? <ActivityIndicator size={16} color={Colors.blue} />
          : <Globe size={18} color={Colors.blue} />}
        label="Partager position (Nostr)"
        value={settings.shareLocation ?? false}
        onToggle={handleToggleLocation}
      />
    </View>
  );
}

const nostrStyles = StyleSheet.create({
  relayList: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 0.5,
    borderTopColor: Colors.border,
  },
  relayListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  relayListTitle: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  addRelayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: Colors.accent,
  },
  addRelayBtnText: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: '600',
  },
  relayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.border,
  },
  relayDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
  },
  relayUrl: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  relayStatus: {
    fontSize: 9,
    marginTop: 1,
  },
  addRelayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 0.5,
    borderTopColor: Colors.border,
  },
  addRelayInput: {
    flex: 1,
    backgroundColor: Colors.surfaceLight,
    borderWidth: 0.5,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: Colors.text,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  addRelayConfirm: {
    backgroundColor: Colors.surfaceLight,
    borderWidth: 0.5,
    borderColor: Colors.accent,
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gatewayStats: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 0.5,
    borderTopColor: Colors.border,
  },
  gatewayStatsTitle: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
});

const QR_SIZE = Dimensions.get('window').width * 0.6;

function NpubQRModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { npub } = useNostr();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!npub) return;
    await Clipboard.setStringAsync(npub);
    setCopied(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={npubStyles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={npubStyles.card} onPress={() => {}}>
          <View style={npubStyles.header}>
            <Text style={npubStyles.title}>Clé publique (npub)</Text>
            <TouchableOpacity onPress={onClose}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          {npub ? (
            <>
              <View style={npubStyles.qrWrapper}>
                <QRCode value={npub} size={QR_SIZE} color={Colors.text} backgroundColor={Colors.surface} />
              </View>
              <Text style={npubStyles.npubText} numberOfLines={2} selectable>
                {npub}
              </Text>
              <TouchableOpacity style={npubStyles.copyBtn} onPress={handleCopy} activeOpacity={0.7}>
                {copied
                  ? <Check size={16} color={Colors.green} />
                  : <Copy size={16} color={Colors.accent} />}
                <Text style={[npubStyles.copyBtnText, copied && { color: Colors.green }]}>
                  {copied ? 'Copié !' : 'Copier npub'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={npubStyles.noNpub}>Wallet non initialisé</Text>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const npubStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
  },
  qrWrapper: {
    alignItems: 'center',
    marginBottom: 20,
    padding: 16,
    backgroundColor: Colors.surfaceLight,
    borderRadius: 12,
  },
  npubText: {
    fontSize: 11,
    color: Colors.textMuted,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 16,
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.accentGlow,
    paddingVertical: 12,
    borderRadius: 10,
  },
  copyBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.accent,
  },
  noNpub: {
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: 32,
  },
});

function LanguageSelectorCard() {
  const { settings, updateSettings } = useAppSettings();
  const { t } = useTranslation();

  const langs: { code: AppLanguage; flag: string; label: string }[] = [
    { code: 'en', flag: '🇬🇧', label: 'English' },
    { code: 'fr', flag: '🇫🇷', label: 'Français' },
    { code: 'es', flag: '🇪🇸', label: 'Español' },
  ];

  return (
    <View style={styles.sectionCard}>
      {langs.map(({ code, flag, label }, index) => {
        const isActive = settings.language === code;
        return (
          <TouchableOpacity
            key={code}
            style={[
              styles.settingRow,
              index === langs.length - 1 && { borderBottomWidth: 0 },
            ]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              updateSettings({ language: code });
            }}
            activeOpacity={0.6}
          >
            <View style={styles.settingLeft}>
              <Text style={{ fontSize: 20 }}>{flag}</Text>
              <Text style={[styles.settingLabel, isActive && { color: Colors.accent }]}>{label}</Text>
            </View>
            {isActive && <Check size={16} color={Colors.accent} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function SettingsScreen() {
  const [showSeedQRScanner, setShowSeedQRScanner] = React.useState<boolean>(false);
  const [editingName, setEditingName] = React.useState(false);
  const [nameInput, setNameInput] = React.useState('');
  const [showNpubQR, setShowNpubQR] = React.useState(false);
  const { isInitialized, importWallet } = useWalletSeed();
  const { settings, updateSettings } = useAppSettings();
  const { identity, setDisplayName, contacts, addContact, removeContact, toggleFavorite } = useMessages();
  const {
    connected: btEnabled,
    device: bleDevice,
    deviceInfo: bleDeviceInfo,
    disconnectGateway,
    setRadioParams,
    setTxPower,
  } = useBle();
  const [showBleModal, setShowBleModal] = useState(false);

  const autoRelay = settings.autoRelay;
  const notifications = settings.notifications;

  const handleSeedQRScanned = useCallback((mnemonic: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    importWallet(mnemonic);
    setShowSeedQRScanner(false);
    Alert.alert('Succès', 'Seed importée depuis SeedQR');
  }, [importWallet]);

  const handleToggle = useCallback((key: 'autoRelay' | 'notifications') => {
    return (val: boolean) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      updateSettings({ [key]: val });
    };
  }, [updateSettings]);

  const showAlert = useCallback((title: string, message: string) => {
    Alert.alert(title, message);
  }, []);

  const handleStartEditName = useCallback(() => {
    setNameInput(identity?.displayName ?? '');
    setEditingName(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [identity?.displayName]);

  const handleSaveName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    await setDisplayName(trimmed);
    setEditingName(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [nameInput, setDisplayName]);

  // --- Contacts ---
  const [showAddContact, setShowAddContact] = React.useState(false);
  const [addNodeId, setAddNodeId] = React.useState('');
  const [addName, setAddName] = React.useState('');
  const [addingContact, setAddingContact] = React.useState(false);

  const handleAddContact = useCallback(async () => {
    const nodeId = addNodeId.trim();
    const name = addName.trim();
    if (!nodeId || !name) return;
    setAddingContact(true);
    try {
      await addContact(nodeId, name);
      setAddNodeId('');
      setAddName('');
      setShowAddContact(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } finally {
      setAddingContact(false);
    }
  }, [addNodeId, addName, addContact]);

  const handleRemoveContact = useCallback((nodeId: string, name: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Supprimer le contact',
      `Retirer "${name}" de vos contacts ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => void removeContact(nodeId),
        },
      ]
    );
  }, [removeContact]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      {/* Profile card */}
      <View style={styles.profileCard}>
        <View style={styles.profileAvatar}>
          <Text style={styles.profileAvatarText}>
            {identity?.displayName ? identity.displayName[0].toUpperCase() : 'M'}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          {editingName ? (
            <View style={styles.profileEditRow}>
              <TextInput
                style={styles.profileNameInput}
                value={nameInput}
                onChangeText={setNameInput}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleSaveName}
                placeholder="Display name"
                placeholderTextColor={Colors.textMuted}
                maxLength={32}
              />
              <TouchableOpacity onPress={handleSaveName} style={styles.profileEditBtn}>
                <Check size={18} color={Colors.green} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingName(false)} style={styles.profileEditBtn}>
                <X size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={handleStartEditName} activeOpacity={0.7} style={styles.profileNameRow}>
              <Text style={styles.profileName}>
                {identity?.displayName || 'Mon Node'}
              </Text>
              <Pencil size={14} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
          <Text style={styles.profileNodeId} numberOfLines={1}>
            {identity?.nodeId || 'Non configuré'}
          </Text>
        </View>
        {/* QR npub button */}
        <TouchableOpacity
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setShowNpubQR(true); }}
          style={styles.profileQrBtn}
          activeOpacity={0.7}
        >
          <QrCode size={20} color={Colors.accent} />
        </TouchableOpacity>
      </View>

      {/* npub QR Modal */}
      <NpubQRModal visible={showNpubQR} onClose={() => setShowNpubQR(false)} />

      {/* ── BLE Gateway Modal ── */}
      <GatewayScanModal visible={showBleModal} onClose={() => setShowBleModal(false)} />

      <ConnectionModeSelector />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>LoRa Radio</Text>
        <View style={styles.sectionCard}>
          <SettingRow
            icon={<Radio size={18} color={Colors.accent} />}
            label="Frequency"
            value={bleDeviceInfo
              ? `${(bleDeviceInfo.radioFreqHz / 1e6).toFixed(3)} MHz`
              : '— MHz'}
            onPress={() => {
              if (!bleDeviceInfo) { showAlert('Frequency', 'Connectez un gateway BLE pour configurer la fréquence.'); return; }
              const bands = [433_175_000, 868_000_000, 869_525_000, 915_000_000];
              Alert.alert(
                'Fréquence LoRa',
                `Actuel : ${(bleDeviceInfo.radioFreqHz / 1e6).toFixed(3)} MHz`,
                bands.map((hz) => ({
                  text: `${(hz / 1e6).toFixed(3)} MHz`,
                  onPress: () => setRadioParams(hz, bleDeviceInfo.radioBwHz, bleDeviceInfo.radioSf, 5)
                    .catch((e: any) => Alert.alert('Erreur', e.message)),
                })).concat([{ text: 'Annuler', onPress: async () => {} }]),
              );
            }}
          />
          <SettingRow
            icon={<Cpu size={18} color={Colors.blue} />}
            label="Spread Factor"
            value={bleDeviceInfo ? `SF${bleDeviceInfo.radioSf}` : '—'}
            onPress={() => {
              if (!bleDeviceInfo) { showAlert('Spread Factor', 'Connectez un gateway BLE pour configurer le SF.'); return; }
              Alert.alert(
                'Spread Factor',
                `Actuel : SF${bleDeviceInfo.radioSf}`,
                [7, 8, 9, 10, 11, 12].map((sf) => ({
                  text: `SF${sf}`,
                  onPress: () => setRadioParams(bleDeviceInfo.radioFreqHz, bleDeviceInfo.radioBwHz, sf, 5)
                    .catch((e: any) => Alert.alert('Erreur', e.message)),
                })).concat([{ text: 'Annuler', onPress: async () => {} }]),
              );
            }}
          />
          <SettingRow
            icon={<Radio size={18} color={Colors.yellow} />}
            label="TX Power"
            value={bleDeviceInfo ? `${bleDeviceInfo.txPower} dBm (max ${bleDeviceInfo.maxTxPower})` : '—'}
            onPress={() => {
              if (!bleDeviceInfo) { showAlert('TX Power', 'Connectez un gateway BLE pour configurer la puissance TX.'); return; }
              const powers = [2, 5, 10, 14, 17, 20, 22].filter((p) => p <= bleDeviceInfo.maxTxPower);
              Alert.alert(
                'TX Power',
                `Actuel : ${bleDeviceInfo.txPower} dBm`,
                powers.map((p) => ({
                  text: `${p} dBm`,
                  onPress: () => setTxPower(p).catch((e: any) => Alert.alert('Erreur', e.message)),
                })).concat([{ text: 'Annuler', onPress: async () => {} }]),
              );
            }}
          />
          <SettingToggle
            icon={<Radio size={18} color={Colors.green} />}
            label="Auto Relay"
            value={autoRelay}
            onToggle={handleToggle('autoRelay')}
          />
          <SettingRow
            icon={<Bluetooth size={18} color={btEnabled ? Colors.blue : Colors.textMuted} />}
            label="Gateway LoRa (BLE)"
            value={btEnabled ? (bleDevice?.name ?? 'Connecté') : 'Non connecté'}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setShowBleModal(true); }}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bitcoin Wallet</Text>
        <SeedManagementCard />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Gateway & Relay</Text>
        <GatewayModeCard />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Nostr</Text>
        <NostrSettingsCard />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Endpoints & Services</Text>
        <EndpointConfigCard />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Network</Text>
        <NetworkSettingsCard />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Language / Langue</Text>
        <LanguageSelectorCard />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>General</Text>
        <View style={styles.sectionCard}>
          <SettingToggle
            icon={<Bell size={18} color={Colors.textSecondary} />}
            label="Notifications"
            value={notifications}
            onToggle={handleToggle('notifications')}
          />
          <SettingRow
            icon={<HardDrive size={18} color={Colors.textSecondary} />}
            label="Storage"
            value="24.3 MB"
          />
          <SettingRow
            icon={<Info size={18} color={Colors.textSecondary} />}
            label="About MeshCore"
            value={`v${Constants.expoConfig?.version ?? '1.0.1'}`}
          />
        </View>
      </View>

      {/* Contacts */}
      <View style={styles.section}>
        <View style={styles.contactsHeader}>
          <Text style={styles.sectionTitle}>Contacts</Text>
          <TouchableOpacity
            style={styles.addContactBtn}
            onPress={() => { setShowAddContact(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
          >
            <UserPlus size={16} color={Colors.accent} />
            <Text style={styles.addContactBtnText}>Ajouter</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionCard}>
          {contacts.length === 0 ? (
            <View style={styles.contactsEmpty}>
              <Users size={28} color={Colors.textMuted} />
              <Text style={styles.contactsEmptyText}>Aucun contact</Text>
              <Text style={styles.contactsEmptyHint}>
                Ajoutez des contacts pour leur envoyer des DMs directement.
              </Text>
            </View>
          ) : (
            contacts.map((c, idx) => (
              <View
                key={c.nodeId}
                style={[styles.contactRow, idx < contacts.length - 1 && { borderBottomWidth: 0.5, borderBottomColor: Colors.border }]}
              >
                <View style={styles.contactAvatar}>
                  <Text style={styles.contactAvatarText}>{c.displayName[0]?.toUpperCase() ?? '?'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>{c.displayName}</Text>
                  <Text style={styles.contactNodeId}>{c.nodeId.slice(0, 20)}…</Text>
                </View>
                <TouchableOpacity
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); void toggleFavorite(c.nodeId); }}
                  style={styles.contactAction}
                >
                  <Star size={18} color={c.isFavorite ? Colors.yellow : Colors.textMuted} fill={c.isFavorite ? Colors.yellow : 'transparent'} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleRemoveContact(c.nodeId, c.displayName)}
                  style={styles.contactAction}
                >
                  <Trash2 size={18} color={Colors.red} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Add Contact Modal */}
      <Modal visible={showAddContact} transparent animationType="slide">
        <View style={styles.contactModalOverlay}>
          <View style={styles.contactModalSheet}>
            <View style={styles.contactModalHeader}>
              <Text style={styles.contactModalTitle}>Ajouter un contact</Text>
              <TouchableOpacity onPress={() => setShowAddContact(false)}>
                <X size={22} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.contactModalLabel}>Node ID</Text>
            <TextInput
              style={styles.contactModalInput}
              value={addNodeId}
              onChangeText={setAddNodeId}
              placeholder="MESH-XXXX ou npub…"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.contactModalLabel}>Nom affiché</Text>
            <TextInput
              style={styles.contactModalInput}
              value={addName}
              onChangeText={setAddName}
              placeholder="Satoshi"
              placeholderTextColor={Colors.textMuted}
              maxLength={32}
            />
            <TouchableOpacity
              style={[styles.contactModalSave, (!addNodeId.trim() || !addName.trim() || addingContact) && { opacity: 0.5 }]}
              onPress={() => void handleAddContact()}
              disabled={!addNodeId.trim() || !addName.trim() || addingContact}
            >
              {addingContact ? (
                <ActivityIndicator color={Colors.black} />
              ) : (
                <Text style={styles.contactModalSaveText}>Enregistrer</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Système</Text>
        <View style={styles.card}>
          <UpdateChecker />
        </View>
      </View>

      <Text style={styles.footer}>
        MeshCore LoRa x Bitcoin{'\n'}
        Off-grid. Decentralized. Sovereign.
      </Text>

      {/* SeedQR Scanner Modal */}
      <SeedQRScanner
        visible={showSeedQRScanner}
        onClose={() => setShowSeedQRScanner(false)}
        onSeedScanned={handleSeedQRScanned}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  contentContainer: {
    paddingBottom: 40,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    margin: 16,
    padding: 20,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 16,
  },
  profileAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.accentGlow,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: Colors.accent,
  },
  profileAvatarText: {
    color: Colors.accent,
    fontSize: 22,
    fontWeight: '800' as const,
  },
  profileName: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700' as const,
  },
  profileNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  profileEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  profileNameInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700' as const,
    borderBottomWidth: 1,
    borderBottomColor: Colors.accent,
    paddingVertical: 2,
  },
  profileEditBtn: {
    padding: 4,
  },
  profileQrBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: Colors.accentGlow,
  },
  profileNodeId: {
    color: Colors.textMuted,
    fontSize: 13,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  section: {
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  sectionTitle: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '700' as const,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.border,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  settingLabel: {
    color: Colors.text,
    fontSize: 15,
  },
  settingLabelDestructive: {
    color: Colors.red,
  },
  settingRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '40%',
  },
  settingValue: {
    color: Colors.textMuted,
    fontSize: 14,
  },
  seedCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: Colors.border,
    padding: 16,
    overflow: 'hidden',
  },
  seedLoadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 20,
  },
  seedLoadingText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  seedCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  seedCardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  seedCardTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700' as const,
  },
  seedStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
  },
  seedStatusActive: {
    backgroundColor: Colors.greenDim,
  },
  seedStatusInactive: {
    backgroundColor: Colors.redDim,
  },
  seedStatusText: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
  },
  seedStatusTextActive: {
    color: Colors.green,
  },
  seedStatusTextInactive: {
    color: Colors.red,
  },
  walletInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.border,
  },
  walletInfoLabel: {
    color: Colors.textMuted,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  walletInfoValue: {
    color: Colors.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  addressCopyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  showSeedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    marginTop: 12,
    backgroundColor: Colors.accentGlow,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accentDim,
  },
  showSeedText: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  seedWordsContainer: {
    marginTop: 12,
  },
  seedWarningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.yellowDim,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    marginBottom: 12,
  },
  seedWarningText: {
    color: Colors.yellow,
    fontSize: 12,
    fontWeight: '600' as const,
    flex: 1,
  },
  seedWordsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  seedWordChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.surfaceLight,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: Colors.border,
  },
  seedWordIndex: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700' as const,
    fontFamily: 'monospace',
    minWidth: 14,
  },
  seedWordText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600' as const,
    fontFamily: 'monospace',
  },
  seedActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  seedActionSmall: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
  },
  seedActionSmallText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700' as const,
  },
  seedActionDestructive: {
    backgroundColor: Colors.redDim,
  },
  seedActionDestructiveText: {
    color: Colors.red,
    fontSize: 12,
    fontWeight: '700' as const,
  },
  noSeedDesc: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 16,
  },
  generateButtons: {
    gap: 10,
    marginBottom: 12,
  },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    backgroundColor: Colors.accent,
    borderRadius: 12,
  },
  generateButtonText: {
    color: Colors.black,
    fontSize: 15,
    fontWeight: '700' as const,
  },
  generateButton24: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    backgroundColor: Colors.accentGlow,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.accentDim,
  },
  generateButton24Text: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '700' as const,
  },
  importToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  importToggleText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  importContainer: {
    marginTop: 4,
    gap: 10,
  },
  importInput: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
    padding: 14,
    color: Colors.text,
    fontSize: 14,
    fontFamily: 'monospace',
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 0.5,
    borderColor: Colors.border,
  },
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    backgroundColor: Colors.accent,
    borderRadius: 12,
  },
  importButtonText: {
    color: Colors.black,
    fontSize: 15,
    fontWeight: '700' as const,
  },
  scanQRButton: {
    backgroundColor: Colors.blue,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  scanQRButtonText: {
    color: Colors.background,
    fontSize: 15,
    fontWeight: '600' as const,
  },
  endpointCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: Colors.border,
    padding: 16,
    overflow: 'hidden',
    marginBottom: 10,
  },
  endpointHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  endpointTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700' as const,
    flex: 1,
  },
  endpointRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  endpointLabel: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '600' as const,
    minWidth: 50,
  },
  endpointUrl: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
    textAlign: 'right',
  },
  endpointUrlActive: {
    color: Colors.accent,
  },
  endpointUrlCashu: {
    color: Colors.cyan,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  customEndpointContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  endpointInput: {
    flex: 1,
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
    padding: 12,
    color: Colors.text,
    fontSize: 13,
    fontFamily: 'monospace',
    borderWidth: 0.5,
    borderColor: Colors.border,
  },
  saveEndpointBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: Colors.border,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    marginTop: 10,
    backgroundColor: Colors.accentGlow,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accentDim,
  },
  testButtonCashu: {
    backgroundColor: Colors.cyanDim,
    borderColor: 'rgba(34, 211, 238, 0.3)',
  },
  testButtonText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  testButtonTextCashu: {
    color: Colors.cyan,
  },
  footer: {
    color: Colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 20,
  },
  gatewayCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: Colors.border,
    padding: 16,
    overflow: 'hidden',
  },
  gatewayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  gatewayTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gatewayTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700' as const,
  },
  gatewayStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  gatewayPulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  gatewayModeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
  },
  gatewayModeBadgeActive: {
    backgroundColor: Colors.greenDim,
  },
  gatewayModeBadgeInactive: {
    backgroundColor: Colors.surfaceHighlight,
  },
  gatewayModeText: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
  },
  gatewayModeTextActive: {
    color: Colors.green,
  },
  gatewayModeTextInactive: {
    color: Colors.textMuted,
  },
  gatewayDesc: {
    color: Colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 14,
  },
  gatewayToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    marginBottom: 14,
  },
  gatewayToggleBtnActive: {
    backgroundColor: Colors.redDim,
    borderWidth: 1,
    borderColor: 'rgba(255, 71, 87, 0.3)',
  },
  gatewayToggleBtnInactive: {
    backgroundColor: Colors.greenDim,
    borderWidth: 1,
    borderColor: 'rgba(0, 214, 143, 0.3)',
  },
  gatewayToggleText: {
    fontSize: 14,
    fontWeight: '700' as const,
  },
  gatewayToggleTextActivate: {
    color: Colors.green,
  },
  gatewayToggleTextDeactivate: {
    color: Colors.red,
  },
  gatewayStatsGrid: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceLight,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  gatewayStatItem: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  gatewayStatValue: {
    color: Colors.accent,
    fontSize: 18,
    fontWeight: '800' as const,
    fontFamily: 'monospace',
  },
  gatewayStatLabel: {
    color: Colors.textMuted,
    fontSize: 9,
    fontWeight: '600' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.3,
  },
  gatewayServicesSection: {
    marginBottom: 8,
  },
  gatewayServicesTitle: {
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
    marginBottom: 6,
    marginLeft: 2,
  },
  relayLogToggle: {
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 6,
  },
  relayLogToggleText: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600' as const,
  },
  relayLogContainer: {
    marginTop: 4,
    gap: 8,
  },
  relayLogItem: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.border,
  },
  relayLogDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 6,
  },
  relayLogContent: {
    flex: 1,
  },
  relayLogTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  relayLogType: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
  },
  relayLogTime: {
    color: Colors.textMuted,
    fontSize: 10,
    marginLeft: 'auto',
  },
  relayLogDetail: {
    color: Colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  relayLogMeta: {
    color: Colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 3,
  },
  connectionModeContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  connectionModeCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.border,
    padding: 12,
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  connectionModeIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  connectionModeLabel: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700' as const,
    marginBottom: 4,
  },
  connectionModeDesc: {
    color: Colors.textMuted,
    fontSize: 9,
    textAlign: 'center',
    lineHeight: 13,
  },
  connectionModeActiveDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  // ✅ Styles pour le sélecteur de broker
  brokerSelector: {
    marginBottom: 12,
    gap: 6,
  },
  brokerSelectorLabel: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  brokerOption: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  brokerOptionActive: {
    borderColor: Colors.purple,
    backgroundColor: Colors.purple + '18',
  },
  brokerOptionRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
  },
  brokerActiveCheck: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.purple + '30',
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  brokerOptionName: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  brokerOptionNameActive: {
    color: Colors.purple,
  },
  brokerOptionDesc: {
    color: Colors.textMuted,
    fontSize: 10,
    marginTop: 3,
  },
  reconnectBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Colors.purpleDim,
    borderWidth: 1,
    borderColor: Colors.purple + '40',
  },
  reconnectBtnActive: {
    opacity: 0.6,
  },
  reconnectBtnText: {
    color: Colors.purple,
    fontSize: 11,
    fontWeight: '600' as const,
  },
  // --- Contacts ---
  contactsHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 8,
  },
  addContactBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Colors.accentGlow,
    borderWidth: 1,
    borderColor: Colors.accentDim,
  },
  addContactBtnText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700' as const,
  },
  contactsEmpty: {
    alignItems: 'center' as const,
    paddingVertical: 24,
    gap: 8,
  },
  contactsEmptyText: {
    color: Colors.textMuted,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  contactsEmptyHint: {
    color: Colors.textMuted,
    fontSize: 12,
    textAlign: 'center' as const,
    paddingHorizontal: 20,
    lineHeight: 18,
  },
  contactRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  contactAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.accentGlow,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  contactAvatarText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '700' as const,
  },
  contactName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  contactNodeId: {
    color: Colors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  contactAction: {
    padding: 6,
  },
  contactModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end' as const,
  },
  contactModalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  contactModalHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 20,
  },
  contactModalTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700' as const,
  },
  contactModalLabel: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 12,
  },
  contactModalInput: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
    padding: 14,
    color: Colors.text,
    fontSize: 14,
    borderWidth: 0.5,
    borderColor: Colors.border,
  },
  contactModalSave: {
    marginTop: 20,
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center' as const,
  },
  contactModalSaveText: {
    color: Colors.black,
    fontSize: 15,
    fontWeight: '700' as const,
  },

  // ── BLE Gateway Modal ──
  bleModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  bleModalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 12,
    paddingBottom: 48,
  },
  bleModalHandle: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center' as const,
    marginBottom: 16,
  },
  bleModalClose: {
    position: 'absolute' as const,
    top: 16,
    right: 16,
    padding: 4,
  },
  bleModalHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    marginBottom: 20,
    marginTop: 8,
  },
  bleModalTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  bleConnectedBox: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  bleConnectedRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  bleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.green,
  },
  bleConnectedName: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  bleDeviceInfo: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginLeft: 16,
  },
  bleDisconnectBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: Colors.red,
    borderRadius: 10,
    padding: 12,
    alignItems: 'center' as const,
  },
  bleDisconnectBtnText: {
    color: Colors.red,
    fontWeight: '600' as const,
    fontSize: 14,
  },
  bleScanBtn: {
    backgroundColor: Colors.blue,
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
  },
  bleScanBtnDisabled: {
    opacity: 0.6,
  },
  bleScanBtnText: {
    color: Colors.black,
    fontWeight: '700' as const,
    fontSize: 15,
  },
  bleScanningHint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center' as const,
    marginTop: 8,
  },
  bleDeviceList: {
    marginTop: 12,
    gap: 4,
  },
  bleDeviceItem: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    padding: 12,
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
  },
  bleDeviceItemName: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  bleDeviceItemId: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  bleNoDevices: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center' as const,
    marginTop: 16,
    lineHeight: 18,
  },
  bleErrorText: {
    fontSize: 13,
    color: Colors.red,
    marginTop: 12,
    textAlign: 'center' as const,
  },
});
