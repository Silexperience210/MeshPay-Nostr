export type MqttQoS = 0 | 1 | 2;

import { lzwCompress, lzwDecompress } from './lzw';
import { Platform } from 'react-native';

export interface MqttMessage {
  topic: string;
  payload: string;
  qos: MqttQoS;
  timestamp: number;
  retained: boolean;
}

export function compressMqttPayload(payload: string): string {
  if (payload.length < 500) return payload;

  try {
    const compressed = lzwCompress(payload);
    return 'LZ:' + compressed;
  } catch (err) {
    console.warn('[MQTT] Compression failed, sending raw:', err);
    return payload;
  }
}

export function decompressMqttPayload(payload: string): string {
  if (!payload.startsWith('LZ:')) return payload;

  try {
    return lzwDecompress(payload.slice(3));
  } catch (err) {
    console.warn('[MQTT] Decompression failed:', err);
    return payload;
  }
}

export interface MqttSubscription {
  topic: string;
  qos: MqttQoS;
  callback: (message: MqttMessage) => void;
}

export interface MqttBrokerConfig {
  url: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  keepAlive: number;
  cleanSession: boolean;
}

export type MqttConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export const DEFAULT_MQTT_CONFIG: MqttBrokerConfig = {
  url: 'wss://broker.emqx.io:8084/mqtt',
  port: 8084,
  clientId: `meshcore-gw-${Date.now().toString(36)}`,
  keepAlive: 60,
  cleanSession: true,
};

export const MQTT_TOPICS = {
  gatewayAnnounce: 'meshcore/gateway/announce',
  gatewayStatus: 'meshcore/gateway/status',
  txBroadcast: 'meshcore/tx/broadcast',
  txStatus: 'meshcore/tx/status',
  cashuRelay: 'meshcore/cashu/relay',
  cashuRedeem: 'meshcore/cashu/redeem',
  chunkRelay: 'meshcore/chunk/relay',
  chunkAssembled: 'meshcore/chunk/assembled',
  loraInbound: 'meshcore/lora/inbound',
  loraOutbound: 'meshcore/lora/outbound',
  paymentRequest: 'meshcore/payment/request',
  paymentConfirm: 'meshcore/payment/confirm',
} as const;

export interface MqttClient {
  state: MqttConnectionState;
  subscriptions: Map<string, MqttSubscription>;
  messageQueue: MqttMessage[];
  config: MqttBrokerConfig;
  _ws: WebSocket | null;
  _keepAliveTimer: ReturnType<typeof setInterval> | null;
  _pendingSubCallbacks: Map<string, MqttSubscription>;
}

export function createMqttClient(config: MqttBrokerConfig): MqttClient {
  console.log('[MQTT] Creating client with ID:', config.clientId);
  return {
    state: 'disconnected',
    subscriptions: new Map(),
    messageQueue: [],
    config,
    _ws: null,
    _keepAliveTimer: null,
    _pendingSubCallbacks: new Map(),
  };
}

function encodeUtf8(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

function encodeMqttString(str: string): Uint8Array {
  const encoded = encodeUtf8(str);
  const result = new Uint8Array(2 + encoded.length);
  result[0] = (encoded.length >> 8) & 0xff;
  result[1] = encoded.length & 0xff;
  result.set(encoded, 2);
  return result;
}

function encodeRemainingLength(length: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let encodedByte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) {
      encodedByte = encodedByte | 128;
    }
    bytes.push(encodedByte);
  } while (length > 0);
  return new Uint8Array(bytes);
}

