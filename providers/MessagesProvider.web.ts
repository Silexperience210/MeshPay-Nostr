import { useEffect, useState, useRef, useCallback } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useWalletSeed } from '@/providers/WalletSeedProvider';
import { deriveMeshIdentity } from '@/utils/identity';

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
  conversations: StoredConversation[];
  messagesByConv: Record<string, StoredMessage[]>;
  radarPeers: RadarPeer[];
  myLocation: { lat: number; lng: number } | null;
  sendMessage: (convId: string, text: string, type?: MessageType) => Promise<void>;
  sendCashu: (convId: string, token: string, amountSats: number) => Promise<void>;
  loadConversationMessages: (convId: string) => Promise<void>;
  startConversation: (peerNodeId: string, peerName?: string) => Promise<void>;
  joinForum: (channelName: string, description?: string) => Promise<void>;
  leaveForum: (channelName: string) => void;
  markRead: (convId: string) => Promise<void>;
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

  const [identity, setIdentity] = useState<MeshIdentity | null>(null);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, StoredMessage[]>>({});
  const [contacts, setContacts] = useState<DBContact[]>([]);
  const identityRef = useRef<MeshIdentity | null>(null);

  // Persist helpers
  const persistConversations = useCallback((convs: StoredConversation[]) => {
    try { localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(convs)); } catch {}
  }, []);

  const persistMessages = useCallback((convId: string, msgs: StoredMessage[]) => {
    try { localStorage.setItem(MESSAGES_KEY_PREFIX + convId, JSON.stringify(msgs)); } catch {}
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

  const sendMessage = useCallback(async (convId: string, text: string, type: MessageType = 'text') => {
    const id = identityRef.current;
    if (!id) throw new Error('No identity');

    const msg: StoredMessage = {
      id: genId(),
      conversationId: convId,
      fromNodeId: id.nodeId,
      fromPubkey: id.pubkeyHex,
      text,
      type,
      timestamp: Date.now(),
      isMine: true,
      status: 'sending',
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
  }, [persistMessages, persistConversations]);

  const sendCashu = useCallback(async (_convId: string, _token: string, _amountSats: number) => {
    console.log('[Messages-Web] sendCashu not available on web');
  }, []);

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

  const joinForum = useCallback(async (channelName: string, _description?: string) => {
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
  }, [persistConversations]);

  const leaveForum = useCallback((channelName: string) => {
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== channelName);
      persistConversations(updated);
      return updated;
    });
  }, [persistConversations]);

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

  return {
    identity,
    conversations,
    messagesByConv,
    radarPeers: [],
    myLocation: null,
    sendMessage,
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
    isContact: isContactFn,
    toggleFavorite,
    refreshContacts,
  };
});
