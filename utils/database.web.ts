export interface DBConversation {
  id: string;
  name: string;
  isForum: boolean;
  peerPubkey?: string;
  lastMessage?: string;
  lastMessageTime: number;
  unreadCount: number;
  online: boolean;
}

export interface DBMessage {
  id: string;
  conversationId: string;
  fromNodeId: string;
  fromPubkey: string;
  text: string;
  type: string;
  timestamp: number;
  isMine: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  cashuAmount?: number;
  cashuToken?: string;
  btcAmount?: number;
  compressed?: boolean;
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

export interface DBCashuToken {
  id: string;
  token: string;
  amount: number;
  mintUrl: string;
  status: 'unspent' | 'spent' | 'pending';
  messageId?: string;
  createdAt: number;
  spentAt?: number;
}

export interface DBSubMesh {
  id: string;
  name: string;
  createdAt: number;
}

export interface DBSubMeshPeer {
  subMeshId: string;
  nodeId: string;
  joinedAt: number;
}

const noopAsync = async () => {};

export async function getDatabase(): Promise<any> {
  console.log('[Database-Web] SQLite not available on web');
  return null;
}

export async function resetDatabase(): Promise<void> {}
export async function migrateFromAsyncStorage(): Promise<void> {}
export async function listConversationsDB(): Promise<DBConversation[]> { return []; }
export async function saveConversationDB(_conv: DBConversation): Promise<void> {}
export async function updateConversationLastMessageDB(_convId: string, _lastMessage: string, _ts: number, _incrementUnread: boolean): Promise<void> {}
export async function markConversationReadDB(_convId: string): Promise<void> {}
export async function loadMessagesDB(_convId: string, _limit?: number): Promise<DBMessage[]> { return []; }
export async function saveMessageDB(_msg: DBMessage): Promise<void> {}
export async function updateMessageStatusDB(_msgId: string, _status: string): Promise<void> {}
export async function deleteMessageDB(_msgId: string): Promise<void> {}
export async function deleteConversationDB(_convId: string): Promise<void> {}
export async function cleanupOldMessages(_maxAgeMs?: number): Promise<number> { return 0; }
export async function getUserProfile(): Promise<{ displayName: string } | null> { return null; }
export async function setUserProfile(_profile: { displayName: string }): Promise<void> {}
export async function saveCashuToken(_token: Omit<DBCashuToken, 'createdAt'>): Promise<void> {}
export async function getUnverifiedCashuTokens(): Promise<DBCashuToken[]> { return []; }
export async function markCashuTokenVerified(_id: string): Promise<void> {}
export async function markCashuTokenSpent(_id: string): Promise<void> {}
export async function markCashuTokenPending(_id: string): Promise<void> {}
export async function markCashuTokenUnspent(_id: string): Promise<void> {}
export async function getCashuBalance(): Promise<{ total: number; byMint: Record<string, number> }> { return { total: 0, byMint: {} }; }
export async function getUnspentCashuTokens(): Promise<DBCashuToken[]> { return []; }
export async function incrementRetryCount(_msgId: string): Promise<number> { return 0; }
export async function saveContact(_contact: Omit<DBContact, 'addedAt' | 'updatedAt'>): Promise<void> {}
export async function getContacts(): Promise<DBContact[]> { return []; }
export async function deleteContact(_nodeId: string): Promise<void> {}
export async function isContact(_nodeId: string): Promise<boolean> { return false; }
export async function toggleContactFavorite(_nodeId: string): Promise<void> {}
export async function getNextMessageId(): Promise<number> { return Date.now(); }
