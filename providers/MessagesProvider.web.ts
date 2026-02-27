import { useEffect, useState, useRef, useCallback } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useWalletSeed } from '@/providers/WalletSeedProvider';
import { useGateway } from '@/providers/GatewayProvider';
import { deriveMeshIdentity } from '@/utils/identity';
import {
  type MeshMqttClient,
  createMeshMqttClient,
  publishMesh,
  subscribeMesh,
  disconnectMesh,
  joinForumChannel,
  leaveForumChannel,
  subscribeForumAnnouncements,
  announceForumChannel,
  TOPICS,
  type ForumAnnouncement,
} from '@/utils/mqtt-client';

export type MessageType = 'text' | 'cashu' | 'btc_tx' | 'lora' | 'audio' | 'image' | 'gif';

export interface StoredMessage {
  id: string;
  conversationId: string;
  fromNodeId: string;
  fromPubkey: string;
  text: string;
  type: MessageType;
  timestamp: number;
  isMine: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  cashuAmount?: number;
  cashuToken?: string;
  btcAmount?: number;
  compressed?: boolean;
}

export interface StoredConversation {
  id: string;
  name: string;
  isForum: boolean;
  peerPubkey?: string;
  lastMessage?: string;
  lastMessageTime: number;
  unreadCount: number;
  online: boolean;
}

export interface DBContact {
  nodeId: string;
  displayName: string;
  pubkeyHex?: string;
  notes?: string;
  isFavorite: boolean;
  addedAt: number;
  updatedAt: number;
}

export interface RadarPeer {
  nodeId: string;
  name: string;
  distance: number;
  bearing: number;
  signalStrength: number;
  lat?: number;
  lng?: number;
  lastSeen: number;
}

export interface MeshIdentity {
  nodeId: string;
  pubkeyHex: string;
  privkeyHex: string;
  displayName: string;
}

export interface MessagesState {
  identity: MeshIdentity | null;
  mqttState: 'disconnected' | 'connecting' | 'connected' | 'error';
  conversations: StoredConversation[];
  messagesByConv: Record<string, StoredMessage[]>;
  radarPeers: RadarPeer[];
  myLocation: { lat: number; lng: number } | null;
  discoveredForums: ForumAnnouncement[];
  connect: () => void;
  disconnect: () => void;
  reconnectMqtt: () => void;
  sendMessage: (convId: string, text: string, type?: MessageType) => Promise<void>;
  sendAudio: (convId: string, base64: string, durationMs: number) => Promise<void>;
  sendImage: (convId: string, base64: string, mimeType: string) => Promise<void>;
  sendCashu: (convId: string, token: string, amountSats: number) => Promise<void>;
  loadConversationMessages: (convId: string) => Promise<void>;
  startConversation: (peerNodeId: string, peerName?: string) => Promise<void>;
  joinForum: (channelName: string, description?: string) => Promise<void>;
  leaveForum: (channelName: string) => void;
  markRead: (convId: string) => Promise<void>;
  announceForumPublic: (channelName: string, description: string) => boolean;
  setDisplayName: (name: string) => Promise<void>;
  deleteMessage: (msgId: string, convId: string) => Promise<void>;
  deleteConversation: (convId: string) => Promise<void>;
  contacts: DBContact[];
  addContact: (nodeId: string, displayName: string, pubkeyHex?: string) => Promise<void>;
  removeContact: (nodeId: string) => Promise<void>;
  isContact: (nodeId: string) => Promise<boolean>;
  toggleFavorite: (nodeId: string) => Promise<void>;
  refreshContacts: () => Promise<void>;
}