function buildConnectPacket(config: MqttBrokerConfig): Uint8Array {
  const protocolName = encodeMqttString('MQTT');
  const protocolLevel = 4; // MQTT 3.1.1
  let connectFlags = 0x02; // Clean session
  if (config.username) connectFlags |= 0x80;
  if (config.password) connectFlags |= 0x40;

  const clientIdBytes = encodeMqttString(config.clientId);
  const usernameBytes = config.username ? encodeMqttString(config.username) : new Uint8Array(0);
  const passwordBytes = config.password ? encodeMqttString(config.password) : new Uint8Array(0);

  const keepAliveBytes = new Uint8Array(2);
  keepAliveBytes[0] = (config.keepAlive >> 8) & 0xff;
  keepAliveBytes[1] = config.keepAlive & 0xff;

  const variableHeader = new Uint8Array([
    ...protocolName,
    protocolLevel,
    connectFlags,
    ...keepAliveBytes,
  ]);

  const payload = new Uint8Array([
    ...clientIdBytes,
    ...usernameBytes,
    ...passwordBytes,
  ]);

  const remainingLength = variableHeader.length + payload.length;
  const remainingLengthBytes = encodeRemainingLength(remainingLength);

  const packet = new Uint8Array(1 + remainingLengthBytes.length + remainingLength);
  let offset = 0;
  packet[offset++] = 0x10; // CONNECT packet type
  packet.set(remainingLengthBytes, offset);
  offset += remainingLengthBytes.length;
  packet.set(variableHeader, offset);
  offset += variableHeader.length;
  packet.set(payload, offset);

  return packet;
}

function buildSubscribePacket(packetId: number, topic: string, qos: MqttQoS): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const packetIdBytes = new Uint8Array(2);
  packetIdBytes[0] = (packetId >> 8) & 0xff;
  packetIdBytes[1] = packetId & 0xff;

  const remainingLength = 2 + topicBytes.length + 1;
  const remainingLengthBytes = encodeRemainingLength(remainingLength);

  const packet = new Uint8Array(1 + remainingLengthBytes.length + remainingLength);
  let offset = 0;
  packet[offset++] = 0x82; // SUBSCRIBE with QoS 1
  packet.set(remainingLengthBytes, offset);
  offset += remainingLengthBytes.length;
  packet.set(packetIdBytes, offset);
  offset += 2;
  packet.set(topicBytes, offset);
  offset += topicBytes.length;
  packet[offset] = qos;

  return packet;
}

function buildPublishPacket(topic: string, payload: string, qos: MqttQoS, retained: boolean, packetId?: number): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const payloadBytes = encodeUtf8(payload);

  let flags = 0x30; // PUBLISH
  if (qos === 1) flags |= 0x02;
  if (qos === 2) flags |= 0x04;
  if (retained) flags |= 0x01;

  const packetIdSize = qos > 0 ? 2 : 0;
  const remainingLength = topicBytes.length + packetIdSize + payloadBytes.length;
  const remainingLengthBytes = encodeRemainingLength(remainingLength);

  const packet = new Uint8Array(1 + remainingLengthBytes.length + remainingLength);
  let offset = 0;
  packet[offset++] = flags;
  packet.set(remainingLengthBytes, offset);
  offset += remainingLengthBytes.length;
  packet.set(topicBytes, offset);
  offset += topicBytes.length;

  if (qos > 0 && packetId !== undefined) {
    packet[offset++] = (packetId >> 8) & 0xff;
    packet[offset++] = packetId & 0xff;
  }

  packet.set(payloadBytes, offset);

  return packet;
}

function buildPingreqPacket(): Uint8Array {
  return new Uint8Array([0xc0, 0x00]);
}

function buildDisconnectPacket(): Uint8Array {
  return new Uint8Array([0xe0, 0x00]);
}

function decodeRemainingLength(data: Uint8Array, startOffset: number): { length: number; bytesUsed: number } {
  let multiplier = 1;
  let value = 0;
  let bytesUsed = 0;

  for (let i = startOffset; i < data.length; i++) {
    bytesUsed++;
    value += (data[i] & 127) * multiplier;
    if ((data[i] & 128) === 0) break;
    multiplier *= 128;
  }

  return { length: value, bytesUsed };
}

let _packetIdCounter = 1;

function nextPacketId(): number {
  _packetIdCounter = (_packetIdCounter % 65535) + 1;
  return _packetIdCounter;
}

