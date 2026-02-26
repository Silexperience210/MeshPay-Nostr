export interface DerivedWalletInfo {
  xpub: string;
  firstReceiveAddress: string;
  fingerprint: string;
}

export function generateMnemonic(_strength: 12 | 24 = 12): string {
  console.log('[Bitcoin-Web] Not available on web');
  return '';
}

export function validateMnemonic(_mnemonic: string): boolean {
  return false;
}

export function mnemonicToSeed(_mnemonic: string, _passphrase?: string): Uint8Array {
  return new Uint8Array(0);
}

export function entropyToMnemonic(_entropy: Uint8Array): string {
  return '';
}

export const wordlist: string[] = [];

export function pubkeyToSegwitAddress(_pubkey: Uint8Array, _mainnet: boolean = true): string {
  return '';
}

export function pubkeyToLegacyAddress(_pubkey: Uint8Array, _mainnet: boolean = true): string {
  return '';
}

export function deriveWalletInfo(_mnemonic: string, _passphrase?: string): DerivedWalletInfo {
  return { xpub: '', firstReceiveAddress: '', fingerprint: '' };
}

export function deriveReceiveAddresses(_mnemonic: string, _count: number = 5, _passphrase?: string): string[] {
  return [];
}

export function shortenAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}