const CONTACTS_KEY = 'bitmesh:contacts_web';
const CONVERSATIONS_KEY = 'bitmesh:conversations_web';
const MESSAGES_KEY_PREFIX = 'bitmesh:messages_web:';

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const [MessagesContext, useMessages] = createContextHook((): MessagesState => {
  const { mnemonic } = useWalletSeed();
  const { getMqttBrokerUrl } = useGateway();

  const [identity, setIdentity] = useState<MeshIdentity | null>(null);
  const [mqttState, setMqttState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, StoredMessage[]>>({});
  const [contacts, setContacts] = useState<DBContact[]>([]);
  const [discoveredForums, setDiscoveredForums] = useState<ForumAnnouncement[]>([]);
  const [radarPeers, setRadarPeers] = useState<RadarPeer[]>([]);

  const mqttRef = useRef<MeshMqttClient | null>(null);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const identityRef = useRef<MeshIdentity | null>(null);
  const joinedForums = useRef<Set<string>>(new Set());

  // Persist conversations
  const persistConversations = useCallback((convs: StoredConversation[]) => {
    try {
      localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(convs));
    } catch {}
  }, []);

  const persistMessages = useCallback((convId: string, msgs: StoredMessage[]) => {
    try {
      localStorage.setItem(MESSAGES_KEY_PREFIX + convId, JSON.stringify(msgs));
    } catch {}
  }, []);

  // Load persisted data
  useEffect(() => {
    try {
      const storedConvs = localStorage.getItem(CONVERSATIONS_KEY);
      if (storedConvs) setConversations(JSON.parse(storedConvs));
    } catch {}
    try {
      const storedContacts = localStorage.getItem(CONTACTS_KEY);
      if (storedContacts) setContacts(JSON.parse(storedContacts));
    } catch {}
  }, []);

  // Derive identity from mnemonic
  useEffect(() => {
    if (!mnemonic) {
      setIdentity(null);
      identityRef.current = null;
      return;
    }
    try {
      const derived = deriveMeshIdentity(mnemonic);
      const id: MeshIdentity = {
        nodeId: derived.nodeId,
        pubkeyHex: derived.pubkeyHex,
        privkeyHex: derived.privkeyHex,
        displayName: derived.displayName ?? 'Mon Node',
      };
      console.log('[Messages-Web] Identity derived:', id.nodeId);
      setIdentity(id);
      identityRef.current = id;
    } catch (err) {
      console.log('[Messages-Web] Failed to derive identity:', err);
      setIdentity(null);
      identityRef.current = null;
    }
  }, [mnemonic]);

  const startStatePoller = useCallback((client: MeshMqttClient) => {
    if (pollerRef.current) clearInterval(pollerRef.current);
    pollerRef.current = setInterval(() => {
      const s = client.state;
      setMqttState(s);
    }, 500);
  }, []);

  const connect = useCallback(() => {
    const id = identityRef.current;
    if (!id) {
      console.log('[Messages-Web] No identity, cannot connect');
      return;
    }
    if (mqttRef.current) {
      disconnectMesh(mqttRef.current);
      mqttRef.current = null;
    }
    const brokerUrl = getMqttBrokerUrl();
    console.log('[Messages-Web] Connecting to MQTT:', brokerUrl);
    setMqttState('connecting');

    const client = createMeshMqttClient(id.nodeId, id.pubkeyHex, brokerUrl);
    mqttRef.current = client;
    startStatePoller(client);

    // Subscribe to identity announcements to build radar
    setTimeout(() => {
      if (!mqttRef.current) return;
      subscribeMesh(
        mqttRef.current,
        '#',
        (topic, payload) => {
          if (!topic.startsWith('meshcore/identity/')) return;
          try {
            const data = JSON.parse(payload) as {
              nodeId?: string;
              pubkeyHex?: string;
              online?: boolean;
              lat?: number;
              lng?: number;
            };
            if (!data.nodeId || data.nodeId === identityRef.current?.nodeId) return;
            const peerNodeId = data.nodeId;
            setRadarPeers(prev => {
              const existing = prev.find(p => p.nodeId === peerNodeId);
              const updated: RadarPeer = {
                nodeId: peerNodeId,
                name: peerNodeId,
                distance: existing?.distance ?? Math.random() * 5000,
                bearing: existing?.bearing ?? Math.random() * 360,
                signalStrength: data.online ? 75 : 20,
                lat: data.lat,
                lng: data.lng,
                lastSeen: Date.now(),
              };
              if (existing) {
                return prev.map(p => p.nodeId === peerNodeId ? updated : p);
              }
              return [...prev, updated];
            });
          } catch {}
        },
        0
      );

      // Subscribe to forum announcements
      subscribeForumAnnouncements(mqttRef.current, (announcement) => {
        console.log('[Messages-Web] Forum discovered:', announcement.channelName);
        setDiscoveredForums(prev => {
          const exists = prev.find(f => f.channelName === announcement.channelName);
          if (exists) return prev;
          return [...prev, announcement];
        });
      });
    }, 1000);
  }, [getMqttBrokerUrl, startStatePoller]);

  const disconnect = useCallback(() => {
    if (pollerRef.current) clearInterval(pollerRef.current);
    if (mqttRef.current) {
      disconnectMesh(mqttRef.current);
      mqttRef.current = null;
    }
    setMqttState('disconnected');
  }, []);

  const reconnectMqtt = useCallback(() => {
    console.log('[Messages-Web] Force reconnect');
    disconnect();
    setTimeout(connect, 500);
  }, [disconnect, connect]);

  // Auto-connect when identity is ready
  useEffect(() => {
    if (!identity) return;
    const timer = setTimeout(connect, 300);
    return () => clearTimeout(timer);
  }, [identity, connect]);

  // Reconnect when broker URL changes
  const prevBrokerRef = useRef('');
  useEffect(() => {
    const url = getMqttBrokerUrl();
    if (prevBrokerRef.current && prevBrokerRef.current !== url && identity) {
      console.log('[Messages-Web] Broker changed, reconnecting:', url);
      reconnectMqtt();
    }
    prevBrokerRef.current = url;
  }, [getMqttBrokerUrl, identity, reconnectMqtt]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollerRef.current) clearInterval(pollerRef.current);
      if (mqttRef.current) disconnectMesh(mqttRef.current);
    };
  }, []);

  const sendMessage = useCallback(async (convId: string, text: string, type: MessageType = 'text') => {
    const id = identityRef.current;
    if (!id) throw new Error('No identity');
    const client = mqttRef.current;

    const msg: StoredMessage = {
      id: genId(),
      conversationId: convId,
      fromNodeId: id.nodeId,
      fromPubkey: id.pubkeyHex,
      text,
      type,
      timestamp: Date.now(),
      isMine: true,
      status: client?.state === 'connected' ? 'sent' : 'sending',
    };

    setMessagesByConv(prev => {
      const existing = prev[convId] ?? [];
      const updated = [...existing, msg];
      persistMessages(convId, updated);
      return { ...prev, [convId]: updated };
    });

    setConversations(prev => {
      const updated = prev.map(c =>
        c.id === convId ? { ...c, lastMessage: text, lastMessageTime: Date.now() } : c
      );
      persistConversations(updated);
      return updated;
    });

    // Publish via MQTT if connected
    if (client && client.state === 'connected') {
      const conv = conversations.find(c => c.id === convId);
      const topic = conv?.isForum
        ? TOPICS.forum(convId)
        : TOPICS.dm(convId);
      const payload = JSON.stringify({
        v: 1,
        id: msg.id,
        fromNodeId: id.nodeId,
        fromPubkey: id.pubkeyHex,
        text,
        type,
        ts: Date.now(),
      });
      publishMesh(client, topic, payload);
      console.log('[Messages-Web] Message sent via MQTT:', topic);
    }
  }, [conversations, persistMessages, persistConversations]);

  const startConversation = useCallback(async (peerNodeId: string, peerName?: string) => {
    const name = peerName ?? peerNodeId;
    setConversations(prev => {
      if (prev.find(c => c.id === peerNodeId)) return prev;
      const conv: StoredConversation = {
        id: peerNodeId,
        name,
        isForum: false,
        lastMessageTime: Date.now(),
        unreadCount: 0,
        online: true,
      };
      const updated = [...prev, conv];
      persistConversations(updated);
      return updated;
    });
  }, [persistConversations]);

  const joinForum = useCallback(async (channelName: string, description?: string) => {
    const id = identityRef.current;
    setConversations(prev => {
      if (prev.find(c => c.id === channelName)) return prev;
      const conv: StoredConversation = {
        id: channelName,
        name: `#${channelName}`,
        isForum: true,
        lastMessageTime: Date.now(),
        unreadCount: 0,
        online: true,
      };
      const updated = [...prev, conv];
      persistConversations(updated);
      return updated;
    });

    if (mqttRef.current && mqttRef.current.state === 'connected') {
      joinForumChannel(mqttRef.current, channelName, (topic, payload) => {
        try {
          const data = JSON.parse(payload) as {
            id?: string;
            fromNodeId?: string;
            fromPubkey?: string;
            text?: string;
            type?: MessageType;
            ts?: number;
          };
          if (!data.fromNodeId || data.fromNodeId === id?.nodeId) return;
          const msg: StoredMessage = {
            id: data.id ?? genId(),
            conversationId: channelName,
            fromNodeId: data.fromNodeId,
            fromPubkey: data.fromPubkey ?? '',
            text: data.text ?? '',
            type: data.type ?? 'text',
            timestamp: data.ts ?? Date.now(),
            isMine: false,
            status: 'delivered',
          };
          setMessagesByConv(prev => {
            const existing = prev[channelName] ?? [];
            if (existing.find(m => m.id === msg.id)) return prev;
            const updated = [...existing, msg];
            persistMessages(channelName, updated);
            return { ...prev, [channelName]: updated };
          });
          setConversations(prev =>
            prev.map(c =>
              c.id === channelName
                ? { ...c, lastMessage: msg.text, lastMessageTime: msg.timestamp, unreadCount: c.unreadCount + 1 }
                : c
            )
          );
        } catch {}
      });
      joinedForums.current.add(channelName);
    }
  }, [persistConversations, persistMessages]);

  const leaveForum = useCallback((channelName: string) => {
    if (mqttRef.current) leaveForumChannel(mqttRef.current, channelName);
    joinedForums.current.delete(channelName);
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== channelName);
      persistConversations(updated);
      return updated;
    });
  }, [persistConversations]);

  const announceForumPublic = useCallback((channelName: string, description: string): boolean => {
    const id = identityRef.current;
    const client = mqttRef.current;
    if (!client || client.state !== 'connected' || !id) return false;
    announceForumChannel(client, channelName, description, id.pubkeyHex, true);
    return true;
  }, []);

  const loadConversationMessages = useCallback(async (convId: string) => {
    try {
      const stored = localStorage.getItem(MESSAGES_KEY_PREFIX + convId);
      if (stored) {
        const msgs = JSON.parse(stored) as StoredMessage[];
        setMessagesByConv(prev => ({ ...prev, [convId]: msgs }));
      }
    } catch {}
  }, []);

  const markRead = useCallback(async (convId: string) => {
    setConversations(prev => {
      const updated = prev.map(c => c.id === convId ? { ...c, unreadCount: 0 } : c);
      persistConversations(updated);
      return updated;
    });
  }, [persistConversations]);

  const setDisplayName = useCallback(async (name: string) => {
    setIdentity(prev => prev ? { ...prev, displayName: name } : prev);
    if (identityRef.current) identityRef.current.displayName = name;
  }, []);

  const deleteMessage = useCallback(async (msgId: string, convId: string) => {
    setMessagesByConv(prev => {
      const updated = (prev[convId] ?? []).filter(m => m.id !== msgId);
      persistMessages(convId, updated);
      return { ...prev, [convId]: updated };
    });
  }, [persistMessages]);

  const deleteConversation = useCallback(async (convId: string) => {
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== convId);
      persistConversations(updated);
      return updated;
    });
    setMessagesByConv(prev => {
      const next = { ...prev };
      delete next[convId];
      return next;
    });
    try { localStorage.removeItem(MESSAGES_KEY_PREFIX + convId); } catch {}
  }, [persistConversations]);

  const addContact = useCallback(async (nodeId: string, displayName: string, pubkeyHex?: string) => {
    const contact: DBContact = {
      nodeId,
      displayName,
      pubkeyHex,
      isFavorite: false,
      addedAt: Date.now(),
      updatedAt: Date.now(),
    };
    setContacts(prev => {
      if (prev.find(c => c.nodeId === nodeId)) return prev;
      const updated = [...prev, contact];
      try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const removeContact = useCallback(async (nodeId: string) => {
    setContacts(prev => {
      const updated = prev.filter(c => c.nodeId !== nodeId);
      try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const isContactFn = useCallback(async (nodeId: string): Promise<boolean> => {
    const stored = localStorage.getItem(CONTACTS_KEY);
    if (!stored) return false;
    try {
      const list = JSON.parse(stored) as DBContact[];
      return list.some(c => c.nodeId === nodeId);
    } catch { return false; }
  }, []);

  const toggleFavorite = useCallback(async (nodeId: string) => {
    setContacts(prev => {
      const updated = prev.map(c => c.nodeId === nodeId ? { ...c, isFavorite: !c.isFavorite } : c);
      try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const refreshContacts = useCallback(async () => {
    try {
      const stored = localStorage.getItem(CONTACTS_KEY);
      if (stored) setContacts(JSON.parse(stored));
    } catch {}
  }, []);

  const noopAsync = async () => {};

  return {
    identity,
    mqttState,
    conversations,
    messagesByConv,
    radarPeers,
    myLocation: null,
    discoveredForums,
    connect,
    disconnect,
    reconnectMqtt,
    sendMessage,
    sendAudio: noopAsync,
    sendImage: noopAsync,
    sendCashu: noopAsync,
    loadConversationMessages,
    startConversation,
    joinForum,
    leaveForum,
    markRead,
    announceForumPublic,
    setDisplayName,
    deleteMessage,
    deleteConversation,
    contacts,
    addContact,
    removeContact,
    isContact: isContactFn,
    toggleFavorite,
    refreshContacts,
  };
});
