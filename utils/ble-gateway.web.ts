export interface BleGatewayDevice {
  id: string;
  name: string;
  rssi: number;
}

export interface BleDeviceInfo {
  publicKey: string;
  name: string;
  firmwareVersion: string;
  radioParams: any;
}

export class BleGatewayClient {
  async initialize(): Promise<void> {
    console.log('[BLE-Web] BLE not available on web');
  }

  async scanForGateways(
    _onDevice: (device: BleGatewayDevice) => void,
    _timeoutMs?: number
  ): Promise<void> {
    console.log('[BLE-Web] Scan not available on web');
  }

  async connect(_deviceId: string): Promise<void> {
    throw new Error('BLE not available on web');
  }

  async disconnect(): Promise<void> {}

  getConnectedDevice(): BleGatewayDevice | null {
    return null;
  }

  onDeviceInfo(_handler: (info: BleDeviceInfo) => void): void {}

  async sendPacket(_packet: any): Promise<void> {
    throw new Error('BLE not available on web');
  }

  onMessage(_handler: (packet: any) => void): void {}

  isConnected(): boolean {
    return false;
  }
}

let _instance: BleGatewayClient | null = null;

export function getBleGatewayClient(): BleGatewayClient {
  if (!_instance) _instance = new BleGatewayClient();
  return _instance;
}
