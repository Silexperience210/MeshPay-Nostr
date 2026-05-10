export interface NFCTransactionRecord {
  txHex: string;
  txid: string;
  timestamp: number;
  description?: string;
}

export interface NFCashuRecord {
  token: string;
  amount: number;
  memo?: string;
}

export async function initNFC(): Promise<void> {
  console.log('[NFC-Web] NFC not available on web');
}

export async function isNFCAvailable(): Promise<boolean> {
  return false;
}

export async function writeTransactionToNFC(
  _record: NFCTransactionRecord
): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'NFC not available on web' };
}

export async function readTransactionFromNFC(): Promise<{
  success: boolean;
  record?: NFCTransactionRecord;
  error?: string;
}> {
  return { success: false, error: 'NFC not available on web' };
}

export function formatTransactionForNDEF(_record: NFCTransactionRecord): string {
  return '';
}

export function parseNDEFTransaction(_data: string): NFCTransactionRecord | null {
  return null;
}

export async function writeCashuTokenToNFC(
  _record: NFCashuRecord
): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'NFC not available on web' };
}

export async function readCashuTokenFromNFC(): Promise<{
  success: boolean;
  record?: NFCashuRecord;
  error?: string;
}> {
  return { success: false, error: 'NFC not available on web' };
}

export async function stopNFC(): Promise<void> {}
