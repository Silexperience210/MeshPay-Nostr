// Stockage des PSK (Pre-Shared Keys) pour les forums privés
// Chaque forum privé a une clé AES-256 de 32 bytes (64 chars hex)
// stockée en AsyncStorage, isolée par nom de canal.
import AsyncStorage from '@react-native-async-storage/async-storage';

const PSK_PREFIX = 'meshpay:forum_psk_v1:';

export async function savePsk(channelName: string, pskHex: string): Promise<void> {
  await AsyncStorage.setItem(PSK_PREFIX + channelName, pskHex);
}

export async function loadPsk(channelName: string): Promise<string | null> {
  return AsyncStorage.getItem(PSK_PREFIX + channelName);
}

export async function deletePsk(channelName: string): Promise<void> {
  await AsyncStorage.removeItem(PSK_PREFIX + channelName);
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
