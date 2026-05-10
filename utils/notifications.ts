/**
 * utils/notifications.ts — Notifications push locales
 *
 * Gère :
 * - Permission (demandée une seule fois)
 * - Canal Android "shop" + canal "messages"
 * - Envoi de notifications pour commandes et messages
 * - Respect du toggle settings.notifications
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Handler global : afficher la notif même si l'app est au premier plan
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ─── Permission ──────────────────────────────────────────────────────────────

let _permissionGranted: boolean | null = null;

export async function requestNotificationPermission(): Promise<boolean> {
  if (_permissionGranted !== null) return _permissionGranted;

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') {
    _permissionGranted = true;
    return true;
  }

  const { status } = await Notifications.requestPermissionsAsync();
  _permissionGranted = status === 'granted';
  return _permissionGranted;
}

// ─── Canaux Android ──────────────────────────────────────────────────────────

export async function configureNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('forum_messages', {
    name: 'Messages forum',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 150],
    lightColor: '#4DACFF',
    sound: 'default',
    showBadge: true,
  });

  await Notifications.setNotificationChannelAsync('shop_orders', {
    name: 'Commandes boutique',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#F7931A',
    sound: 'default',
    showBadge: true,
  });

  await Notifications.setNotificationChannelAsync('shop_reviews', {
    name: 'Avis & réputation',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#FBBF24',
    showBadge: false,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function send(
  title: string,
  body: string,
  channelId: string,
  data?: Record<string, unknown>,
  notificationsEnabled = true,
): Promise<void> {
  if (!notificationsEnabled) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: data ?? {},
      sound: 'default',
      ...(Platform.OS === 'android' ? { channelId } : {}),
    },
    trigger: null, // immédiat
  });
}

// ─── Notifications Shop ──────────────────────────────────────────────────────

/** Nouvelle commande reçue (vendeur) */
export async function notifyNewOrder(
  productName: string,
  buyerAlias: string,
  totalSats: number,
  notificationsEnabled = true,
): Promise<void> {
  await send(
    '🛍️ Nouvelle commande !',
    `${buyerAlias} commande "${productName}" — ${totalSats} sat`,
    'shop_orders',
    { type: 'new_order' },
    notificationsEnabled,
  );
}

/** Statut de commande mis à jour (acheteur) */
export async function notifyOrderStatus(
  productName: string,
  status: string,
  notificationsEnabled = true,
): Promise<void> {
  const labels: Record<string, string> = {
    paid: '✅ Paiement confirmé',
    processing: '📦 En préparation',
    shipped: '🚚 Expédié !',
    delivered: '🎉 Livré !',
    cancelled: '❌ Annulé',
  };
  const title = labels[status] ?? '📬 Mise à jour commande';
  await send(
    title,
    `"${productName}"`,
    'shop_orders',
    { type: 'order_status', status },
    notificationsEnabled,
  );
}

/** Invoice / info paiement reçue (acheteur) */
export async function notifyPaymentInfoReceived(
  productName: string,
  notificationsEnabled = true,
): Promise<void> {
  await send(
    '💳 Info paiement reçue',
    `Le vendeur a envoyé les détails de paiement pour "${productName}"`,
    'shop_orders',
    { type: 'payment_info' },
    notificationsEnabled,
  );
}

/** Nouveau message dans un forum (LoRa ou Nostr) */
export async function notifyForumMessage(
  channelName: string,
  senderAlias: string,
  text: string,
  notificationsEnabled = true,
): Promise<void> {
  await send(
    `#${channelName}`,
    `${senderAlias}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`,
    'forum_messages',
    { type: 'forum_message', channelName },
    notificationsEnabled,
  );
}

/** Nouvel avis reçu (vendeur) */
export async function notifyNewReview(
  productName: string,
  rating: number,
  notificationsEnabled = true,
): Promise<void> {
  const stars = '⭐'.repeat(Math.min(rating, 5));
  await send(
    `${stars} Nouvel avis`,
    `Vous avez reçu un avis ${rating}/5 pour "${productName}"`,
    'shop_reviews',
    { type: 'new_review' },
    notificationsEnabled,
  );
}

// ─── Listener de réponse (deep link) ────────────────────────────────────────

export function addNotificationResponseListener(
  handler: (type: string, data: Record<string, unknown>) => void,
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as Record<string, unknown>;
    handler((data.type as string) ?? '', data);
  });
  return () => sub.remove();
}
