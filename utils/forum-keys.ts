// Stockage sécurisé des PSK (Pre-Shared Keys) pour les forums privés
// Chaque forum privé a une clé AES-256 de 32 bytes (64 chars hex)
// stockée dans SecureStore (Android Keystore / iOS Keychain)
import * as SecureStore from 'expo-secure-store';

const PSK_PREFIX = 'meshpay:forum_psk_v1:';

/**
 * Sauvegarde une PSK de manière sécurisée dans le Keychain/Keystore
 * ⚠️ CRITIQUE: Les PSK sont des secrets cryptographiques, jamais dans AsyncStorage
 */
export async function savePsk(channelName: string, pskHex: string): Promise<void> {
  await SecureStore.setItemAsync(PSK_PREFIX + channelName, pskHex);
}

/**
 * Charge une PSK depuis le stockage sécurisé
 * @returns null si la clé n'existe pas
 */
export async function loadPsk(channelName: string): Promise<string | null> {
  return SecureStore.getItemAsync(PSK_PREFIX + channelName);
}

/**
 * Supprime une PSK du stockage sécurisé
 */
export async function deletePsk(channelName: string): Promise<void> {
  await SecureStore.deleteItemAsync(PSK_PREFIX + channelName);
}

/**
 * Migre les PSK de AsyncStorage vers SecureStore (one-time migration)
 * À appeler au démarrage de l'app
 */
export async function migratePskFromAsyncStorage(): Promise<void> {
  // Ancienne implémentation utilisait AsyncStorage
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  
  const keys = await AsyncStorage.getAllKeys();
  const pskKeys = keys.filter(k => k.startsWith(PSK_PREFIX));
  
  for (const key of pskKeys) {
    const psk = await AsyncStorage.getItem(key);
    if (psk) {
      // Migrer vers SecureStore
      await SecureStore.setItemAsync(key, psk);
      // Supprimer l'ancienne entrée non sécurisée
      await AsyncStorage.removeItem(key);
      console.log('[ForumKeys] Migrated PSK to SecureStore:', key.replace(PSK_PREFIX, ''));
    }
  }
}

// Charger toutes les PSKs connues pour une liste de canaux
export async function loadAllPsks(channelNames: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    channelNames.map(async (name) => {
      const psk = await loadPsk(name);
      if (psk) map.set(name, psk);
    })
  );
  return map;
}
