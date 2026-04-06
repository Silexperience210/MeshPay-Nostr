// Provider principal pour la messagerie MeshCore P2P chiffrée
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'; // ✅ useMemo ajouté
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
import { deriveMeshIdentity, type MeshIdentityFull as MeshIdentity } from '@/utils/identity';
import { messagingBus } from '@/utils/messaging-bus';
import { MeshRouter } from '@/utils/mesh-routing';
import { getBleGatewayClient, type MeshCoreContact } from '@/utils/ble-gateway';
import { nostrClient, deriveChannelId } from '@/utils/nostr-client';
import { notifyForumMessage } from '@/utils/notifications';
import { useNostr } from '@/providers/NostrProvider';
import { useWalletStore } from '@/stores/walletStore';
// Import BLE provider pour communication LoRa via gateway ESP32
import { useBle } from '@/providers/BleProvider';
import { useUsbSerial } from '@/providers/UsbSerialProvider';
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
  encodeMeshCorePacket,
  decodeMeshCorePacket,
  extractPubkeyFromAnnounce,
  extractPosition,
  createPingPacket,
  base64ToBytes,
  bytesToBase64,
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
  joinedForumsList: string[];
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
  const mnemonic = useWalletStore((s) => s.mnemonic);
  const ble = useBle(); // Accès au BLE gateway pour LoRa
  const usbSerial = useUsbSerial(); // Accès USB Serial (transport alternatif)
  const { gatewayState, registerPeer, handleLoRaMessage: handleLoRaMsg, relayCashu } = useGateway();
  const { isConnected: nostrConnected } = useNostr();
  const [identity, setIdentity] = useState<MeshIdentity | null>(null);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, StoredMessage[]>>({});
  const [contacts, setContacts] = useState<DBContact[]>([]);
  const chunkManagerRef = useRef(getChunkManager());
  // Ref pour éviter que handleIncomingMeshCorePacket soit recréé à chaque changement
  // de gatewayState.isActive (même pattern que GatewayProvider.handleLoRaMessage)
  const gatewayActiveRef = useRef(gatewayState.isActive);
  gatewayActiveRef.current = gatewayState.isActive;
  // Ref à jour sur conversations — évite les stale closures dans les callbacks BLE async
  const conversationsRef = useRef<StoredConversation[]>([]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  // Ref à jour sur meshContacts BLE — évite stale closures dans callbacks async
  const meshContactsRef = useRef<MeshCoreContact[]>([]);
  useEffect(() => { meshContactsRef.current = ble.meshContacts; }, [ble.meshContacts]);
  const joinedForums = useRef<Set<string>>(new Set());
  const [joinedForumsList, setJoinedForumsList] = useState<string[]>([]);
  // PSKs chargées en mémoire : channelName → pskHex (évite les appels AsyncStorage dans les callbacks)
  const forumPsks = useRef<Map<string, string>>(new Map());
  // MeshRouter : deduplication + routing table + TTL (remplace le Set manuel)
  const meshRouterRef = useRef<MeshRouter | null>(null);
  // FIX #1: Deduplication — Set des IDs de messages récents (fallback si identity pas encore dispo)
  const recentMsgIds = useRef<Set<string>>(new Set());
  // Buffer paquets chiffrés reçus avant de connaître la pubkey du sender
  const pendingEncryptedPackets = useRef<Map<string, MeshCorePacket[]>>(new Map());
  // Timestamp d'arrivée du premier paquet bufferisé par nodeId (pour expiration)
  const pendingEncryptedTimestamps = useRef<Map<string, number>>(new Map());
  /** Durée max de buffering : 30 minutes. Après, on abandonne (pubkey jamais reçue). */
  const PENDING_PACKET_TTL_MS = 30 * 60 * 1000;
  // Nostr : unsub functions pour les forums souscrits (channelName → unsub)
  const nostrChannelUnsubs = useRef<Map<string, () => void>>(new Map());
  // Ref sur le handler Nostr channel — évite les stale closures dans les callbacks
  // (identity peut changer APRÈS la souscription → le handler doit toujours être à jour)
  const nostrChannelHandlerRef = useRef<((channelName: string, event: any) => void) | null>(null);
  const addToDedup = (id: string) => {
    recentMsgIds.current.add(id);
    if (recentMsgIds.current.size > 200) {
      // Supprimer le plus ancien (premier inséré)
      recentMsgIds.current.delete(recentMsgIds.current.values().next().value as string);
    }
  };

  // Initialiser / réinitialiser le MeshRouter quand l'identité change
  useEffect(() => {
    if (identity) {
      if (meshRouterRef.current) meshRouterRef.current.destroy();
      meshRouterRef.current = new MeshRouter(identity.nodeId);
      console.log('[MeshRouter] Initialisé pour nodeId:', identity.nodeId);
    }
    return () => {
      if (meshRouterRef.current) {
        meshRouterRef.current.destroy();
        meshRouterRef.current = null;
      }
    };
  }, [identity?.nodeId]);

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

  // Annoncer notre présence sur le mesh dès connexion BLE (MeshCore Companion standard)
  // sendSelfAdvert() = CMD_SEND_SELF_ADV (0x07) — compris par tout firmware MeshCore
  useEffect(() => {
    if (ble.connected && identity) {
      ble.sendSelfAdvert().catch(() => {});
      console.log('[MeshCore] SelfAdvert envoyé à la connexion BLE');
    }
  }, [ble.connected, identity]);

  // Handler pour paquets MeshCore entrants via BLE → LoRa
  const handleIncomingMeshCorePacket = useCallback(async (packet: MeshCorePacket) => {
    if (!identity) return;

    try {
      const fromNodeIdStr = uint64ToNodeId(packet.fromNodeId);
      console.log('[MeshCore] Paquet reçu via BLE:', {
        type: packet.type,
        fromNodeId: fromNodeIdStr,
        to: uint64ToNodeId(packet.toNodeId),
        ttl: packet.ttl,
      });

      // Deduplication via MeshRouter (TTL 5 min, nettoyage auto) ou Set fallback
      const msgKey = `${packet.messageId}-${fromNodeIdStr}`;
      if (meshRouterRef.current) {
        if (meshRouterRef.current.hasSeen(msgKey)) {
          console.log('[MeshCore] DROP: message déjà vu (MeshRouter dedup):', msgKey);
          return;
        }
        meshRouterRef.current.markSeen(msgKey);
        // Mettre à jour la routing table avec le voisin détecté
        meshRouterRef.current.updateNeighbor(fromNodeIdStr);
      } else {
        if (recentMsgIds.current.has(msgKey)) {
          console.log('[MeshCore] DROP: message déjà vu (fallback dedup):', msgKey);
          return;
        }
        addToDedup(msgKey);
      }

      // Vérifier que le paquet est pour nous (ou broadcast)
      const myNodeIdUint64 = nodeIdToUint64(identity.nodeId);
      if (packet.toNodeId !== myNodeIdUint64 && packet.toNodeId !== 0n) {
        // Forward to gateway if active (LoRa relay mode)
        // ✅ FIX: lire gatewayActiveRef.current au lieu de capturer gatewayState.isActive
        // Évite de recréer ce callback + de ré-enregistrer le handler BLE à chaque changement
        if (gatewayActiveRef.current) {
          const rawPayload = bytesToBase64(encodeMeshCorePacket(packet));
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
          // Résolution nodeId → conv existante (même logique que pour TEXT)
          const chunkPrefix8 = fromNodeId.slice(5).toUpperCase();
          let chunkConvId = fromNodeId;
          {
            const exactMatch = conversationsRef.current.find(c => c.id === fromNodeId);
            if (!exactMatch) {
              const pubkeyMatch = conversationsRef.current.find(
                c => c.peerPubkey && c.peerPubkey.slice(0, 8).toUpperCase() === chunkPrefix8
              );
              const bleMatch = !pubkeyMatch && meshContactsRef.current.find(
                c => c.pubkeyPrefix.slice(0, 8).toUpperCase() === chunkPrefix8
              );
              if (pubkeyMatch) chunkConvId = pubkeyMatch.id;
              else if (bleMatch) {
                const bleConv = conversationsRef.current.find(c => c.peerPubkey === bleMatch.pubkeyHex);
                if (bleConv) chunkConvId = bleConv.id;
              }
            }
          }
          let senderPubkey = '';
          const existingConv = conversationsRef.current.find(c => c.id === chunkConvId);
          if (existingConv?.peerPubkey) {
            senderPubkey = existingConv.peerPubkey;
          }

          // Déchiffrer le message reconstitué si le flag ENCRYPTED est actif
          let finalChunkText = result.message;
          if (packet.flags & MeshCoreFlags.ENCRYPTED) {
            if (senderPubkey) {
              try {
                const encBytes = base64ToBytes(result.message);
                const encPayload = decodeEncryptedPayload(encBytes);
                if (encPayload) {
                  finalChunkText = decryptDM(encPayload, identity.privkeyBytes, senderPubkey);
                  console.log('[MeshCore] Message chunké déchiffré avec succès');
                } else {
                  finalChunkText = '[Chunk chiffré invalide]';
                }
              } catch (decErr) {
                console.error('[MeshCore] Erreur déchiffrement chunk:', decErr);
                finalChunkText = '[Erreur déchiffrement]';
              }
            } else {
              finalChunkText = '[Chunk chiffré - clé publique inconnue]';
              console.warn('[MeshCore] Chunk ENCRYPTED reçu mais pubkey inconnue pour', chunkConvId);
            }
          }

          const msg: StoredMessage = {
            id: `chunk-${packet.messageId}`,
            conversationId: chunkConvId,
            fromNodeId: fromNodeId,
            fromPubkey: senderPubkey,
            text: finalChunkText,
            type: 'text',
            timestamp: packet.timestamp * 1000,
            isMine: false,
            status: 'delivered',
            transport: 'ble',
          };

          await saveMessage(msg);
          await updateConversationLastMessage(chunkConvId, finalChunkText.slice(0, 50), msg.timestamp, true);

          setMessagesByConv(prev => ({
            ...prev,
            [chunkConvId]: [...(prev[chunkConvId] ?? []), msg],
          }));

          // ACK géré par MeshCore Companion firmware — pas besoin d'en envoyer un
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
          // Résoudre vers une conv existante (par prefix pubkey ou ID exact)
          const rawPfx = fromNodeId.slice(5).toUpperCase();
          const resolvedKaConv = conversationsRef.current.find(c => c.id === fromNodeId)
            ?? conversationsRef.current.find(c => c.peerPubkey && c.peerPubkey.slice(0, 8).toUpperCase() === rawPfx)
            ?? conversationsRef.current.find(c => {
                const bc = meshContactsRef.current.find(m => m.pubkeyPrefix.slice(0, 8).toUpperCase() === rawPfx);
                return bc && c.peerPubkey === bc.pubkeyHex;
              });
          const kaConvId = resolvedKaConv?.id ?? fromNodeId;
          console.log('[MeshCore] Pubkey reçue via KEY_ANNOUNCE:', fromNodeId, '→ conv', kaConvId, pubkey.slice(0, 20) + '...');
          updateConversationPubkey(kaConvId, pubkey);

          // Retry des paquets bufferisés en attente de cette pubkey
          // Chercher dans le buffer par fromNodeId brut ET par kaConvId (résolu)
          const buffered = pendingEncryptedPackets.current.get(fromNodeId)
            ?? pendingEncryptedPackets.current.get(kaConvId);
          if (buffered && buffered.length > 0) {
            pendingEncryptedPackets.current.delete(fromNodeId);
            pendingEncryptedPackets.current.delete(kaConvId);
            pendingEncryptedTimestamps.current.delete(fromNodeId);
            pendingEncryptedTimestamps.current.delete(kaConvId);
            console.log(`[MeshCore] Retry ${buffered.length} paquet(s) bufferisé(s) pour ${fromNodeId} → conv ${kaConvId}`);
            for (const bufferedPkt of buffered) {
              try {
                const enc = decodeEncryptedPayload(bufferedPkt.payload);
                if (!enc) continue;
                const plaintext = decryptDM(enc, identity.privkeyBytes, pubkey);
                const msgId = `mc-${bufferedPkt.messageId}`;
                const msg: StoredMessage = {
                  id: msgId,
                  conversationId: kaConvId,
                  fromNodeId,
                  fromPubkey: pubkey,
                  text: plaintext,
                  type: 'text',
                  timestamp: bufferedPkt.timestamp * 1000,
                  isMine: false,
                  status: 'delivered',
                };
                await saveMessage(msg);
                await updateConversationLastMessage(kaConvId, plaintext.slice(0, 50), msg.timestamp, true);
                setMessagesByConv(prev => ({
                  ...prev,
                  [kaConvId]: [...(prev[kaConvId] ?? []), msg],
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
        // ── Canal LoRa (broadcast forum) : deliverCompanionTextPacket → fromNodeId = 0n ──
        // subMeshId = channelIdx (0 = "public", 1 = 2ème forum rejoint, etc.)
        if (packet.fromNodeId === 0n) {
          const channelIdx = (packet as any).subMeshId ?? 0;
          const forumList = [...joinedForums.current];
          const channelName = forumList[channelIdx] ?? forumList[0] ?? 'public';
          const convId = `forum:${channelName}`;
          let plaintext = extractTextFromPacket(packet);
          // Déchiffrer si forum privé (PSK connue)
          const psk = forumPsks.current.get(channelName);
          if (psk) {
            try {
              const parsed = JSON.parse(plaintext) as { v: number; nonce: string; ct: string };
              plaintext = decryptForumWithKey(parsed, psk);
            } catch { /* message en clair ou PSK incorrecte — garder tel quel */ }
          }
          const msgId = `mc-ch-${packet.messageId}`;

          if (recentMsgIds.current.has(msgId)) return;
          addToDedup(msgId);

          const msg: StoredMessage = {
            id: msgId,
            conversationId: convId,
            fromNodeId: 'lora',
            fromPubkey: '',
            text: plaintext,
            type: 'text',
            timestamp: packet.timestamp * 1000,
            isMine: false,
            status: 'delivered',
            transport: 'lora',
          };
          await saveMessage(msg);
          await updateConversationLastMessage(convId, `📡 ${plaintext.slice(0, 48)}`, msg.timestamp, true);
          setMessagesByConv(prev => ({
            ...prev,
            [convId]: [...(prev[convId] ?? []), msg],
          }));
          setConversations(prev => prev.map(c =>
            c.id === convId
              ? { ...c, lastMessage: `📡 ${plaintext.slice(0, 48)}`, lastMessageTime: msg.timestamp, unreadCount: c.unreadCount + 1 }
              : c
          ));
          notifyForumMessage(channelName, '📡 LoRa', plaintext).catch(() => {});
          console.log('[MeshCore] Canal LoRa → forum:', channelName, '|', plaintext.slice(0, 40));
          return;
        }

        const fromNodeId = uint64ToNodeId(packet.fromNodeId);

        // ── FIX BUG 4: Résolution nodeId → conversation existante ─────────────
        // fromNodeId = "MESH-XXXXXXXX" (4 premiers octets de la clé MeshCore brute,
        // via pubkeyPrefix des 6 octets du champ senderPubkeyPrefix du firmware).
        // Les conversations créées depuis l'UI ou Nostr peuvent avoir un ID différent.
        // On cherche d'abord une conv par ID exact, puis par pubkeyPrefix correspondant.
        const rawPrefix8 = fromNodeId.slice(5).toUpperCase(); // 8 hex chars = 4 bytes
        let resolvedConvId = fromNodeId;
        {
          const exactMatch = conversationsRef.current.find(c => c.id === fromNodeId);
          if (!exactMatch) {
            // Chercher par peerPubkey : pubkey BLE brute (64 hex), premiers 8 = 4 bytes
            const pubkeyMatch = conversationsRef.current.find(
              c => c.peerPubkey && c.peerPubkey.slice(0, 8).toUpperCase() === rawPrefix8
            );
            if (pubkeyMatch) {
              resolvedConvId = pubkeyMatch.id;
              console.log(`[MeshCore] ✅ NodeId résolu: ${fromNodeId} → conv "${resolvedConvId}" (via peerPubkey)`);
            } else {
              // Chercher par contacts BLE découverts (pubkeyPrefix = 6 bytes = 12 hex)
              const bleContact = meshContactsRef.current.find(
                c => c.pubkeyPrefix.slice(0, 8).toUpperCase() === rawPrefix8
              );
              if (bleContact) {
                // Le contact existe mais pas encore de conv — on garde fromNodeId
                // (la conv sera créée ci-dessous ou par l'effet auto-create)
                console.log(`[MeshCore] Contact BLE trouvé pour ${fromNodeId}: "${bleContact.name}" — conv à créer`);
              }
            }
          }
        }
        // ────────────────────────────────────────────────────────────────────

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

          // Récupérer la pubkey du sender depuis la conversation résolue
          const conv = conversationsRef.current.find(c => c.id === resolvedConvId);
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
            if (existing.length < 50) {
              pendingEncryptedPackets.current.set(fromNodeId, [...existing, packet]);
              // Enregistrer le timestamp du premier paquet bufferisé pour ce nodeId
              if (!pendingEncryptedTimestamps.current.has(fromNodeId)) {
                pendingEncryptedTimestamps.current.set(fromNodeId, now);
              }
              console.warn(`[MeshCore] Pubkey inconnue pour ${fromNodeId} — paquet bufferisé (${existing.length + 1}/5)`);
            }
            // Envoyer SelfAdvert pour annoncer notre présence (MeshCore Companion)
            ble.sendSelfAdvert().catch(err =>
              console.warn('[MeshCore] Erreur SelfAdvert (demande pubkey pair):', err)
            );
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

        // Résoudre le nom du contact depuis les contacts BLE si la conv est nouvelle
        const bleContactForName = meshContactsRef.current.find(
          c => c.pubkeyPrefix.slice(0, 8).toUpperCase() === rawPrefix8
        );
        const peerName = bleContactForName?.name ?? resolvedConvId;

        const msgTs = packet.timestamp * 1000; // MeshCore utilise secondes, on veut ms

        // ── FIX: Créer la conversation AVANT de sauver le message ──────────
        // Garantit la cohérence DB (conversation doit exister avant message)
        const convExistsBefore = conversationsRef.current.find(c => c.id === resolvedConvId);
        if (!convExistsBefore) {
          const newConv: StoredConversation = {
            id: resolvedConvId,
            name: peerName,
            isForum: false,
            peerPubkey: senderPubkey || bleContactForName?.pubkeyHex || undefined,
            lastMessage: plaintext.slice(0, 50),
            lastMessageTime: msgTs,
            unreadCount: 1,
            online: true,
          };
          try {
            await saveConversation(newConv);
          } catch (convErr) {
            console.error('[MeshCore] Erreur création conversation:', convErr);
          }
          setConversations(prev => {
            if (prev.find(c => c.id === resolvedConvId)) return prev;
            return [newConv, ...prev];
          });
        }

        const msg: StoredMessage = {
          id: `mc-${packet.messageId}`,
          conversationId: resolvedConvId,
          fromNodeId: fromNodeId,
          fromPubkey: senderPubkey,
          text: plaintext,
          type: 'text',
          timestamp: msgTs,
          isMine: false,
          status: 'delivered',
          transport: 'ble',
        };

        await saveMessage(msg);
        await updateConversationLastMessage(resolvedConvId, plaintext.slice(0, 50), msgTs, true);

        // ACK géré par MeshCore Companion firmware
        setMessagesByConv(prev => ({
          ...prev,
          [resolvedConvId]: [...(prev[resolvedConvId] ?? []), msg],
        }));

        // Mettre à jour la conversation si elle existait déjà
        if (convExistsBefore) {
          setConversations(prev => prev.map(c => {
            if (c.id !== resolvedConvId) return c;
            return {
              ...c,
              lastMessage: plaintext.slice(0, 50),
              lastMessageTime: msgTs,
              unreadCount: c.unreadCount + 1,
              peerPubkey: senderPubkey || bleContactForName?.pubkeyHex || c.peerPubkey,
              online: true,
            };
          }));
        }

        console.log(`[MeshCore] ✅ Message TEXT livré depuis ${fromNodeId} → conv "${resolvedConvId}"`);
      } else if (packet.type === MeshCoreMessageType.ACK) {
        // ✅ Traiter l'ACK reçu (confirmation de livraison)
        const fromNodeId = uint64ToNodeId(packet.fromNodeId);
        const { extractAckInfo } = await import('@/utils/meshcore-protocol');
        const ackInfo = extractAckInfo(packet.payload);
        
        if (ackInfo) {
          console.log('[MeshCore] ACK reçu pour message', ackInfo.originalMessageId, 'depuis', fromNodeId);

          // ✅ FIX: Chercher dans TOUTES les conversations, pas seulement prev[fromNodeId].
          // La conversation peut avoir été résolue sous un ID différent du fromNodeId brut
          // (ex: conversation créée avec un nodeId résolu via peerPubkey ou contact BLE).
          const msgId = `mc-${ackInfo.originalMessageId}`;
          setMessagesByConv(prev => {
            const next = { ...prev };
            let found = false;
            for (const convId of Object.keys(next)) {
              const messages = next[convId];
              if (messages.some(m => m.id === msgId || m.id.endsWith(`-${ackInfo.originalMessageId}`))) {
                next[convId] = messages.map(m =>
                  (m.id === msgId || m.id.endsWith(`-${ackInfo.originalMessageId}`))
                    ? { ...m, status: 'delivered' as const }
                    : m
                );
                found = true;
                break; // un message ne peut être que dans une conversation
              }
            }
            if (!found) {
              console.warn('[MeshCore] ACK : message introuvable dans aucune conv:', msgId);
            }
            return next;
          });
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
  }, [identity, handleLoRaMsg]); // stable — gatewayState.isActive lu via gatewayActiveRef

  // Enregistrer le handler BLE dès que possible + annoncer notre clé publique
  useEffect(() => {
    if (ble.connected && identity) {
      console.log('[MeshCore] Connexion BLE établie, enregistrement handler');
      ble.onPacket(handleIncomingMeshCorePacket);

      // Après enregistrement du handler, le BleGatewayClient rejoue automatiquement
      // les paquets bufferisés (pendingPackets). On appelle aussi syncNextMessage()
      // pour récupérer les messages restants dans la file firmware.
      const client = getBleGatewayClient();
      setTimeout(() => {
        client.syncNextMessage()
          .then(() => console.log('[MeshCore] syncNextMessage post-handler OK'))
          .catch(() => { /* RESP_NO_MORE_MSGS = normal */ });
      }, 500); // 500ms pour laisser le temps au replay des pendingPackets

      // Annoncer notre présence via SelfAdvert (CMD 0x07 — compris par MeshCore Companion)
      ble.sendSelfAdvert()
        .then(() => console.log('[MeshCore] SelfAdvert envoyé (broadcast)'))
        .catch(err => console.warn('[MeshCore] Erreur SelfAdvert:', err));
    }
  }, [ble.connected, identity, handleIncomingMeshCorePacket]);

  // ✅ Enregistrer le handler USB Serial (transport alternatif au BLE)
  // UsbSerialProvider utilise un ref interne — onPacket() est idempotent et bon marché.
  useEffect(() => {
    if (usbSerial.connected && identity) {
      console.log('[MeshCore] Connexion USB Serial établie, enregistrement handler');
      usbSerial.onPacket(handleIncomingMeshCorePacket);
    }
  }, [usbSerial.connected, identity, handleIncomingMeshCorePacket]);

  // Polling périodique des messages en file (filet de sécurité si PUSH_MSG_WAITING manqué)
  // Le firmware peut parfois ne pas envoyer PUSH_MSG_WAITING (firmware edge case, BLE restart...)
  useEffect(() => {
    if (!ble.connected) return;
    const client = getBleGatewayClient();
    const POLL_INTERVAL_MS = 30_000; // 30 secondes
    const timer = setInterval(() => {
      client.syncNextMessage()
        .then(() => console.log('[MeshCore] Polling 30s syncNextMessage OK'))
        .catch(() => { /* RESP_NO_MORE_MSGS = file vide, normal */ });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ble.connected]);

  // Auto-join forum "public" dès connexion BLE — canal 0, broadcast LoRa (CMD_SEND_CHAN_MSG)
  // joinForum est idempotente : vérifie existing avant de créer, skipAnnounce évite kind:40 Nostr
  useEffect(() => {
    if (!ble.connected) return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    joinForum('public', 'Canal public MeshCore', undefined, true)
      .catch(err => console.warn('[MeshCore] Auto-join public forum:', err));
  // ble.connected only — joinForum est stable et idempotente, pas besoin de re-run sur chaque conversation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ble.connected]);

  // ── FIX BUG 4 (partie 2) : Auto-créer conversations pour contacts BLE ─────────
  // Garantit que quand un message arrive (fromNodeId = "MESH-XXXXXXXX"),
  // une conversation avec cet ID exact existe déjà → routage correct immédiat.
  // Aussi wire up registerPeer → RadarProvider voit les pairs LoRa/BLE.
  useEffect(() => {
    if (!ble.meshContacts.length || !identity) return;

    const newConvs: StoredConversation[] = [];

    for (const contact of ble.meshContacts) {
      if (!contact.pubkeyPrefix || contact.pubkeyPrefix.length < 8) continue;

      // ID MeshCore basé sur 4 premiers octets de la pubkeyPrefix (= senderPubkeyPrefix firmware)
      const meshNodeId = 'MESH-' + contact.pubkeyPrefix.slice(0, 8).toUpperCase();

      // Ignorer notre propre nodeId
      if (meshNodeId === identity.nodeId) continue;

      // Enregistrer le pair dans GatewayProvider → apparaît dans RadarProvider LoRa
      registerPeer({
        nodeId: meshNodeId,
        name: contact.name || meshNodeId,
        lastSeen: contact.lastSeen * 1000 || Date.now(),
        signalStrength: -80, // valeur par défaut — RSSI réel non connu depuis contact list
        hops: 1,
      } as GatewayPeer);

      // Vérifier si une conversation existe déjà pour ce contact
      const existingByMeshId = conversationsRef.current.find(c => c.id === meshNodeId);
      const existingByPubkey = !existingByMeshId && conversationsRef.current.find(
        c => c.peerPubkey && c.peerPubkey.slice(0, 8).toUpperCase() === contact.pubkeyPrefix.slice(0, 8).toUpperCase()
      );

      if (existingByMeshId) {
        // Mettre à jour le peerPubkey si manquant
        if (!existingByMeshId.peerPubkey && contact.pubkeyHex) {
          updateConversationPubkey(meshNodeId, contact.pubkeyHex);
          setConversations(prev => prev.map(c =>
            c.id === meshNodeId ? { ...c, peerPubkey: contact.pubkeyHex } : c
          ));
        }
        continue;
      }

      if (existingByPubkey) continue; // Conv déjà présente avec un autre ID — ne pas dupliquer

      // Créer une nouvelle conversation pour ce contact BLE
      const newConv: StoredConversation = {
        id: meshNodeId,
        name: contact.name || meshNodeId,
        isForum: false,
        peerPubkey: contact.pubkeyHex || undefined,
        lastMessage: '',
        lastMessageTime: 0,
        unreadCount: 0,
        online: true,
      };
      newConvs.push(newConv);
      console.log(`[BLE] ✅ Conversation auto-créée pour contact: "${contact.name}" → ${meshNodeId}`);
    }

    if (newConvs.length > 0) {
      for (const conv of newConvs) {
        saveConversation(conv);
      }
      setConversations(prev => {
        const newIds = new Set(newConvs.map(c => c.id));
        const filtered = prev.filter(c => !newIds.has(c.id));
        return [...newConvs, ...filtered];
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ble.meshContacts, identity?.nodeId]);

  // Charger les conversations depuis AsyncStorage
  useEffect(() => {
    listConversations().then(convs => {
      setConversations(convs);
    });
  }, []); // ✅ Aucune dépendance externe - fonction stable

  // Charger les forums persistés + leurs PSKs au démarrage
  useEffect(() => {
    AsyncStorage.getItem(JOINED_FORUMS_KEY).then(async raw => {
      if (!raw) return;
      try {
        const saved: string[] = JSON.parse(raw);
        saved.forEach(ch => joinedForums.current.add(ch));
        setJoinedForumsList([...joinedForums.current]);
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

    // Déduplication via MeshRouter si disponible, sinon fallback Set
    if (meshRouterRef.current) {
      if (meshRouterRef.current.hasSeen(event.id)) return;
      meshRouterRef.current.markSeen(event.id);
    } else {
      if (recentMsgIds.current.has(event.id)) return;
      addToDedup(event.id);
    }

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
        // FIX: Ne pas dropper silencieusement — afficher un placeholder
        // Le message existe sur le relay, l'utilisateur doit savoir qu'il est chiffré
        plaintext = '[Message chiffré — clé incorrecte ou format inconnu]';
        console.warn('[Forum] Déchiffrement PSK échoué pour', channelName, '— affiché comme chiffré');
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
      transport: 'nostr',
    };

    saveMessage(msg).catch(() => {});
    const preview = `${fromId.slice(0, 8)}: ${plaintext.slice(0, 40)}`;
    updateConversationLastMessage(convId, preview, ts, true).catch(() => {});
    notifyForumMessage(channelName, fromId.slice(0, 10), plaintext).catch(() => {});

    setMessagesByConv(prev => ({
      ...prev,
      [convId]: [...(prev[convId] ?? []), msg],
    }));

    setConversations(prev =>
      prev.map(c => c.id === convId
        ? {
            ...c,
            lastMessage: preview,
            lastMessageTime: ts,
            unreadCount: c.unreadCount + 1,
          }
        : c,
      )
    );

    console.log('[Nostr→Forum]', channelName, '—', fromId.slice(0, 12), ':', event.content.slice(0, 40));
  }, [identity]); // ✅ Dépendance complète

  // Synchroniser le ref pour que les callbacks de subscription utilisent toujours le handler à jour
  useEffect(() => {
    nostrChannelHandlerRef.current = handleIncomingNostrChannelMessage;
  }, [handleIncomingNostrChannelMessage]);

  // ── Réabonnement Nostr aux forums quand la connexion est rétablie ────────────

  useEffect(() => {
    if (!nostrConnected) {
      // Déconnecter proprement les subs Nostr
      for (const unsub of nostrChannelUnsubs.current.values()) unsub();
      nostrChannelUnsubs.current.clear();
      return;
    }

    // Réabonner à TOUS les forums déjà rejoints via le ref (toujours à jour)
    // Le ref nostrChannelHandlerRef pointe toujours sur le handleIncomingNostrChannelMessage
    // avec la dernière identity → pas de stale closure possible.
    for (const channelName of joinedForums.current) {
      if (nostrChannelUnsubs.current.has(channelName)) continue; // déjà abonné
      const channelId = deriveChannelId(channelName);
      const unsub = nostrClient.subscribeChannel(channelId, (event) => {
        // ✅ FIX STALE CLOSURE: utilise le ref au lieu du callback direct
        nostrChannelHandlerRef.current?.(channelName, event);
      });
      nostrChannelUnsubs.current.set(channelName, unsub);
      console.log('[Messages] Nostr forum réabonné:', channelName, channelId.slice(0, 16) + '…');
    }
  }, [nostrConnected]);

  // ── Abonnement DMs Nostr entrants (NIP-17 Gift Wrap + NIP-04 fallback) ──────
  const nostrDMUnsubRef = useRef<(() => void)[]>([]);
  const nostrDMHandlerRef = useRef<((from: string, content: string, event: any) => void) | null>(null);

  // Handler pour DMs entrants (NIP-17 + NIP-04) — utilise un ref pour éviter les stale closures
  const handleIncomingNostrDM = useCallback((
    from: string, content: string, event: { id: string; pubkey: string; created_at: number },
  ) => {
    if (!identity) return;

    // Deduplication
    if (meshRouterRef.current) {
      if (meshRouterRef.current.hasSeen(event.id)) return;
      meshRouterRef.current.markSeen(event.id);
    } else {
      if (recentMsgIds.current.has(event.id)) return;
      addToDedup(event.id);
    }

    // Résoudre la conversation : chercher par peerPubkey (x-only 64 hex)
    const senderPubkey = from.length === 66 ? from.slice(2) : from;
    let resolvedConvId = `nostr:${senderPubkey.slice(0, 12)}`;
    const existingConv = conversationsRef.current.find(c => {
      if (!c.peerPubkey) return false;
      const convPk = c.peerPubkey.length === 66 ? c.peerPubkey.slice(2) : c.peerPubkey;
      return convPk === senderPubkey;
    });
    if (existingConv) {
      resolvedConvId = existingConv.id;
    }

    const ts = event.created_at * 1000;
    const msgId = `nostr-dm-${event.id}`;

    // Créer la conversation si elle n'existe pas
    if (!existingConv) {
      const newConv: StoredConversation = {
        id: resolvedConvId,
        name: `nostr:${senderPubkey.slice(0, 8)}`,
        isForum: false,
        peerPubkey: senderPubkey,
        lastMessage: content.slice(0, 50),
        lastMessageTime: ts,
        unreadCount: 1,
        online: true,
      };
      saveConversation(newConv).catch(() => {});
      setConversations(prev => {
        if (prev.find(c => c.id === resolvedConvId)) return prev;
        return [newConv, ...prev];
      });
    }

    const msg: StoredMessage = {
      id: msgId,
      conversationId: resolvedConvId,
      fromNodeId: senderPubkey.slice(0, 12),
      fromPubkey: senderPubkey,
      text: content,
      type: 'text',
      timestamp: ts,
      isMine: false,
      status: 'delivered',
      transport: 'nostr',
    };

    saveMessage(msg).catch(() => {});
    updateConversationLastMessage(resolvedConvId, content.slice(0, 50), ts, true).catch(() => {});

    setMessagesByConv(prev => ({
      ...prev,
      [resolvedConvId]: [...(prev[resolvedConvId] ?? []), msg],
    }));

    if (existingConv) {
      setConversations(prev => prev.map(c =>
        c.id === resolvedConvId
          ? { ...c, lastMessage: content.slice(0, 50), lastMessageTime: ts, unreadCount: c.unreadCount + 1 }
          : c
      ));
    }

    console.log(`[Nostr→DM] Message reçu de ${senderPubkey.slice(0, 12)} → conv "${resolvedConvId}"`);
  }, [identity]);

  useEffect(() => {
    nostrDMHandlerRef.current = handleIncomingNostrDM;
  }, [handleIncomingNostrDM]);

  useEffect(() => {
    // Cleanup previous subs
    for (const unsub of nostrDMUnsubRef.current) unsub();
    nostrDMUnsubRef.current = [];

    if (!nostrConnected || !nostrClient.isConnected) return;

    try {
      // NIP-17 Gift Wrap (kind:1059) — sealed sender DMs
      const unsubSealed = nostrClient.subscribeDMsSealed((from, content, event) => {
        nostrDMHandlerRef.current?.(from, content, event);
      });
      nostrDMUnsubRef.current.push(unsubSealed);
      console.log('[Messages] Nostr DMs NIP-17 (sealed) abonnés');
    } catch (err) {
      console.warn('[Messages] Erreur abonnement NIP-17 DMs:', err);
    }

    try {
      // NIP-04 fallback (kind:4) — legacy DMs
      const unsubLegacy = nostrClient.subscribeDMs((from, content, event) => {
        nostrDMHandlerRef.current?.(from, content, event);
      });
      nostrDMUnsubRef.current.push(unsubLegacy);
      console.log('[Messages] Nostr DMs NIP-04 (legacy) abonnés');
    } catch (err) {
      console.warn('[Messages] Erreur abonnement NIP-04 DMs:', err);
    }

    return () => {
      for (const unsub of nostrDMUnsubRef.current) unsub();
      nostrDMUnsubRef.current = [];
    };
  }, [nostrConnected]);

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
  }, []); // ✅ Aucune dépendance - fonctionne au montage uniquement

  // ✅ NOUVEAU : Vérification périodique des tokens unverified (P2)
  // ✅ OPTIMISATION: useCallback pour la fonction de vérification
  const verifyUnverifiedTokens = useCallback(async () => {
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
          // Un token est marqué comme vérifié uniquement s'il est valide ET vérifié cryptographiquement
          if (verification.valid && verification.verified) {
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
  }, []); // ✅ Pas de dépendances externes

  useEffect(() => {
    // Vérifier toutes les 5 minutes
    const interval = setInterval(verifyUnverifiedTokens, 5 * 60 * 1000);
    
    // Vérification immédiate au démarrage
    setTimeout(verifyUnverifiedTokens, 10000);
    
    return () => clearInterval(interval);
  }, [verifyUnverifiedTokens]); // ✅ Dépendance stable

  // Publier un message sur le réseau + le sauvegarder localement (déclaré avant sendMessage)
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
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
  }, []); // ✅ FIX: Aucune dépendance externe - fonction pure de stockage

  // Envoyer un message (DM ou forum)
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
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
    // Forums : BLE (flood LoRa) ou Nostr — au moins un doit être dispo
    if (isForum_ && !ble.connected && !nostrClient.isConnected) {
      throw new Error('Forums indisponibles — connectez un gateway BLE ou Nostr');
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

    // Utiliser chunking si message trop long — uniquement DM hors BLE (BitMesh/autre)
    // En mode BLE (MeshCore Companion), la fragmentation UART est transparente
    if (!isForum && !ble.connected && chunkManagerRef.current.needsChunking(text)) {
      console.log('[Messages] Utilisation du chunking pour message long');

      // Chiffrer AVANT le chunking si la pubkey du pair est connue
      const convForChunk = conversations.find(c => c.id === convId);
      let textToChunk = text;
      let chunkEncrypted = false;
      if (convForChunk?.peerPubkey && ble.connected) {
        try {
          const enc = encryptDM(text, id.privkeyBytes, convForChunk.peerPubkey);
          const encBytes = encodeEncryptedPayload(enc);
          textToChunk = bytesToBase64(encBytes);
          chunkEncrypted = true;
          console.log('[Messages] Chunk: payload chiffré avant découpage');
        } catch (encErr) {
          console.warn('[Messages] Chunk: chiffrement échoué, envoi en clair:', encErr);
        }
      }

      const result = await chunkManagerRef.current.sendMessageWithChunking(
        textToChunk,
        id.nodeId,
        convId,
        async (packet) => {
          if (ble.connected) {
            await ble.sendPacket(packet);
          } else {
            throw new Error('BLE non connecté');
          }
        },
        chunkEncrypted
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

      // Broadcast LoRa (flood) via MeshCore Companion — CMD_SEND_CHAN_MSG (0x03)
      if (ble.connected) {
        try {
          await ble.sendChannelMessage(text);
          console.log('[MeshCore] Broadcast flood canal LoRa:', channelName);
        } catch (bleErr) {
          console.warn('[MeshCore] Flood BLE échoué (Nostr fallback):', bleErr);
        }
      }

      // Chiffrer avec PSK si forum privé
      const psk = forumPsks.current.get(channelName);
      const payload = psk
        ? JSON.stringify(encryptForumWithKey(text, psk))
        : text;

      // Nostr (NIP-28 kind:42 sur channel déterministe)
      if (nostrClient.isConnected) {
        const channelId = deriveChannelId(channelName);
        await nostrClient.publishChannelMessage(channelId, payload);
      }
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
      // Protocole natif MeshCore Companion — CMD_SEND_TXT_MSG (0x02)
      await ble.sendDirectMessage(conv.peerPubkey, text);
      console.log('[MeshCore] DM envoyé via CMD_SEND_TXT_MSG → Companion:', convId);
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
  }, [identity, conversations, publishAndStore, ble.connected]); // ✅ Toutes les dépendances

  // Envoyer un message vocal (base64 m4a)
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
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
  }, [identity, conversations]); // ✅ nostrClient retiré - utilisation de la méthode statique

  // Envoyer une image (base64 jpeg/png)
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
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
  }, [identity, conversations]); // ✅ nostrClient retiré - utilisation de la méthode statique

  // Envoyer un Cashu token
  // ✅ OPTIMISATION: useCallback avec dépendance stable
  const sendCashu = useCallback(async (
    convId: string,
    token: string,
    amountSats: number
  ): Promise<void> => {
    await sendMessage(convId, token, 'cashu');
  }, [sendMessage]); // ✅ Dépendance stable

  // Charger les messages d'une conversation depuis AsyncStorage
  // ✅ OPTIMISATION: useCallback sans dépendances (fonction stable)
  const loadConversationMessages = useCallback(async (convId: string): Promise<void> => {
    try {
      const msgs = await loadMessages(convId);
      setMessagesByConv(prev => ({ ...prev, [convId]: msgs }));
      console.log('[Messages] Messages chargés pour:', convId, '-', msgs.length, 'messages');
    } catch (err) {
      console.error('[Messages] Erreur chargement messages:', err);
      // Ne pas bloquer l'UI, juste loguer l'erreur
    }
  }, []); // ✅ Aucune dépendance externe - fonction stable

  // Démarrer une nouvelle conversation DM
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
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
  }, [conversations]); // ✅ Dépendance complète

  // Rejoindre un forum
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
  const joinForum = useCallback(async (channelName: string, description?: string, pskHex?: string, skipAnnounce?: boolean): Promise<void> => {
    const convId = `forum:${channelName}`;
    joinedForums.current.add(channelName);
    setJoinedForumsList([...joinedForums.current]);
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
        // ✅ FIX STALE CLOSURE: utilise le ref pour toujours avoir le handler avec identity à jour
        nostrChannelHandlerRef.current?.(channelName, event);
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
  // handleIncomingNostrChannelMessage retiré des deps car on utilise le ref (nostrChannelHandlerRef)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  // ✅ NOUVEAU : Mettre à jour le display name
  // ✅ OPTIMISATION: useCallback avec dépendances complètes
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
  // ✅ OPTIMISATION: useCallback sans dépendances (fonction stable)
  const leaveForum = useCallback((channelName: string): void => {
    joinedForums.current.delete(channelName);
    setJoinedForumsList([...joinedForums.current]);
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
  // ✅ OPTIMISATION: useCallback sans dépendances (fonction stable)
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
  }, []); // ✅ Aucune dépendance externe - fonction stable

  // --- Contacts ---
  // ✅ OPTIMISATION: useCallback sans dépendances (fonction stable)
  const refreshContacts = useCallback(async () => {
    const list = await getContacts();
    setContacts(list);
  }, []); // ✅ Aucune dépendance externe - fonction stable

  useEffect(() => { refreshContacts(); }, []);

  // ✅ OPTIMISATION: useCallback avec dépendances complètes
  const addContact = useCallback(async (nodeId: string, displayName: string, pubkeyHex?: string) => {
    await saveContact({ nodeId, displayName, pubkeyHex, isFavorite: false });
    await refreshContacts();
  }, [refreshContacts]); // ✅ Dépendance stable

  // ✅ OPTIMISATION: useCallback avec dépendances complètes
  const removeContact = useCallback(async (nodeId: string) => {
    await deleteContact(nodeId);
    await refreshContacts();
  }, [refreshContacts]); // ✅ Dépendance stable

  // ✅ OPTIMISATION: useCallback avec dépendances complètes
  const toggleFavorite = useCallback(async (nodeId: string) => {
    await toggleContactFavorite(nodeId);
    await refreshContacts();
  }, [refreshContacts]); // ✅ Dépendance stable

  // Supprimer un message localement
  // ✅ OPTIMISATION: useCallback sans dépendances (fonction stable)
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
  }, []); // ✅ Aucune dépendance externe - fonction stable

  // Supprimer une conversation et tous ses messages (cascade DB)
  // ✅ OPTIMISATION: useCallback sans dépendances (fonction stable)
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
  }, []); // ✅ Aucune dépendance externe - fonction stable

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

  // Bridge Nostr → LoRa : reçoit les paquets LoRa relayés via Nostr (type='lora')
  // et les réinjecte dans le pipeline handleIncomingMeshCorePacket.
  useEffect(() => {
    const unsub = messagingBus.subscribe((msg) => {
      if (msg.type !== 'lora') return;

      const bytes = base64ToBytes(msg.content);
      const packet = decodeMeshCorePacket(bytes);
      if (!packet) {
        console.warn('[Nostr→LoRa] Paquet invalide ignoré (CRC/format)');
        return;
      }

      console.log('[Nostr→LoRa] Paquet reçu via relay Nostr, type:', packet.type);
      handleIncomingMeshCorePacket(packet);
    });

    return unsub;
  }, [handleIncomingMeshCorePacket]);

  // ✅ OPTIMISATION: useMemo pour l'objet retourné (évite les re-renders des consommateurs)
  const value = useMemo(() => ({
    identity,
    conversations,
    messagesByConv,
    sendMessage,
    sendAudio,
    sendImage,
    sendCashu,
    loadConversationMessages,
    startConversation,
    joinedForumsList,
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
  }), [
    identity,
    conversations,
    messagesByConv,
    sendMessage,
    sendAudio,
    sendImage,
    sendCashu,
    loadConversationMessages,
    startConversation,
    joinedForumsList,
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
  ]);

  return value;
});

// Extraire le montant d'un Cashu token (approximatif depuis le texte)
function parseCashuAmount(text: string): number | undefined {
  try {
    if (!text || !text.startsWith('cashuA')) return undefined;
    const base64 = text.slice(6);
    // Utiliser try/catch spécifique pour atob qui peut throw
    let jsonStr: string;
    try {
      jsonStr = atob(base64);
    } catch {
      return undefined;
    }
    const json = JSON.parse(jsonStr);
    let total = 0;
    for (const entry of json.token ?? []) {
      for (const proof of entry.proofs ?? []) {
        total += proof.amount ?? 0;
      }
    }
    return total || undefined;
  } catch (err) {
    console.warn('[parseCashuAmount] Erreur parsing:', err);
    return undefined;
  }
}
