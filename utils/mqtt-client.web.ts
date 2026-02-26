export type MqttConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type MessageHandler = (topic: string, payload: string) => void;

export const BROKER_OPTIONS = [
  { name: 'EMQX Public', url: 'wss://broker.emqx.io:8084/mqtt', description: 'Broker public rapide' },
  { name: 'HiveMQ Public', url: 'wss://broker.hivemq.com:8884/mqtt', description: 'Alternative fiable' },
  { name: 'Mosquitto Test', url: 'wss://test.mosquitto.org:8081/mqtt', description: 'Broker de test Eclipse' },
];

export const TOPICS = {
  identity: (nodeId: string) => `meshcore/identity/${nodeId}`,
  dm: (nodeId: string) => `meshcore/dm/${nodeId}`,
  forum: (channelId: string) => `meshcore/forum/${channelId}`,
  route: (nodeId: string) => `meshcore/route/${nodeId}`,
  loraInbound: 'meshcore/lora/inbound',
  loraOutbound: 'meshcore/lora/outbound',
  gatewayAnnounce: 'meshcore/gateway/announce',
  forumsAnnounce: 'meshcore/forums/announce',
  forumAnnounce: (channelName: string) => `meshcore/forums/announce/${channelName}`,
} as const;

export interface MeshMqttClient {
  client: null;
  state: MqttConnectionState;
  nodeId: string;
  handlers: Map<string, MessageHandler[]>;
  patternHandlers: Map<string, MessageHandler[]>;
  forumAnnouncementHandler?: MessageHandler;
}

export interface ForumAnnouncement {
  channelName: string;
  description: string;
  creatorNodeId: string;
  memberCount: number;
  lastActivity: number;
}

export function createMeshMqttClient(_nodeId: string, _pubkeyHex: string, _brokerUrl?: string): MeshMqttClient {
  console.log('[MQTT-Web] MQTT not available on web');
  return {
    client: null,
    state: 'disconnected',
    nodeId: _nodeId,
    handlers: new Map(),
    patternHandlers: new Map(),
  };
}

export function publishMesh(_inst: MeshMqttClient, _topic: string, _payload: string): void {}
export function subscribeMesh(_inst: MeshMqttClient, _topic: string, _handler: MessageHandler): void {}
export function subscribePattern(_inst: MeshMqttClient, _pattern: string, _handler: MessageHandler): void {}
export function updatePresence(_inst: MeshMqttClient, _data: any): void {}
export function disconnectMesh(_inst: MeshMqttClient): void {}
export function joinForumChannel(_inst: MeshMqttClient, _channel: string, _handler: MessageHandler): void {}
export function leaveForumChannel(_inst: MeshMqttClient, _channel: string): void {}
export async function fetchPeerPubkey(_inst: MeshMqttClient, _nodeId: string): Promise<string | null> { return null; }
export function announceForumChannel(_inst: MeshMqttClient, _channel: string, _desc: string): void {}
export function subscribeForumAnnouncements(_inst: MeshMqttClient, _handler: (a: ForumAnnouncement) => void): void {}
export function publishWithRetry(_topic: string, _payload: string): void {}