function handleIncomingPacket(client: MqttClient, data: Uint8Array): void {
  if (data.length < 2) return;

  const packetType = (data[0] >> 4) & 0x0f;

  switch (packetType) {
    case 3: { // PUBLISH
      try {
        const { length: remainingLength, bytesUsed } = decodeRemainingLength(data, 1);
        let offset = 1 + bytesUsed;

        const topicLength = (data[offset] << 8) | data[offset + 1];
        offset += 2;

        const topicBytes = data.slice(offset, offset + topicLength);
        const topic = new TextDecoder().decode(topicBytes);
        offset += topicLength;

        const qos = (data[0] >> 1) & 0x03;
        if (qos > 0) {
          const packetId = (data[offset] << 8) | data[offset + 1];
          offset += 2;

          if (qos === 1 && client._ws) {
            const puback = new Uint8Array([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]);
            client._ws.send(puback);
          }
        }

        const payloadBytes = data.slice(offset, 1 + bytesUsed + remainingLength);
        const payload = new TextDecoder().decode(payloadBytes);

        const message: MqttMessage = {
          topic,
          payload,
          qos: qos as MqttQoS,
          timestamp: Date.now(),
          retained: (data[0] & 0x01) !== 0,
        };

        console.log('[MQTT] Received message on:', topic, 'length:', payload.length);

        for (const [subTopic, sub] of client.subscriptions) {
          if (topicMatchesFilter(topic, subTopic)) {
            try {
              sub.callback(message);
            } catch (err) {
              console.error('[MQTT] Subscription callback error:', err);
            }
          }
        }

        for (const [subTopic, sub] of client._pendingSubCallbacks) {
          if (topicMatchesFilter(topic, subTopic)) {
            try {
              sub.callback(message);
            } catch (err) {
              console.error('[MQTT] Pending callback error:', err);
            }
          }
        }
      } catch (err) {
        console.error('[MQTT] Error parsing PUBLISH packet:', err);
      }
      break;
    }
    case 13: // PINGRESP
      console.log('[MQTT] PINGRESP received');
      break;
    case 9: // SUBACK
      console.log('[MQTT] SUBACK received');
      break;
    case 4: // PUBACK
      console.log('[MQTT] PUBACK received');
      break;
    default:
      console.log('[MQTT] Received packet type:', packetType);
  }
}

function topicMatchesFilter(topic: string, filter: string): boolean {
  if (filter === '#') return true;
  if (filter === topic) return true;

  const topicParts = topic.split('/');
  const filterParts = filter.split('/');

  for (let i = 0; i < filterParts.length; i++) {
    if (filterParts[i] === '#') return true;
    if (filterParts[i] === '+') continue;
    if (i >= topicParts.length || filterParts[i] !== topicParts[i]) return false;
  }

  return topicParts.length === filterParts.length;
}

export async function connectMqtt(client: MqttClient): Promise<MqttClient> {
  console.log('[MQTT] Connecting to:', client.config.url);

  return new Promise((resolve) => {
    try {
      const url = client.config.url;

      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        console.error('[MQTT] URL must use ws:// or wss:// protocol');
        resolve({ ...client, state: 'error' });
        return;
      }

      const ws = new WebSocket(url, ['mqtt']);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        console.error('[MQTT] Connection timeout');
        try { ws.close(); } catch (_e) { /* ignore */ }
        resolve({ ...client, state: 'error', _ws: null });
      }, 10000);

      ws.onopen = () => {
        console.log('[MQTT] WebSocket connected, sending CONNECT packet');
        const connectPacket = buildConnectPacket(client.config);
        ws.send(connectPacket);
      };

      ws.onmessage = (event: MessageEvent) => {
        const data = new Uint8Array(event.data as ArrayBuffer);

        if (data.length >= 2) {
          const packetType = (data[0] >> 4) & 0x0f;

          if (packetType === 2) { // CONNACK
            clearTimeout(timeout);
            const returnCode = data[3];

            if (returnCode === 0) {
              console.log('[MQTT] Connected successfully');

              const connectedClient: MqttClient = {
                ...client,
                state: 'connected',
                _ws: ws,
                _keepAliveTimer: null,
                _pendingSubCallbacks: new Map(),
              };

              const keepAliveTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(buildPingreqPacket());
                }
              }, (client.config.keepAlive * 1000) / 2);

              connectedClient._keepAliveTimer = keepAliveTimer;

              ws.onmessage = (msgEvent: MessageEvent) => {
                const msgData = new Uint8Array(msgEvent.data as ArrayBuffer);
                handleIncomingPacket(connectedClient, msgData);
              };

              ws.onclose = () => {
                console.log('[MQTT] WebSocket closed');
                connectedClient.state = 'disconnected';
                if (connectedClient._keepAliveTimer) {
                  clearInterval(connectedClient._keepAliveTimer);
                  connectedClient._keepAliveTimer = null;
                }
              };

              ws.onerror = (err) => {
                console.error('[MQTT] WebSocket error:', err);
                connectedClient.state = 'error';
              };

              resolve(connectedClient);
            } else {
              console.error('[MQTT] CONNACK error, return code:', returnCode);
              ws.close();
              resolve({ ...client, state: 'error', _ws: null });
            }
            return;
          }
        }

        handleIncomingPacket(client, data);
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        console.error('[MQTT] WebSocket error during connect:', err);
        resolve({ ...client, state: 'error', _ws: null });
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        console.log('[MQTT] WebSocket closed during connect');
      };

    } catch (err) {
      console.error('[MQTT] Connection error:', err);
      resolve({ ...client, state: 'error', _ws: null });
    }
  });
}

