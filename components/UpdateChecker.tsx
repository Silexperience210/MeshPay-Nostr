import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Download, CheckCircle, AlertCircle } from 'lucide-react-native';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import Colors from '@/constants/colors';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.1';

export function UpdateChecker() {
  const [checking, setChecking] = useState<boolean>(false);
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);

  const downloadUpdate = useCallback(async (): Promise<void> => {
    setDownloading(true);
    try {
      console.log('[Update] Fetching OTA update...');
      await Updates.fetchUpdateAsync();
      Alert.alert(
        'Mise à jour téléchargée',
        'Redémarrer pour appliquer la mise à jour ?',
        [
          { text: 'Plus tard', style: 'cancel' },
          {
            text: 'Redémarrer',
            onPress: () => {
              console.log('[Update] Reloading app with new update...');
              Updates.reloadAsync().catch((err: unknown) => {
                console.error('[Update] Reload failed:', err);
              });
            },
          },
        ]
      );
    } catch (err: unknown) {
      console.error('[Update] Erreur téléchargement:', err);
      Alert.alert('Erreur', 'Impossible de télécharger la mise à jour pour le moment.');
    } finally {
      setDownloading(false);
    }
  }, []);

  const checkForUpdates = useCallback(async (): Promise<void> => {
    if (__DEV__ || !Updates.isEnabled) {
      console.log('[Update] Check skipped: expo-updates disabled in this runtime');
      Alert.alert(
        'Indisponible ici',
        'La vérification OTA fonctionne seulement dans une build de production avec expo-updates activé.'
      );
      return;
    }

    setChecking(true);
    try {
      console.log('[Update] Checking for OTA updates...');
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateAvailable(true);
        Alert.alert(
          'Mise à jour disponible',
          'Une nouvelle version de BitMesh est disponible. Voulez-vous la télécharger ?',
          [
            { text: 'Plus tard', style: 'cancel' },
            { text: 'Télécharger', onPress: () => void downloadUpdate() },
          ]
        );
      } else {
        setUpdateAvailable(false);
        Alert.alert('À jour', 'Vous utilisez la dernière version disponible.');
      }
    } catch (err: unknown) {
      console.error('[Update] Erreur vérification:', err);
      Alert.alert('Erreur', 'Impossible de vérifier les mises à jour. Réessayez plus tard.');
    } finally {
      setChecking(false);
    }
  }, [downloadUpdate]);

  return (
    <View style={styles.container}>
      <View style={styles.versionRow}>
        <Text style={styles.title}>Mises à jour</Text>
        <Text style={styles.version}>v{APP_VERSION}</Text>
      </View>
      
      {updateAvailable ? (
        <View style={styles.updateAvailable}>
          <AlertCircle size={20} color={Colors.yellow} />
          <Text style={styles.updateText}>Mise à jour disponible</Text>
        </View>
      ) : (
        <View style={styles.upToDate}>
          <CheckCircle size={20} color={Colors.green} />
          <Text style={styles.upToDateText}>À jour</Text>
        </View>
      )}
      
      <TouchableOpacity
        style={styles.button}
        onPress={() => void checkForUpdates()}
        disabled={checking || downloading}
        testID="check-updates-button"
      >
        {checking || downloading ? (
          <ActivityIndicator color={Colors.black} />
        ) : (
          <>
            <Download size={18} color={Colors.black} />
            <Text style={styles.buttonText}>Vérifier les mises à jour</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 16,
    marginVertical: 8,
  },
  versionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  version: {
    color: Colors.textMuted,
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  upToDate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  upToDateText: {
    color: Colors.green,
    fontSize: 14,
  },
  updateAvailable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  updateText: {
    color: Colors.yellow,
    fontSize: 14,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: {
    color: Colors.black,
    fontSize: 14,
    fontWeight: '600',
  },
});
