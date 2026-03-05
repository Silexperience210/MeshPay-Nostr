// Provider principal pour la messagerie MeshCore P2P chiffrée
import { useState, useEffect, useCallback, useRef } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import * as Notifications from 'expo-notifications';
import {
  encryptDM,
  decryptDM,
  encryptForumWithKey,
  decryptForumWithKey,
  type EncryptedPayload,
} from '@/utils/encryption';
import { savePsk, loadPsk, deletePsk, loadAllPsks } from '@/utils/forum-keys';
import { isChunkPacket } from '@/utils/meshcore-protocol';
import {
  type StoredMessage,
  type StoredConversation,
  type MessageType,
  listConversations,
  saveConversation,
  loadMessages,
  saveMessage,
  updateConversationLastMessage,
  updateConversationPubkey,
  markConversationRead,
  generateMsgId,
} from '@/utils/messages-store';
import { cleanupOldMessages, getUserProfile, setUserProfile, saveCashuToken, getUnverifiedCashuTokens, markCashuTokenVerified, incrementRetryCount, deleteMessageDB, deleteConversationDB, saveContact, getContacts, deleteContact, isContact, toggleContactFavorite, type DBContact } from '@/utils/database';
import { deriveMeshIdentity, type MeshIdentity } from '@/utils/identity';
import { messagingBus } from '@/utils/messaging-bus';
import { nostrClient, deriveChannelId } from '@/utils/nostr-client';
import { useNostr } from '@/providers/NostrProvider';
// MeshIdentity utilisé comme type de paramètre pour publishAndStore
import { useWalletSeed } from '@/providers/WalletSeedProvider';
// Import BLE provider pour communication LoRa via gateway ESP32
import { useBle } from '@/providers/BleProvider';
// Import Gateway provider pour tracking peers, relay LoRa et Cashu
import { useGateway } from '@/providers/GatewayProvider';
import { type GatewayPeer } from '@/utils/gateway';
// Import protocole MeshCore binaire
import {
  type MeshCorePacket,
  MeshCoreMessageType,
  MeshCoreFlags,
  extractTextFromPacket,
  uint64ToNodeId,
  nodeIdToUint64,
  encodeEncryptedPayload,
  decodeEncryptedPayload,
  createKeyAnnouncePacket,
  extractPubkeyFromAnnounce,
  extractPosition,
  createPingPacket,
} from '@/utils/meshcore-protocol';
// Import Cashu validation
import { verifyCashuToken, generateTokenId } from '@/utils/cashu';
import { getChunkManager, validateMessageSize } from '@/services/ChunkManager';
import AsyncStorage from '@react-native-async-storage/async-storage';

const JOINED_FORUMS_KEY = 'bitmesh:joined_forums_v1';

export interface MessagesState {
  identity: MeshIdentity | null;
  conversations: StoredConversation[];
  // Messages par convId
  messagesByConv: Record<string, StoredMessage[]>;
  // Actions
  sendMessage: (convId: string, text: string, type?: MessageType) => Promise<void>;
  sendAudio: (convId: string, base64: string, durationMs: number) => Promise<void>;
  sendImage: (convId: string, base64: string, mime: string) => Promise<void>;
  sendCashu: (convId: string, token: string, amountSats: number) => Promise<void>;
  loadConversationMessages: (convId: string) => Promise<void>;
  startConversation: (peerNodeId: string, peerName?: string, peerPubkey?: string) => Promise<void>;
  joinForum: (channelName: string, description?: string, pskHex?: string, skipAnnounce?: boolean) => Promise<void>;
  leaveForum: (channelName: string) => void;
  markRead: (convId: string) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  deleteMessage: (msgId: string, convId: string) => Promise<void>;
  deleteConversation: (convId: string) => Promise<void>;
  // Contacts
  contacts: DBContact[];
  addContact: (nodeId: string, displayName: string, pubkeyHex?: string) => Promise<void>;
  removeContact: (nodeId: string) => Promise<void>;
  isContact: (nodeId: string) => Promise<boolean>;
  toggleFavorite: (nodeId: string) => Promise<void>;
  refreshContacts: () => Promise<void>;
}