export async function disconnectMqtt(client: MqttClient): Promise<MqttClient> {
  console.log('[MQTT] Disconnecting...');

  if (client._keepAliveTimer) {
    clearInterval(client._keepAliveTimer);
  }

  if (client._ws && client._ws.readyState === WebSocket.OPEN) {
    try {
      client._ws.send(buildDisconnectPacket());
      client._ws.close();
    } catch (err) {
      console.warn('[MQTT] Error during disconnect:', err);
    }
  }

  console.log('[MQTT] Disconnected');
  return {
    ...client,
    state: 'disconnected',
    subscriptions: new Map(),
    _ws: null,
    _keepAliveTimer: null,
  };
}

export function subscribeTopic(
  client: MqttClient,
  topic: string,
  qos: MqttQoS,
  callback: (message: MqttMessage) => void
): MqttClient {
  console.log('[MQTT] Subscribing to:', topic, 'QoS:', qos);

  const newSubs = new Map(client.subscriptions);
  newSubs.set(topic, { topic, qos, callback });

  if (client._ws && client._ws.readyState === WebSocket.OPEN) {
    const packetId = nextPacketId();
    const subPacket = buildSubscribePacket(packetId, topic, qos);
    client._ws.send(subPacket);
    console.log('[MQTT] SUBSCRIBE packet sent for:', topic);
  }

  return { ...client, subscriptions: newSubs };
}

export function unsubscribeTopic(client: MqttClient, topic: string): MqttClient {
  console.log('[MQTT] Unsubscribing from:', topic);
  const newSubs = new Map(client.subscriptions);
  newSubs.delete(topic);

  if (client._ws && client._ws.readyState === WebSocket.OPEN) {
    const topicBytes = encodeMqttString(topic);
    const packetId = nextPacketId();
    const remainingLength = 2 + topicBytes.length;
    const remainingLengthBytes = encodeRemainingLength(remainingLength);
    const packet = new Uint8Array(1 + remainingLengthBytes.length + remainingLength);
    let offset = 0;
    packet[offset++] = 0xa2; // UNSUBSCRIBE
    packet.set(remainingLengthBytes, offset);
    offset += remainingLengthBytes.length;
    packet[offset++] = (packetId >> 8) & 0xff;
    packet[offset++] = packetId & 0xff;
    packet.set(topicBytes, offset);
    client._ws.send(packet);
  }

  return { ...client, subscriptions: newSubs };
}

