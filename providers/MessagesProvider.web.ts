import { useState } from 'react';
import createContextHook from '@nkzw/create-context-hook';

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

export interface ForumAnnouncement {
  channelName: string;
  description: string;
  creatorNodeId: string;
  memberCount: number;
  lastActivity: number;
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

const noopAsync = async () => {
  console.log('[Messages-Web] Not available on web');
};

export const [MessagesContext, useMessages] = createContextHook((): MessagesState => {
  const [conversations] = useState<StoredConversation[]>([]);
  const [messagesByConv] = useState<Record<string, StoredMessage[]>>({});
  const [contacts] = useState<DBContact[]>([]);

  return {
    identity: null,
    mqttState: 'disconnected',
    conversations,
    messagesByConv,
    radarPeers: [],
    myLocation: null,
    discoveredForums: [],
    connect: () => console.log('[Messages-Web] Not available on web'),
    disconnect: () => console.log('[Messages-Web] Not available on web'),
    sendMessage: noopAsync,
    sendAudio: noopAsync,
    sendImage: noopAsync,
    sendCashu: noopAsync,
    loadConversationMessages: noopAsync,
    startConversation: noopAsync,
    joinForum: noopAsync,
    leaveForum: () => {},
    markRead: noopAsync,
    announceForumPublic: () => false,
    setDisplayName: noopAsync,
    deleteMessage: noopAsync,
    deleteConversation: noopAsync,
    contacts,
    addContact: noopAsync,
    removeContact: noopAsync,
    isContact: async () => false,
    toggleFavorite: noopAsync,
    refreshContacts: noopAsync,
  };
});
