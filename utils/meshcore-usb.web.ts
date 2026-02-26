export interface MeshCoreUsbDevice {
  id: number;
  name: string;
  vendorId: number;
  productId: number;
}

export interface MeshCoreAdapter {
  write: (data: Uint8Array) => Promise<void>;
  onData: (callback: (data: Uint8Array) => void) => void;
  close: () => Promise<void>;
}

export async function listMeshCoreDevices(): Promise<MeshCoreUsbDevice[]> {
  console.log('[MeshCore-USB-Web] USB not available on web');
  return [];
}

export async function createMeshCoreAdapter(_deviceId: number): Promise<MeshCoreAdapter> {
  throw new Error('USB Serial not available on web');
}

export async function parseMeshCorePacket(_data: Uint8Array): Promise<{
  valid: boolean;
  type?: string;
  payload?: any;
  raw?: Uint8Array;
}> {
  return { valid: false };
}