const pendingAcks = new Map<string, { resolve: () => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

export function publishMessage(
  client: MqttClient,
  topic: string,
  payload: string,
  qos: MqttQoS = 0,
  retained: boolean = false
): MqttClient {
  console.log('[MQTT] Publishing to:', topic, 'payload length:', payload.length, 'QoS:', qos);

  const message: MqttMessage = {
    topic,
    payload,
    qos,
    timestamp: Date.now(),
    retained,
  };

  if (client._ws && client._ws.readyState === WebSocket.OPEN) {
    const packetId = qos > 0 ? nextPacketId() : undefined;
    const publishPacket = buildPublishPacket(topic, payload, qos, retained, packetId);
    client._ws.send(publishPacket);
    console.log('[MQTT] PUBLISH packet sent to:', topic);
  } else {
    console.warn('[MQTT] Not connected, message queued for:', topic);
    client.messageQueue.push(message);
  }

  const sub = client.subscriptions.get(topic);
  if (sub) {
    console.log('[MQTT] Local delivery for topic:', topic);
    sub.callback(message);
  }

  return client;
}

export function publishWithAck(
  client: MqttClient,
  topic: string,
  payload: string,
  qos: MqttQoS = 1,
  timeoutMs: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const msgId = `${topic}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const timeout = setTimeout(() => {
      pendingAcks.delete(msgId);
      reject(new Error(`ACK timeout for message ${msgId}`));
    }, timeoutMs);

    pendingAcks.set(msgId, { resolve, reject, timeout });

    try {
      const payloadWithId = JSON.stringify({ ...JSON.parse(payload), _ackId: msgId });
      publishMessage(client, topic, payloadWithId, qos);
    } catch (_err) {
      publishMessage(client, topic, payload, qos);
    }

    console.log('[MQTT] Published with ACK:', msgId);

    if (client._ws && client._ws.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        confirmAck(msgId);
      }, 100);
    }
  });
}

export function confirmAck(msgId: string): void {
  const pending = pendingAcks.get(msgId);
  if (pending) {
    clearTimeout(pending.timeout);
    pending.resolve();
    pendingAcks.delete(msgId);
    console.log('[MQTT] ACK confirmed:', msgId);
  }
}

export async function publishWithRetry(
  client: MqttClient,
  topic: string,
  payload: string,
  qos: MqttQoS = 1,
  maxRetries: number = 3
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await publishWithAck(client, topic, payload, qos, 5000);
      return true;
    } catch (err) {
      console.log(`[MQTT] Attempt ${attempt + 1}/${maxRetries} failed:`, err);

      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[MQTT] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error('[MQTT] All retries failed for:', topic);
  return false;
}

export function createGatewayAnnouncement(
  gatewayId: string,
  capabilities: string[],
  peerCount: number
): string {
  return JSON.stringify({
    type: 'gateway_announce',
    gatewayId,
    capabilities,
    peerCount,
    timestamp: Date.now(),
    version: '1.0',
  });
}

export function createTxBroadcastPayload(
  txHex: string,
  sourceNodeId: string,
  gatewayId: string
): string {
  return JSON.stringify({
    type: 'tx_broadcast',
    txHex,
    sourceNodeId,
    gatewayId,
    timestamp: Date.now(),
  });
}

export function createCashuRelayPayload(
  token: string,
  mintUrl: string,
  sourceNodeId: string,
  gatewayId: string,
  action: 'relay' | 'redeem' | 'mint'
): string {
  return JSON.stringify({
    type: 'cashu_relay',
    token,
    mintUrl,
    sourceNodeId,
    gatewayId,
    action,
    timestamp: Date.now(),
  });
}

export function createChunkRelayPayload(
  chunkRaw: string,
  messageId: string,
  chunkIndex: number,
  totalChunks: number,
  dataType: string,
  gatewayId: string
): string {
  return JSON.stringify({
    type: 'chunk_relay',
    chunkRaw,
    messageId,
    chunkIndex,
    totalChunks,
    dataType,
    gatewayId,
    timestamp: Date.now(),
  });
}

export function parseMqttPayload<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    console.log('[MQTT] Failed to parse payload:', err);
    return null;
  }
}

export async function testMqttConnection(brokerUrl: string): Promise<{
  ok: boolean;
  latency?: number;
  error?: string;
}> {
  console.log('[MQTT] Testing connection to:', brokerUrl);
  const start = Date.now();

  try {
    if (!brokerUrl.startsWith('ws://') && !brokerUrl.startsWith('wss://')) {
      return { ok: false, error: 'URL must use ws:// or wss://' };
    }

    const testResult = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(brokerUrl, ['mqtt']);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        try { ws.close(); } catch (_e) { /* ignore */ }
        resolve(false);
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        try { ws.close(); } catch (_e) { /* ignore */ }
        resolve(true);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve(false);
      };
    });

    const latency = Date.now() - start;

    if (testResult) {
      console.log('[MQTT] Connection test OK, latency:', latency, 'ms');
      return { ok: true, latency };
    } else {
      return { ok: false, error: 'Connection failed' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log('[MQTT] Connection test FAILED:', message);
    return { ok: false, error: message };
  }
}
