import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Download, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react-native';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import Colors from '@/constants/colors';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.1';

export function UpdateChecker() {
  const [checking, setChecking] = useState<boolean>(false);
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloaded, setDownloaded] = useState<boolean>(false);

  const applyUpdate = useCallback((): void => {
    Alert.alert(
      'Redémarrer ?',
      'La mise à jour va être appliquée immédiatement.',
      [
        { text: 'Plus tard', style: 'cancel' },
        {
          text: 'Redémarrer maintenant',
          onPress: () => {
            Updates.reloadAsync().catch((err: unknown) => {
              console.error('[Update] Reload failed:', err);
            });
          },
        },
      ]
    );
  }, []);

  const downloadUpdate = useCallback(async (): Promise<void> => {
    setDownloading(true);
    try {
      await Updates.fetchUpdateAsync();
      setDownloaded(true);
    } catch (err: unknown) {
      console.error('[Update] Erreur téléchargement:', err);
      Alert.alert('Erreur', 'Impossible de télécharger la mise à jour.');
    } finally {
      setDownloading(false);
    }
  }, []);

  const checkForUpdates = useCallback(async (): Promise<void> => {
    if (__DEV__ || !Updates.isEnabled) {
      // Dev / Expo Go — pas de vérification OTA disponible
      console.log('[Update] OTA non disponible en mode dev');
      return;
    }

    setChecking(true);
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateAvailable(true);
      } else {
        setUpdateAvailable(false);
        Alert.alert('À jour', 'Vous utilisez la dernière version disponible.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Update] Erreur vérification:', msg);
      // Toutes les erreurs OTA sont silencieuses (serveur non configuré, token absent, réseau)
      // L'utilisateur voit juste "À jour" — pas d'alerte d'erreur réseau inutile
    } finally {
      setChecking(false);
    }
  }, [downloadUpdate]);

  const isDevBuild = __DEV__ || !Updates.isEnabled;

  return (
    <View style={styles.container}>
      <View style={styles.versionRow}>
        <Text style={styles.title}>Mises à jour</Text>
        <Text style={styles.version}>v{APP_VERSION}</Text>
      </View>

      {isDevBuild ? (
        <View style={styles.upToDate}>
          <CheckCircle size={16} color={Colors.textMuted} />
          <Text style={[styles.upToDateText, { color: Colors.textMuted }]}>Build de développement</Text>
        </View>
      ) : updateAvailable ? (
        <View style={styles.updateAvailable}>
          <AlertCircle size={20} color={Colors.yellow} />
          <Text style={styles.updateText}>
            {downloaded ? 'Prêt à redémarrer' : 'Mise à jour disponible'}
          </Text>
        </View>
      ) : (
        <View style={styles.upToDate}>
          <CheckCircle size={20} color={Colors.green} />
          <Text style={styles.upToDateText}>À jour</Text>
        </View>
      )}

      {/* Main action button */}
      {!isDevBuild && !updateAvailable && (
        <TouchableOpacity
          style={styles.button}
          onPress={() => void checkForUpdates()}
          disabled={checking}
          testID="check-updates-button"
        >
          {checking ? (
            <ActivityIndicator color={Colors.black} />
          ) : (
            <>
              <RefreshCw size={18} color={Colors.black} />
              <Text style={styles.buttonText}>Vérifier les mises à jour</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {/* Download button — shown after update detected */}
      {updateAvailable && !downloaded && (
        <TouchableOpacity
          style={styles.button}
          onPress={() => void downloadUpdate()}
          disabled={downloading}
        >
          {downloading ? (
            <>
              <ActivityIndicator color={Colors.black} />
              <Text style={styles.buttonText}>Téléchargement…</Text>
            </>
          ) : (
            <>
              <Download size={18} color={Colors.black} />
              <Text style={styles.buttonText}>Télécharger la mise à jour</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {/* Apply button — shown after download */}
      {downloaded && (
        <TouchableOpacity
          style={[styles.button, { backgroundColor: Colors.green }]}
          onPress={applyUpdate}
        >
          <CheckCircle size={18} color={Colors.black} />
          <Text style={styles.buttonText}>Redémarrer et appliquer</Text>
        </TouchableOpacity>
      )}
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
    marginTop: 4,
  },
  buttonText: {
    color: Colors.black,
    fontSize: 14,
    fontWeight: '600',
  },
});