export const [MessagesContext, useMessages] = createContextHook((): MessagesState => {
  const { mnemonic } = useWalletSeed();
  const ble = useBle(); // Accès au BLE gateway pour LoRa
  const { gatewayState, registerPeer, handleLoRaMessage: handleLoRaMsg, relayCashu } = useGateway();
  const { isConnected: nostrConnected } = useNostr();
  const [identity, setIdentity] = useState<MeshIdentity | null>(null);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, StoredMessage[]>>({});
  const [contacts, setContacts] = useState<DBContact[]>([]);
  const chunkManagerRef = useRef(getChunkManager());
  const joinedForums = useRef<Set<string>>(new Set());
  // PSKs chargées en mémoire : channelName → pskHex (évite les appels AsyncStorage dans les callbacks)
  const forumPsks = useRef<Map<string, string>>(new Map());
  // FIX #1: Deduplication — Set des IDs de messages récents (max 200)
  const recentMsgIds = useRef<Set<string>>(new Set());
  // Buffer paquets chiffrés reçus avant de connaître la pubkey du sender
  const pendingEncryptedPackets = useRef<Map<string, MeshCorePacket[]>>(new Map());
  // Timestamp d'arrivée du premier paquet bufferisé par nodeId (pour expiration)
  const pendingEncryptedTimestamps = useRef<Map<string, number>>(new Map());
  /** Durée max de buffering : 5 minutes. Après, on abandonne (pubkey jamais reçue). */
  const PENDING_PACKET_TTL_MS = 5 * 60 * 1000;
  // Nostr : unsub functions pour les forums souscrits (channelName → unsub)
  const nostrChannelUnsubs = useRef<Map<string, () => void>>(new Map());
  const addToDedup = (id: string) => {
    recentMsgIds.current.add(id);
    if (recentMsgIds.current.size > 200) {
      // Supprimer le plus ancien (premier inséré)
      recentMsgIds.current.delete(recentMsgIds.current.values().next().value as string);
    }
  };

  // Dériver l'identité dès que le wallet est disponible
  useEffect(() => {
    if (mnemonic && !identity) {
      try {
        const id = deriveMeshIdentity(mnemonic);
        
        // Charger le display name depuis la DB
        getUserProfile().then(profile => {
          if (profile?.displayName) {
            id.displayName = profile.displayName;
            console.log('[Messages] Display name chargé:', profile.displayName);
          }
          setIdentity(id);
        }).catch(() => {
          setIdentity(id);
        });
        
        console.log('[Messages] Identité dérivée:', id.nodeId);

      } catch (err) {
        console.log('[Messages] Erreur dérivation identité:', err);
      }
    }

  }, [mnemonic, identity]);

  // Envoyer un PING BLE dès que la connexion BLE est établie + identité dispo
  // → permet à BleProvider de confirmer loraActive=true si le device répond
  useEffect(() => {
    if (ble.connected && identity) {
      const pingPacket = createPingPacket(identity.nodeId);
      ble.sendPacket(pingPacket).catch(() => {
        // Silencieux — le PING est un test optionnel
      });
      console.log('[MeshCore] PING envoyé pour vérifier relay LoRa');
    }
  }, [ble.connected, identity]);

  // Handler pour paquets MeshCore entrants via BLE → LoRa
  const handleIncomingMeshCorePacket = useCallback(async (packet: MeshCorePacket) => {
    if (!identity) return;

    try {
      console.log('[MeshCore] Paquet reçu via BLE:', {
        type: packet.type,
        fromNodeId: uint64ToNodeId(packet.fromNodeId),
        to: uint64ToNodeId(packet.toNodeId),
        ttl: packet.ttl,
      });

      // Vérifier que le paquet est pour nous (ou broadcast)
      const myNodeIdUint64 = nodeIdToUint64(identity.nodeId);
      if (packet.toNodeId !== myNodeIdUint64 && packet.toNodeId !== 0n) {
        // Forward to gateway if active (LoRa relay mode)
        if (gatewayState.isActive) {
          const rawPayload = JSON.stringify(packet);
          handleLoRaMsg(rawPayload, packet.fromNodeId?.toString() ?? 'unknown');
        }
        return;
      }

      // ✅ Gérer les chunks (messages longs)
      if (isChunkPacket(packet)) {
        const result = chunkManagerRef.current.handleIncomingChunk(packet);
        
        if (result.complete && result.message) {
          // Message complet reconstitué, traiter comme un TEXT normal
          console.log('[MeshCore] Message chunké reconstitué:', result.message.length, 'caractères');
          
          // Créer un paquet TEXT reconstruit pour traitement
          const reconstructedPacket: MeshCorePacket = {
            version: 0x01,
            type: MeshCoreMessageType.TEXT,
            flags: packet.flags,
            ttl: packet.ttl,
            messageId: packet.messageId,
            fromNodeId: packet.fromNodeId,
            toNodeId: packet.toNodeId,
            timestamp: packet.timestamp,
            subMeshId: (packet as any).subMeshId || 0,
            payload: new TextEncoder().encode(result.message),
          };
          
          // Traiter le paquet reconstruit
          console.log('[MeshCore] Traitement du paquet reconstruit:', reconstructedPacket.messageId);
          
          // ✅ Message chunké reconstitué - stocké dans la DB
          const fromNodeId = uint64ToNodeId(packet.fromNodeId);
          // ✅ Récupérer la pubkey depuis le packet ou la conversation
          let senderPubkey = '';
          const existingConv = conversations.find(c => c.id === fromNodeId);
          if (existingConv?.peerPubkey) {
            senderPubkey = existingConv.peerPubkey;
          } else {
            // Essayer d'extraire la pubkey du payload si présente
            try {
              const payloadStr = new TextDecoder().decode(packet.payload);
              if (payloadStr.startsWith('04') || payloadStr.startsWith('02') || payloadStr.startsWith('03')) {
                senderPubkey = payloadStr.slice(0, 66); // Pubkey compressed
                // Sauvegarder la pubkey pour futures utilisations
                updateConversationPubkey(fromNodeId, senderPubkey);
              }
            } catch {
              // Ignorer erreur décodage
            }
          }
          
          const msg: StoredMessage = {
            id: `chunk-${packet.messageId}`,
            conversationId: fromNodeId,
            fromNodeId: fromNodeId,
            fromPubkey: senderPubkey, // ✅ Pubkey récupérée
            text: result.message,
            type: 'text',
            timestamp: packet.timestamp * 1000,
            isMine: false,
            status: 'delivered',
            transport: 'ble',
          };
          
          saveMessage(msg);
          updateConversationLastMessage(fromNodeId, result.message.slice(0, 50), msg.timestamp, true);
          
          setMessagesByConv(prev => ({
            ...prev,
            [fromNodeId]: [...(prev[fromNodeId] ?? []), msg],
          }));
          
          // Envoyer ACK
          try {
            const { createAckPacket } = await import('@/utils/meshcore-protocol');
            const ackPacket = createAckPacket(
              identity.nodeId,
              fromNodeId,
              packet.messageId
            );
            await ble.sendPacket(ackPacket);
          } catch (ackErr) {
            console.error('[MeshCore] Erreur envoi ACK:', ackErr);
          }
          
        } else if (result.progress) {
          console.log('[MeshCore] Chunk reçu:', result.progress, '%');
        }
        return;
      }

      // Traiter selon le type de message
      if (packet.type === MeshCoreMessageType.KEY_ANNOUNCE) {
        // ✅ Gérer la réception d'une pubkey
        const { extractPubkeyFromAnnounce } = await import('@/utils/meshcore-protocol');
        const pubkey = extractPubkeyFromAnnounce(packet);
        if (pubkey) {
          const fromNodeId = uint64ToNodeId(packet.fromNodeId);
          console.log('[MeshCore] Pubkey reçue via KEY_ANNOUNCE:', fromNodeId, pubkey.slice(0, 20) + '...');
          updateConversationPubkey(fromNodeId, pubkey);

          // Retry des paquets bufferisés en attente de cette pubkey
          const buffered = pendingEncryptedPackets.current.get(fromNodeId);
          if (buffered && buffered.length > 0) {
            pendingEncryptedPackets.current.delete(fromNodeId);
            pendingEncryptedTimestamps.current.delete(fromNodeId); // Nettoyer le timestamp
            console.log(`[MeshCore] Retry ${buffered.length} paquet(s) bufferisé(s) pour ${fromNodeId}`);
            for (const bufferedPkt of buffered) {
              try {
                const enc = decodeEncryptedPayload(bufferedPkt.payload);
                if (!enc) continue;
                const plaintext = decryptDM(enc, identity.privkeyBytes, pubkey);
                const msgId = `mc-${bufferedPkt.messageId}`;
                const msg: StoredMessage = {
                  id: msgId,
                  conversationId: fromNodeId,
                  fromNodeId,
                  fromPubkey: pubkey,
                  text: plaintext,
                  type: 'text',
                  timestamp: bufferedPkt.timestamp * 1000,
                  isMine: false,
                  status: 'delivered',
                };
                saveMessage(msg);
                updateConversationLastMessage(fromNodeId, plaintext.slice(0, 50), msg.timestamp, true);
                setMessagesByConv(prev => ({
                  ...prev,
                  [fromNodeId]: [...(prev[fromNodeId] ?? []), msg],
                }));
              } catch (retryErr) {
                console.error('[MeshCore] Erreur retry paquet bufferisé:', retryErr);
              }
            }
          }
        }
        return;
      }

      if (packet.type === MeshCoreMessageType.TEXT) {
        const fromNodeId = uint64ToNodeId(packet.fromNodeId);

        let plaintext: string;
        let senderPubkey = '';

        // ✅ FIX: Vérifier si le message est chiffré
        if (packet.flags & MeshCoreFlags.ENCRYPTED) {
          // Décoder le payload chiffré
          const enc = decodeEncryptedPayload(packet.payload);
          if (!enc) {
            console.error('[MeshCore] Payload chiffré invalide');
            return;
          }

          // Récupérer la pubkey du sender depuis nos conversations
          const conv = conversations.find(c => c.id === fromNodeId);
          if (!conv?.peerPubkey) {
            const now = Date.now();

            // Vérifier si l'entrée a expiré (pubkey jamais arrivée depuis > 5 min)
            const firstSeen = pendingEncryptedTimestamps.current.get(fromNodeId);
            if (firstSeen !== undefined && now - firstSeen > PENDING_PACKET_TTL_MS) {
              console.warn(`[MeshCore] Pubkey introuvable pour ${fromNodeId} depuis ${Math.round((now - firstSeen) / 1000)}s — buffer purgé`);
              pendingEncryptedPackets.current.delete(fromNodeId);
              pendingEncryptedTimestamps.current.delete(fromNodeId);
              return;
            }

            // Buffer le paquet — sera retraité quand KEY_ANNOUNCE arrivera
            const existing = pendingEncryptedPackets.current.get(fromNodeId) ?? [];
            if (existing.length < 5) {
              pendingEncryptedPackets.current.set(fromNodeId, [...existing, packet]);
              // Enregistrer le timestamp du premier paquet bufferisé pour ce nodeId
              if (!pendingEncryptedTimestamps.current.has(fromNodeId)) {
                pendingEncryptedTimestamps.current.set(fromNodeId, now);
              }
              console.warn(`[MeshCore] Pubkey inconnue pour ${fromNodeId} — paquet bufferisé (${existing.length + 1}/5)`);
            }
            // Envoyer KEY_ANNOUNCE pour demander la pubkey
            try {
              const { createKeyAnnouncePacket } = await import('@/utils/meshcore-protocol');
              const requestPacket = createKeyAnnouncePacket(identity.nodeId, identity.pubkeyHex);
              await ble.sendPacket(requestPacket);
              console.log('[MeshCore] KEY_ANNOUNCE envoyé pour demander la pubkey');
            } catch (err) {
              console.error('[MeshCore] Erreur envoi KEY_ANNOUNCE:', err);
            }
            return;
          }

          senderPubkey = conv.peerPubkey;

          // Déchiffrer avec ECDH
          try {
            plaintext = decryptDM(enc, identity.privkeyBytes, senderPubkey);
          } catch (err) {
            console.error('[MeshCore] Erreur déchiffrement:', err);
            return;
          }
        } else {
          // Message non chiffré (rétrocompatibilité)
          plaintext = extractTextFromPacket(packet);
        }

        const msg: StoredMessage = {
          id: `mc-${packet.messageId}`,
          conversationId: fromNodeId,
          fromNodeId: fromNodeId,
          fromPubkey: senderPubkey,
          text: plaintext,
          type: 'text',
          timestamp: packet.timestamp * 1000, // MeshCore utilise secondes, on veut ms
          isMine: false,
          status: 'delivered',
        };

        saveMessage(msg);
        updateConversationLastMessage(fromNodeId, plaintext.slice(0, 50), msg.timestamp, true);

        // ✅ Envoyer ACK de confirmation
        try {
          const { createAckPacket } = await import('@/utils/meshcore-protocol');
          const ackPacket = createAckPacket(
            identity.nodeId,
            fromNodeId,
            packet.messageId
          );
          await ble.sendPacket(ackPacket);
          console.log('[MeshCore] ACK envoyé pour message', packet.messageId);
        } catch (ackErr) {
          console.error('[MeshCore] Erreur envoi ACK:', ackErr);
        }

        setMessagesByConv(prev => ({
          ...prev,
          [fromNodeId]: [...(prev[fromNodeId] ?? []), msg],
        }));

        // Créer conversation si nécessaire
        setConversations(prev => {
          const exists = prev.find(c => c.id === fromNodeId);
          if (!exists) {
            const newConv: StoredConversation = {
              id: fromNodeId,
              name: fromNodeId,
              isForum: false,
              peerPubkey: senderPubkey || undefined,
              lastMessage: plaintext.slice(0, 50),
              lastMessageTime: msg.timestamp,
              unreadCount: 1,
              online: true,
            };
            saveConversation(newConv);
            return [newConv, ...prev];
          }
          return prev.map(c => {
            if (c.id !== fromNodeId) return c;
            return {
              ...c,
              lastMessage: plaintext.slice(0, 50),
              lastMessageTime: msg.timestamp,
              unreadCount: c.unreadCount + 1,
              peerPubkey: senderPubkey || c.peerPubkey,
              online: true,
            };
          });
        });

        console.log('[MeshCore] Message TEXT déchiffré et livré depuis', fromNodeId);
      } else if (packet.type === MeshCoreMessageType.ACK) {
        // ✅ Traiter l'ACK reçu (confirmation de livraison)
        const fromNodeId = uint64ToNodeId(packet.fromNodeId);
        const { extractAckInfo } = await import('@/utils/meshcore-protocol');
        const ackInfo = extractAckInfo(packet.payload);
        
        if (ackInfo) {
          console.log('[MeshCore] ACK reçu pour message', ackInfo.originalMessageId, 'depuis', fromNodeId);
          
          // Mettre à jour le statut du message local
          const msgId = `mc-${ackInfo.originalMessageId}`;
          setMessagesByConv(prev => {
            const convMessages = prev[fromNodeId] || [];
            const updatedMessages = convMessages.map(m => {
              if (m.id === msgId || m.id.endsWith(`-${ackInfo.originalMessageId}`)) {
                return { ...m, status: 'delivered' as const };
              }
              return m;
            });
            return {
              ...prev,
              [fromNodeId]: updatedMessages,
            };
          });
        }
      } else if (packet.type === (MeshCoreMessageType as any).KEY_ANNOUNCE) {
        // ✅ Traiter l'annonce de clé publique
        const fromNodeId = uint64ToNodeId(packet.fromNodeId);
        const pubkeyHex = extractPubkeyFromAnnounce(packet);
        if (!pubkeyHex) {
          console.error('[MeshCore] KEY_ANNOUNCE invalide');
          return;
        }

        console.log('[MeshCore] Clé publique reçue depuis', fromNodeId, ':', pubkeyHex.slice(0, 16) + '...');

        // Sauvegarder la pubkey dans la conversation
        setConversations(prev => {
          const exists = prev.find(c => c.id === fromNodeId);
          if (exists) {
            // Mettre à jour la pubkey
            const updated = prev.map(c =>
              c.id === fromNodeId ? { ...c, peerPubkey: pubkeyHex, online: true } : c
            );
            // Persister
            const updatedConv = updated.find(c => c.id === fromNodeId);
            if (updatedConv) saveConversation(updatedConv);
            return updated;
          } else {
            // Créer nouvelle conversation
            const newConv: StoredConversation = {
              id: fromNodeId,
              name: fromNodeId,
              isForum: false,
              peerPubkey: pubkeyHex,
              lastMessage: '',
              lastMessageTime: packet.timestamp * 1000,
              unreadCount: 0,
              online: true,
            };
            saveConversation(newConv);
            return [newConv, ...prev];
          }
        });
        
        // ✅ Répondre avec notre propre clé publique (échange bidirectionnel)
        try {
          const announcePacket = createKeyAnnouncePacket(identity.nodeId, identity.pubkeyHex);
          await ble.sendPacket(announcePacket);
          console.log('[MeshCore] Notre clé publique envoyée à', fromNodeId);
        } catch (err) {
          console.error('[MeshCore] Erreur envoi KEY_ANNOUNCE:', err);
        }
      } else if (packet.type === MeshCoreMessageType.POSITION) {
        // GPS LoRa : position reçue (radar géré par RadarProvider via Nostr presence)
        const position = extractPosition(packet);
        if (position) {
          const fromNodeId = uint64ToNodeId(packet.fromNodeId);
          console.log('[MeshCore] Position reçue de', fromNodeId, ':', position.lat, position.lng);
        }
      } else {
        console.log('[MeshCore] Type de paquet non géré:', packet.type);
      }
    } catch (err) {
      console.error('[MeshCore] Erreur traitement paquet:', err);
    }
  }, [identity, gatewayState.isActive, handleLoRaMsg]);

  // Enregistrer le handler BLE dès que possible + annoncer notre clé publique
  useEffect(() => {
    if (ble.connected && identity) {
      console.log('[MeshCore] Connexion BLE établie, enregistrement handler');
      ble.onPacket(handleIncomingMeshCorePacket);

      // ✅ Envoyer notre clé publique en broadcast pour que les pairs puissent nous chiffrer des messages
      const keyAnnounce = createKeyAnnouncePacket(identity.nodeId, identity.pubkeyHex);
      ble.sendPacket(keyAnnounce)
        .then(() => console.log('[MeshCore] KEY_ANNOUNCE envoyé (broadcast)'))
        .catch(err => console.error('[MeshCore] Erreur envoi KEY_ANNOUNCE:', err));
    }
  }, [ble.connected, identity, handleIncomingMeshCorePacket]);

  // Charger les conversations depuis AsyncStorage
  useEffect(() => {
    listConversations().then(convs => {
      setConversations(convs);
    });
  }, []);

  // Charger les forums persistés + leurs PSKs au démarrage
  useEffect(() => {
    AsyncStorage.getItem(JOINED_FORUMS_KEY).then(async raw => {
      if (!raw) return;
      try {
        const saved: string[] = JSON.parse(raw);
        saved.forEach(ch => joinedForums.current.add(ch));
        // Charger les PSKs connues en mémoire
        const psks = await loadAllPsks(saved);
        psks.forEach((psk, ch) => forumPsks.current.set(ch, psk));
        console.log('[Forums] Forums persistés chargés:', saved, '| PSKs:', psks.size);
      } catch { /* ignore */ }
    });
  }, []);

  // GPS + présence Nostr gérés par RadarProvider

  // ── Handler messages forum entrants via Nostr (kind:42) ─────────────────────
  // Les messages NIP-28 sont en clair (forum public).
  // Le channelId est déterministe via deriveChannelId(channelName).

  const handleIncomingNostrChannelMessage = useCallback((
    channelName: string,
    event: { id: string; pubkey: string; content: string; created_at: number; tags: string[][] },
  ) => {
    if (!identity) return;

    // Skip nos propres events
    if (nostrClient.publicKey && event.pubkey === nostrClient.publicKey) return;

    // Déduplication
    if (recentMsgIds.current.has(event.id)) return;
    addToDedup(event.id);

    const convId = `forum:${channelName}`;
    const fromId = event.tags.find(t => t[0] === 'meshcore-from')?.[1] ?? event.pubkey;
    const ts = event.created_at * 1000;

    // Déchiffrer si forum privé (PSK connue)
    let plaintext = event.content;
    const psk = forumPsks.current.get(channelName);
    if (psk) {
      try {
        const payload = JSON.parse(event.content) as { v: number; nonce: string; ct: string };
        plaintext = decryptForumWithKey(payload, psk);
      } catch {
        console.warn('[Forum] Déchiffrement PSK échoué pour', channelName, '— message ignoré');
        return; // Ne pas afficher un message illisible
      }
    }

    const msg: StoredMessage = {
      id: event.id,
      conversationId: convId,
      fromNodeId: fromId,
      fromPubkey: event.pubkey,
      text: plaintext,
      type: 'text',
      timestamp: ts,
      isMine: false,
      status: 'delivered',
    };

    saveMessage(msg).catch(() => {});
    updateConversationLastMessage(convId, `${fromId.slice(0, 8)}: ${event.content.slice(0, 40)}`, ts, true).catch(() => {});

    setMessagesByConv(prev => ({
      ...prev,
      [convId]: [...(prev[convId] ?? []), msg],
    }));

    setConversations(prev =>
      prev.map(c => c.id === convId
        ? {
            ...c,
            lastMessage: `${fromId.slice(0, 8)}: ${event.content.slice(0, 40)}`,
            lastMessageTime: ts,
            unreadCount: c.unreadCount + 1,
          }
        : c,
      )
    );

    console.log('[Nostr→Forum]', channelName, '—', fromId.slice(0, 12), ':', event.content.slice(0, 40));
  }, [identity]);

  // ── Réabonnement Nostr aux forums quand la connexion est rétablie ────────────

  useEffect(() => {
    if (!nostrConnected) {
      // Déconnecter proprement les subs Nostr
      for (const unsub of nostrChannelUnsubs.current.values()) unsub();
      nostrChannelUnsubs.current.clear();
      return;
    }

    // Réabonner à tous les forums déjà rejoints
    for (const channelName of joinedForums.current) {
      if (nostrChannelUnsubs.current.has(channelName)) continue; // déjà abonné
      const channelId = deriveChannelId(channelName);
      const unsub = nostrClient.subscribeChannel(channelId, (event) => {
        handleIncomingNostrChannelMessage(channelName, event);
      });
      nostrChannelUnsubs.current.set(channelName, unsub);
      console.log('[Messages] Nostr forum réabonné:', channelName, channelId.slice(0, 16) + '…');
    }
  }, [nostrConnected, handleIncomingNostrChannelMessage]);

  // Radar géré par RadarProvider


  // ✅ NOUVEAU : Cleanup automatique des messages > 24h toutes les heures
  useEffect(() => {
    // Cleanup immédiat au démarrage
    cleanupOldMessages();
    
    // Puis toutes les heures
    const interval = setInterval(() => {
      cleanupOldMessages();
    }, 60 * 60 * 1000); // 1 heure
    
    return () => clearInterval(interval);
  }, []);

  // ✅ NOUVEAU : Vérification périodique des tokens unverified (P2)
  useEffect(() => {
    async function verifyUnverifiedTokens() {
      try {
        const allUnverified = await getUnverifiedCashuTokens();
        if (allUnverified.length === 0) return;
        // Limite : max 5 tokens par cycle, et on saute ceux qui ont déjà trop échoué
        const unverified = allUnverified
          .filter(t => (t.retryCount ?? 0) < 10)
          .slice(0, 5);
        if (unverified.length === 0) return;

        console.log('[Cashu] Vérification de', unverified.length, '/', allUnverified.length, 'tokens');

        // Vérifier tous les tokens en parallèle (était séquentiel → N requêtes HTTP en série)
        await Promise.all(unverified.map(async (token) => {
          try {
            const verification = await verifyCashuToken(token.token);
            if (verification.valid && !verification.unverified) {
              await markCashuTokenVerified(token.id);
              console.log('[Cashu] Token vérifié avec succès:', token.id);
            } else {
              await incrementRetryCount(token.id);
              if (!verification.valid) console.log('[Cashu] Token invalide:', token.id, verification.error);
            }
          } catch (err) {
            console.log('[Cashu] Erreur vérif token:', token.id, err);
            await incrementRetryCount(token.id);
          }
        }));
      } catch (err) {
        console.log('[Cashu] Erreur batch verification:', err);
      }
    }
    
    // Vérifier toutes les 5 minutes
    const interval = setInterval(verifyUnverifiedTokens, 5 * 60 * 1000);
    
    // Vérification immédiate au démarrage
    setTimeout(verifyUnverifiedTokens, 10000);
    
    return () => clearInterval(interval);
  }, []);

  // Publier un message sur le réseau + le sauvegarder localement (déclaré avant sendMessage)
  const publishAndStore = useCallback(async (
    msgId: string,
    convId: string,
    text: string,
    enc: EncryptedPayload,
    topic: string,
    ts: number,
    type: MessageType,
    id: MeshIdentity
  ) => {
    const isDM = topic.startsWith('meshcore/dm/');
    const isForum = convId.startsWith('forum:');

    // Transport BLE (LoRa) — uniquement pour les DMs (pas les forums)
    if (ble.connected && isDM && !isForum) {
      try {
        // ✅ FIX: Encoder le payload chiffré au lieu du texte en clair
        const encryptedPayload = encodeEncryptedPayload(enc);

        // Créer paquet MeshCore TEXT binaire avec payload chiffré
        const messageId = (Date.now() % 0xFFFFFFFF);

        const packet: MeshCorePacket = {
          version: 0x01,
          type: MeshCoreMessageType.TEXT,
          flags: MeshCoreFlags.ENCRYPTED,
          ttl: 10,
          messageId,
          fromNodeId: nodeIdToUint64(id.nodeId),
          toNodeId: nodeIdToUint64(convId),
          timestamp: Math.floor(Date.now() / 1000),
          subMeshId: 0,
          payload: encryptedPayload,
        };

        await ble.sendPacket(packet);
        console.log('[MeshCore] Paquet chiffré envoyé via BLE → LoRa:', convId);
      } catch (err) {
        console.error('[MeshCore] Erreur envoi BLE:', err);
        throw err;
      }
    }

    // Sauvegarder localement
    const msg: StoredMessage = {
      id: msgId,
      conversationId: convId,
      fromNodeId: id.nodeId,
      fromPubkey: id.pubkeyHex,
      text,
      type,
      timestamp: ts,
      isMine: true,
      status: 'sent',
      transport: 'ble',
      cashuAmount: type === 'cashu' ? parseCashuAmount(text) : undefined,
      cashuToken: type === 'cashu' ? text : undefined,
    };

    // ✅ CORRECTION: try/catch avec await
    try {
      await saveMessage(msg);
      await updateConversationLastMessage(convId, text.slice(0, 50), ts, false);
      console.log('[Messages] Message sauvegardé localement:', msgId);
    } catch (err) {
      console.error('[Messages] Erreur sauvegarde message:', err);
      // On continue quand même pour ne pas bloquer l'UI
    }

    setMessagesByConv(prev => ({
      ...prev,
      [convId]: [...(prev[convId] ?? []), msg],
    }));

    setConversations(prev => prev.map(c =>
      c.id === convId
        ? { ...c, lastMessage: text.slice(0, 50), lastMessageTime: ts }
        : c
    ));
  }, [ble]);

  // Envoyer un message (DM ou forum)
  const sendMessage = useCallback(async (
    convId: string,
    text: string,
    type: MessageType = 'text'
  ): Promise<void> => {
    if (!identity) {
      throw new Error('Identité non disponible');
    }
    // Autoriser l'envoi si BLE ou Nostr est disponible
    const isForum_ = convId.startsWith('forum:');
    if (!ble.connected && !nostrClient.isConnected) {
      throw new Error('Non connecté — activez le Bluetooth (LoRa) ou Nostr');
    }
    // Forums accessibles uniquement si Nostr disponible
    if (isForum_ && !nostrClient.isConnected) {
      throw new Error('Forums indisponibles hors ligne — connectez-vous via Nostr');
    }

    // ✅ Validation taille message
    const validation = validateMessageSize(text);
    if (!validation.valid) {
      console.warn(`[Messages] Message trop long: ${validation.size}/${validation.max} bytes`);
      // Le chunking sera géré automatiquement ci-dessous
    }

    const id = identity;
    const isForum = convId.startsWith('forum:');
    const msgId = generateMsgId();
    const ts = Date.now();

    // ✅ Utiliser chunking si message trop long (uniquement DM, pas forum)
    if (!isForum && chunkManagerRef.current.needsChunking(text)) {
      console.log('[Messages] Utilisation du chunking pour message long');
      const result = await chunkManagerRef.current.sendMessageWithChunking(
        text,
        id.nodeId,
        convId,
        async (packet) => {
          if (ble.connected) {
            await ble.sendPacket(packet);
          } else {
            throw new Error('BLE non connecté');
          }
        },
        true // encrypted
      );
      
      if (!result.success) {
        throw new Error(`Chunking échoué: ${result.error}`);
      }
      
      console.log(`[Messages] Message envoyé en ${result.chunksSent} chunks`);
      
      // Sauvegarder localement
      const msg: StoredMessage = {
        id: msgId,
        conversationId: convId,
        fromNodeId: id.nodeId,
        fromPubkey: id.pubkeyHex,
        text,
        type,
        timestamp: ts,
        isMine: true,
        status: 'sent',
      };
      
      // ✅ CORRECTION: try/catch pour la sauvegarde
      try {
        await saveMessage(msg);
        await updateConversationLastMessage(convId, text.slice(0, 50), ts, false);
        console.log('[Messages] Message chunk sauvegardé:', msgId);
      } catch (err) {
        console.error('[Messages] Erreur sauvegarde message chunk:', err);
      }
      
      setMessagesByConv(prev => ({
        ...prev,
        [convId]: [...(prev[convId] ?? []), msg],
      }));
      
      return;
    }

    if (isForum) {
      const channelName = convId.slice(6);

      // Chiffrer avec PSK si forum privé
      const psk = forumPsks.current.get(channelName);
      const payload = psk
        ? JSON.stringify(encryptForumWithKey(text, psk))
        : text;

      // Nostr (NIP-28 kind:42 sur channel déterministe)
      const channelId = deriveChannelId(channelName);
      await nostrClient.publishChannelMessage(channelId, payload);
      // Sauvegarder localement (mes propres messages ne reviennent pas via subscribeChannel)
      const msg: StoredMessage = {
        id: msgId,
        conversationId: convId,
        fromNodeId: id.nodeId,
        fromPubkey: id.pubkeyHex,
        text,
        type,
        timestamp: ts,
        isMine: true,
        status: 'sent',
      };
      try {
        await saveMessage(msg);
        await updateConversationLastMessage(convId, text.slice(0, 50), ts, false);
      } catch (err) {
        console.error('[Messages] Erreur sauvegarde message forum Nostr:', err);
      }
      setMessagesByConv(prev => ({
        ...prev,
        [convId]: [...(prev[convId] ?? []), msg],
      }));
      setConversations(prev => prev.map(c =>
        c.id === convId ? { ...c, lastMessage: text.slice(0, 50), lastMessageTime: ts } : c
      ));
      return;
    }

    // DM normal (sans chunking)
    const conv = conversations.find(c => c.id === convId);

    // Envoi NIP-17 via Nostr si connecté (parallèle ou exclusif selon BLE)
    if (nostrClient.isConnected && conv?.peerPubkey) {
      // Convertir pubkey hex 66 chars (compressée 02/03) → 64 chars (x-only Nostr)
      const nostrPubkey64 = conv.peerPubkey.length === 66
        ? conv.peerPubkey.slice(2)
        : conv.peerPubkey;
      if (nostrPubkey64.length === 64) {
        try {
          await nostrClient.publishDMSealed(nostrPubkey64, text);
          console.log('[Messages] DM NIP-17 envoyé via Nostr à:', convId);
        } catch (nostrErr) {
          console.warn('[Messages] NIP-17 échoué, fallback BLE si disponible:', nostrErr);
        }
      }
    }

    if (ble.connected) {
      if (!conv?.peerPubkey) {
        throw new Error('Pair hors ligne — clé publique introuvable. Attendez que le pair se connecte via LoRa.');
      }
      const enc = encryptDM(text, id.privkeyBytes, conv.peerPubkey);
      publishAndStore(msgId, convId, text, enc, 'meshcore/dm/' + convId, ts, type, id);
    } else if (!nostrClient.isConnected) {
      throw new Error('Non connecté — activez le Bluetooth (LoRa) ou Nostr');
    } else {
      // Nostr-only : sauvegarder localement sans BLE
      const msg: StoredMessage = {
        id: msgId, conversationId: convId, fromNodeId: id.nodeId,
        fromPubkey: id.pubkeyHex, text, type, timestamp: ts,
        isMine: true, status: 'sent', transport: 'nostr',
        cashuAmount: type === 'cashu' ? parseCashuAmount(text) : undefined,
        cashuToken: type === 'cashu' ? text : undefined,
      };
      await saveMessage(msg);
      await updateConversationLastMessage(convId, text.slice(0, 50), ts, false);
      setMessagesByConv(prev => ({ ...prev, [convId]: [...(prev[convId] ?? []), msg] }));
      setConversations(prev => prev.map(c =>
        c.id === convId ? { ...c, lastMessage: text.slice(0, 50), lastMessageTime: ts } : c
      ));
    }
  }, [identity, conversations, publishAndStore, ble.connected]);

  // Envoyer un message vocal (base64 m4a)
  const sendAudio = useCallback(async (
    convId: string,
    base64: string,
    durationMs: number
  ): Promise<void> => {
    if (!identity) throw new Error('Identité non disponible');
    if (!nostrClient.isConnected) throw new Error('Non connecté — activez Nostr');

    const totalSec = Math.floor(durationMs / 1000);
    const audioLabel = `🎤 ${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
    const voicePayload = `VOICE:${base64}|${durationMs}`;
    const msgId = generateMsgId();
    const ts = Date.now();

    // Envoi NIP-17 via Nostr
    const conv = conversations.find(c => c.id === convId);
    if (conv?.peerPubkey) {
      const pk = conv.peerPubkey.length === 66 ? conv.peerPubkey.slice(2) : conv.peerPubkey;
      if (pk.length === 64) {
        await nostrClient.publishDMSealed(pk, voicePayload);
      }
    }

    // Sauvegarder localement
    const msg: StoredMessage = {
      id: msgId,
      conversationId: convId,
      fromNodeId: identity.nodeId,
      fromPubkey: identity.pubkeyHex,
      text: audioLabel,
      type: 'audio',
      audioData: base64,
      audioDuration: durationMs,
      timestamp: ts,
      isMine: true,
      status: 'sent',
      transport: 'nostr',
    };
    await saveMessage(msg);
    await updateConversationLastMessage(convId, audioLabel, ts, false);
    setMessagesByConv(prev => ({ ...prev, [convId]: [...(prev[convId] ?? []), msg] }));
    setConversations(prev => prev.map(c =>
      c.id === convId ? { ...c, lastMessage: audioLabel, lastMessageTime: ts } : c
    ));
  }, [identity, conversations, nostrClient]);

  // Envoyer une image (base64 jpeg/png)
  const sendImage = useCallback(async (
    convId: string,
    base64: string,
    mime: string
  ): Promise<void> => {
    if (!identity) throw new Error('Identité non disponible');
    if (!nostrClient.isConnected) throw new Error('Non connecté — activez Nostr');

    const imagePayload = `IMAGE:${mime}|${base64}`;
    const imageLabel = '📷 Image';
    const msgId = generateMsgId();
    const ts = Date.now();

    const conv = conversations.find(c => c.id === convId);
    if (conv?.peerPubkey) {
      const pk = conv.peerPubkey.length === 66 ? conv.peerPubkey.slice(2) : conv.peerPubkey;
      if (pk.length === 64) {
        await nostrClient.publishDMSealed(pk, imagePayload);
      }
    }

    const msg: StoredMessage = {
      id: msgId,
      conversationId: convId,
      fromNodeId: identity.nodeId,
      fromPubkey: identity.pubkeyHex,
      text: imageLabel,
      type: 'image',
      imageData: base64,
      imageMime: mime,
      timestamp: ts,
      isMine: true,
      status: 'sent',
      transport: 'nostr',
    };
    await saveMessage(msg);
    await updateConversationLastMessage(convId, imageLabel, ts, false);
    setMessagesByConv(prev => ({ ...prev, [convId]: [...(prev[convId] ?? []), msg] }));
    setConversations(prev => prev.map(c =>
      c.id === convId ? { ...c, lastMessage: imageLabel, lastMessageTime: ts } : c
    ));
  }, [identity, conversations, nostrClient]);

  // Envoyer un Cashu token
  const sendCashu = useCallback(async (
    convId: string,
    token: string,
    amountSats: number
  ): Promise<void> => {
    await sendMessage(convId, token, 'cashu');
  }, [sendMessage]);

  // Charger les messages d'une conversation depuis AsyncStorage
  const loadConversationMessages = useCallback(async (convId: string): Promise<void> => {
    try {
      const msgs = await loadMessages(convId);
      setMessagesByConv(prev => ({ ...prev, [convId]: msgs }));
      console.log('[Messages] Messages chargés pour:', convId, '-', msgs.length, 'messages');
    } catch (err) {
      console.error('[Messages] Erreur chargement messages:', err);
      // Ne pas bloquer l'UI, juste loguer l'erreur
    }
  }, []);

  // Démarrer une nouvelle conversation DM
  const startConversation = useCallback(async (
    peerNodeId: string,
    peerName?: string,
    peerPubkey?: string,
  ): Promise<void> => {
    const existing = conversations.find(c => c.id === peerNodeId);
    if (existing) {
      // Mettre à jour la pubkey si fournie et absente
      if (peerPubkey && !existing.peerPubkey) {
        const updated = { ...existing, peerPubkey };
        await saveConversation(updated);
        setConversations(prev => prev.map(c => c.id === peerNodeId ? updated : c));
      }
      return;
    }

    const conv: StoredConversation = {
      id: peerNodeId,
      name: peerName ?? peerNodeId,
      isForum: false,
      peerPubkey: peerPubkey || undefined,
      lastMessage: '',
      lastMessageTime: Date.now(),
      unreadCount: 0,
      online: false,
    };
    try {
      await saveConversation(conv);
      setConversations(prev => [conv, ...prev]);
      console.log('[Messages] Conversation démarrée:', peerNodeId);
    } catch (err) {
      console.error('[Messages] Erreur démarrage conversation:', err);
      throw err;
    }
  }, [conversations]);

  // Rejoindre un forum
  const joinForum = useCallback(async (channelName: string, description?: string, pskHex?: string, skipAnnounce?: boolean): Promise<void> => {
    const convId = `forum:${channelName}`;
    joinedForums.current.add(channelName);
    AsyncStorage.setItem(JOINED_FORUMS_KEY, JSON.stringify([...joinedForums.current])).catch(() => {});

    // Stocker la PSK en mémoire + AsyncStorage si forum privé
    if (pskHex) {
      forumPsks.current.set(channelName, pskHex);
      await savePsk(channelName, pskHex);
      console.log('[Forum] PSK sauvegardée pour:', channelName);
    }

    // Nostr : publier kind:40 uniquement si nouveau forum (pas si on rejoint un forum découvert)
    if (nostrClient.isConnected && !skipAnnounce) {
      nostrClient.createChannel(channelName, description || `Forum ${channelName}`)
        .then(() => console.log('[Forum] kind:40 publié:', channelName))
        .catch((err) => console.warn('[Forum] Impossible de publier kind:40:', err));
    }

    // Nostr : souscrire au channel déterministe si connecté
    if (nostrClient.isConnected && !nostrChannelUnsubs.current.has(channelName)) {
      const channelId = deriveChannelId(channelName);
      const unsub = nostrClient.subscribeChannel(channelId, (event) => {
        handleIncomingNostrChannelMessage(channelName, event);
      });
      nostrChannelUnsubs.current.set(channelName, unsub);
      console.log('[Messages] Forum Nostr souscrit:', channelName, channelId.slice(0, 16) + '…');
    }

    const existing = conversations.find(c => c.id === convId);
    if (!existing) {
      const conv: StoredConversation = {
        id: convId,
        name: `#${channelName}`,
        isForum: true,
        lastMessage: description || '',
        lastMessageTime: Date.now(),
        unreadCount: 0,
        online: true,
      };
      // ✅ AJOUT: try/catch pour gérer les erreurs SQLite
      try {
        await saveConversation(conv);
        setConversations(prev => [conv, ...prev]);
        console.log('[Messages] Forum rejoint:', channelName);
      } catch (err) {
        console.error('[Messages] Erreur sauvegarde forum:', err);
        throw err; // Propager l'erreur pour que l'UI puisse l'afficher
      }
    } else {
      console.log('[Messages] Forum déjà existant:', channelName);
    }
  }, [conversations, handleIncomingNostrChannelMessage]);

  // ✅ NOUVEAU : Mettre à jour le display name
  const setDisplayName = useCallback(async (name: string): Promise<void> => {
    if (!identity) return;

    // ✅ CORRECTION: try/catch pour setUserProfile
    try {
      await setUserProfile({ displayName: name });
      setIdentity(prev => {
        if (!prev) return null;
        return { ...prev, displayName: name };
      });
      console.log('[Messages] Display name mis à jour:', name);
    } catch (err) {
      console.error('[Messages] Erreur mise à jour display name:', err);
      throw err;
    }
  }, [identity]);

  // Quitter un forum
  const leaveForum = useCallback((channelName: string): void => {
    joinedForums.current.delete(channelName);
    AsyncStorage.setItem(JOINED_FORUMS_KEY, JSON.stringify([...joinedForums.current])).catch(() => {});
    // Supprimer la PSK si forum privé
    if (forumPsks.current.has(channelName)) {
      forumPsks.current.delete(channelName);
      deletePsk(channelName).catch(() => {});
      console.log('[Forum] PSK supprimée pour:', channelName);
    }
    // Nostr : désabonner du channel
    const nostrUnsub = nostrChannelUnsubs.current.get(channelName);
    if (nostrUnsub) {
      nostrUnsub();
      nostrChannelUnsubs.current.delete(channelName);
    }
    console.log('[Messages] Forum quitté:', channelName);
  }, []);

  // Marquer une conversation comme lue
  const markRead = useCallback(async (convId: string): Promise<void> => {
    try {
      await markConversationRead(convId);
      setConversations(prev => prev.map(c =>
        c.id === convId ? { ...c, unreadCount: 0 } : c
      ));
      console.log('[Messages] Conversation marquée comme lue:', convId);
    } catch (err) {
      console.error('[Messages] Erreur markRead:', err);
    }
  }, []);

  // --- Contacts ---
  const refreshContacts = useCallback(async () => {
    const list = await getContacts();
    setContacts(list);
  }, []);

  useEffect(() => { refreshContacts(); }, []);

  const addContact = useCallback(async (nodeId: string, displayName: string, pubkeyHex?: string) => {
    await saveContact({ nodeId, displayName, pubkeyHex, isFavorite: false });
    await refreshContacts();
  }, [refreshContacts]);

  const removeContact = useCallback(async (nodeId: string) => {
    await deleteContact(nodeId);
    await refreshContacts();
  }, [refreshContacts]);

  const toggleFavorite = useCallback(async (nodeId: string) => {
    await toggleContactFavorite(nodeId);
    await refreshContacts();
  }, [refreshContacts]);

  // Supprimer un message localement
  const deleteMessage = useCallback(async (msgId: string, convId: string): Promise<void> => {
    try {
      await deleteMessageDB(msgId);
      setMessagesByConv(prev => ({
        ...prev,
        [convId]: (prev[convId] ?? []).filter(m => m.id !== msgId),
      }));
    } catch (err) {
      console.error('[Messages] Erreur deleteMessage:', err);
    }
  }, []);

  // Supprimer une conversation et tous ses messages (cascade DB)
  const deleteConversation = useCallback(async (convId: string): Promise<void> => {
    try {
      await deleteConversationDB(convId);
      setConversations(prev => prev.filter(c => c.id !== convId));
      setMessagesByConv(prev => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    } catch (err) {
      console.error('[Messages] Erreur deleteConversation:', err);
    }
  }, []);

  // ── Bridge Nostr → conversations ────────────────────────────────────────────
  // S'abonne au MessagingBus et intègre les DMs Nostr entrants dans les
  // conversations existantes.

  useEffect(() => {
    if (!identity) return;

    const unsub = messagingBus.subscribe(async (msg) => {
      if (msg.type !== 'dm') return;

      const fromId = msg.from; // nodeId MESH-XXXX ou pubkey hex si pas de tag meshcore-from
      const content = msg.content; // déjà déchiffré par NostrClient (NIP-04)

      // Déduplication locale
      if (recentMsgIds.current.has(msg.id)) return;
      addToDedup(msg.id);

      // Détecter les tokens Cashu inline
      let cashuAmount: number | undefined;
      let cashuTokenStr: string | undefined;
      let displayText = content;
      let msgType: StoredMessage['type'] = 'text';

      // ── Détection message vocal (VOICE:<base64>|<durationMs>) ──────────────
      if (content.startsWith('VOICE:')) {
        const payload = content.slice(6);
        const sep = payload.lastIndexOf('|');
        if (sep > 0) {
          const audioBase64 = payload.slice(0, sep);
          const durMs = parseInt(payload.slice(sep + 1), 10);
          if (audioBase64 && !isNaN(durMs)) {
            const totalSec = Math.floor(durMs / 1000);
            const audioLabel = `🎤 ${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
            const voiceMsg: StoredMessage = {
              id: msg.id,
              conversationId: fromId,
              fromNodeId: fromId,
              fromPubkey: msg.fromPubkey,
              text: audioLabel,
              type: 'audio',
              audioData: audioBase64,
              audioDuration: durMs,
              timestamp: msg.ts,
              isMine: false,
              status: 'delivered',
              transport: msg.transport as 'nostr' | 'lora' | 'ble',
            };
            await saveMessage(voiceMsg);
            await updateConversationLastMessage(fromId, audioLabel, msg.ts, true);
            setMessagesByConv(prev => ({ ...prev, [fromId]: [...(prev[fromId] ?? []), voiceMsg] }));
            setConversations(prev => {
              const exists = prev.find(c => c.id === fromId);
              if (!exists) {
                const newConv: StoredConversation = {
                  id: fromId, name: fromId, isForum: false, peerPubkey: msg.fromPubkey,
                  lastMessage: audioLabel, lastMessageTime: msg.ts, unreadCount: 1, online: true,
                };
                saveConversation(newConv);
                return [newConv, ...prev];
              }
              return prev.map(c => c.id !== fromId ? c : {
                ...c, lastMessage: audioLabel, lastMessageTime: msg.ts,
                unreadCount: c.unreadCount + 1, peerPubkey: msg.fromPubkey || c.peerPubkey, online: true,
              });
            });
            return;
          }
        }
      }

      // ── Détection image (IMAGE:<mime>|<base64>) ─────────────────────────────
      if (content.startsWith('IMAGE:')) {
        const payload = content.slice(6);
        const sep = payload.indexOf('|');
        if (sep > 0) {
          const imageMime = payload.slice(0, sep);
          const imageBase64 = payload.slice(sep + 1);
          if (imageBase64 && imageMime) {
            const imageMsg: StoredMessage = {
              id: msg.id,
              conversationId: fromId,
              fromNodeId: fromId,
              fromPubkey: msg.fromPubkey,
              text: '📷 Image',
              type: 'image',
              imageData: imageBase64,
              imageMime: imageMime,
              timestamp: msg.ts,
              isMine: false,
              status: 'delivered',
              transport: msg.transport as 'nostr' | 'lora' | 'ble',
            };
            await saveMessage(imageMsg);
            await updateConversationLastMessage(fromId, '📷 Image', msg.ts, true);
            setMessagesByConv(prev => ({ ...prev, [fromId]: [...(prev[fromId] ?? []), imageMsg] }));
            setConversations(prev => {
              const exists = prev.find(c => c.id === fromId);
              if (!exists) {
                const newConv: StoredConversation = {
                  id: fromId, name: fromId, isForum: false, peerPubkey: msg.fromPubkey,
                  lastMessage: '📷 Image', lastMessageTime: msg.ts, unreadCount: 1, online: true,
                };
                saveConversation(newConv);
                return [newConv, ...prev];
              }
              return prev.map(c => c.id !== fromId ? c : {
                ...c, lastMessage: '📷 Image', lastMessageTime: msg.ts,
                unreadCount: c.unreadCount + 1, peerPubkey: msg.fromPubkey || c.peerPubkey, online: true,
              });
            });
            return;
          }
        }
      }

      if (content.startsWith('cashuA')) {
        msgType = 'cashu';
        const parsed = parseCashuAmount(content);
        displayText = `[Cashu] ${parsed ?? '?'} sats`;
        cashuTokenStr = content;
        // Validation + stockage best-effort (async, non-bloquant)
        verifyCashuToken(content).then(async (v) => {
          if (v.valid && v.token) {
            const tokenId = generateTokenId(v.token);
            await saveCashuToken({
              id: tokenId,
              mintUrl: v.mintUrl || 'unknown',
              amount: v.amount || 0,
              token: content,
              proofs: JSON.stringify(v.token.token[0].proofs),
              source: fromId,
              memo: `Reçu via Nostr de ${fromId.slice(0, 10)}`,
              state: 'unverified',
              unverified: true,
              retryCount: 0,
            });
            console.log('[Nostr→Conv] Token Cashu stocké:', tokenId);
          }
        }).catch(() => {});
      }

      const stored: StoredMessage = {
        id: msg.id,
        conversationId: fromId,
        fromNodeId: fromId,
        fromPubkey: msg.fromPubkey,
        text: displayText,
        type: msgType,
        timestamp: msg.ts,
        isMine: false,
        status: 'delivered',
        transport: msg.transport as 'nostr' | 'lora' | 'ble',
        cashuAmount,
        cashuToken: cashuTokenStr,
      };

      await saveMessage(stored);
      await updateConversationLastMessage(fromId, displayText.slice(0, 50), msg.ts, true);

      setMessagesByConv(prev => ({
        ...prev,
        [fromId]: [...(prev[fromId] ?? []), stored],
      }));

      setConversations(prev => {
        const exists = prev.find(c => c.id === fromId);
        if (!exists) {
          const newConv: StoredConversation = {
            id: fromId,
            name: fromId,
            isForum: false,
            peerPubkey: msg.fromPubkey,
            lastMessage: displayText.slice(0, 50),
            lastMessageTime: msg.ts,
            unreadCount: 1,
            online: true,
          };
          saveConversation(newConv);
          return [newConv, ...prev];
        }
        return prev.map(c => {
          if (c.id !== fromId) return c;
          return {
            ...c,
            lastMessage: displayText.slice(0, 50),
            lastMessageTime: msg.ts,
            unreadCount: c.unreadCount + 1,
            peerPubkey: msg.fromPubkey || c.peerPubkey,
            online: true,
          };
        });
      });

      console.log('[Nostr→Conv] DM reçu de', fromId.slice(0, 16), '—', displayText.slice(0, 40));
    });

    return unsub;
  }, [identity]);

  return {
    identity,
    conversations,
    messagesByConv,
    sendMessage,
    sendAudio,
    sendImage,
    sendCashu,
    loadConversationMessages,
    startConversation,
    joinForum,
    leaveForum,
    markRead,
    setDisplayName,
    deleteMessage,
    deleteConversation,
    contacts,
    addContact,
    removeContact,
    isContact,
    toggleFavorite,
    refreshContacts,
  };
});

// Extraire le montant d'un Cashu token (approximatif depuis le texte)
function parseCashuAmount(text: string): number | undefined {
  try {
    if (!text.startsWith('cashuA')) return undefined;
    const base64 = text.slice(6);
    const json = JSON.parse(atob(base64));
    let total = 0;
    for (const entry of json.token ?? []) {
      for (const proof of entry.proofs ?? []) {
        total += proof.amount ?? 0;
      }
    }
    return total || undefined;
  } catch {
    return undefined;
  }
}
