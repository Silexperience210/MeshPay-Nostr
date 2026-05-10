export type GatewayMode = 'client' | 'gateway';
export type GatewayServiceType = 'mempool' | 'cashu' | 'lora';

export interface GatewayRelayJob {
  id: string;
  type: 'tx_broadcast' | 'cashu_relay' | 'cashu_redeem' | 'chunk_reassembly' | 'payment_forward';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  sourceNodeId: string;
  timestamp: number;
  payload: string;
  result?: string;
  error?: string;
  retries: number;
  maxRetries: number;
}

export interface GatewayPeer {
  nodeId: string;
  name: string;
  lastSeen: number;
  signalStrength: number;
  hops: number;
  capabilities: string[];
  isGateway: boolean;
}

export interface GatewayStats {
  txRelayed: number;
  cashuRelayed: number;
  chunksProcessed: number;
  messagesForwarded: number;
  bytesRelayed: number;
  uptime: number;
  startedAt: number;
  peersServed: number;
  failedJobs: number;
  lastActivityAt: number;
}

export interface GatewayState {
  mode: GatewayMode;
  isActive: boolean;
  relayJobs: GatewayRelayJob[];
  assemblyStates: Map<string, any>;
  peers: GatewayPeer[];
  stats: GatewayStats;
  services: Record<GatewayServiceType, boolean>;
  mempoolUrl: string;
  cashuMintUrl: string;
}

export function createInitialGatewayState(): GatewayState {
  return {
    mode: 'client',
    isActive: false,
    relayJobs: [],
    assemblyStates: new Map(),
    peers: [],
    stats: {
      txRelayed: 0, cashuRelayed: 0, chunksProcessed: 0,
      messagesForwarded: 0, bytesRelayed: 0, uptime: 0,
      startedAt: 0, peersServed: 0, failedJobs: 0, lastActivityAt: 0,
    },
    services: { mempool: true, cashu: true, lora: true },
    mempoolUrl: 'https://mempool.space',
    cashuMintUrl: 'https://mint.minibits.cash/Bitcoin',
  };
}

export async function activateGateway(state: GatewayState): Promise<GatewayState> { return state; }
export function deactivateGateway(state: GatewayState): GatewayState { return state; }
export function broadcastTransaction(state: GatewayState, _txHex: string, _sourceNodeId: string): { state: GatewayState; jobId: string } { return { state, jobId: '' }; }
export function relayCashuToken(state: GatewayState, _token: string, _mintUrl: string, _sourceNodeId: string, _action: string): { state: GatewayState; jobId: string } { return { state, jobId: '' }; }
export function handleIncomingLoRaMessage(state: GatewayState, _rawMessage: string, _sourceNodeId: string): GatewayState { return state; }
export async function forwardPaymentToGateway(state: GatewayState, _paymentData: string, _paymentType: string, _destinationNodeId: string): Promise<GatewayState> { return state; }
export function addGatewayPeer(state: GatewayState, _peer: GatewayPeer): GatewayState { return state; }
export function cleanupStalePeers(state: GatewayState, _maxAge: number): GatewayState { return state; }
export function cleanupOldJobs(state: GatewayState, _maxAge: number): GatewayState { return state; }
export function getGatewayUptime(_state: GatewayState): string { return '0s'; }
export function prepareLoRaChunks(_message: string): string[] { return []; }
