/**
 * Tests unitaires — tx-relay.ts
 *
 * Coverage Phase 3 :
 *   ✅ TxRelayGateway.start / stop / isRunning
 *   ✅ Gateway traite bitcoin_tx → broadcastTransaction → publie confirmation
 *   ✅ Gateway skip ses propres events (auto-relay)
 *   ✅ Gateway skip events déjà traités (idempotence)
 *   ✅ Gateway skip events relay_result (pas des demandes)
 *   ✅ Gateway payload invalide ignoré sans crash
 *   ✅ Gateway erreur broadcast → publie confirmation {success: false}
 *   ✅ Gateway cashu_token → publie ack sans broadcast réseau
 *   ✅ Gateway cashu_melt → publie erreur "non supporté"
 *   ✅ sendBitcoinTxViaNostr → résout avec {txid, gatewayPubkey}
 *   ✅ sendBitcoinTxViaNostr → rejette si gateway retourne erreur
 *   ✅ sendBitcoinTxViaNostr → rejette si timeout
 *   ✅ sendCashuTokenViaNostr → résout avec ack
 *   ✅ sendCashuTokenViaNostr → résout (non-fatal) si timeout
 *   ✅ isTxAlreadyKnown → détecte les messages mempool connus
 */

import {
  TxRelayGateway,
  sendBitcoinTxViaNostr,
  sendCashuTokenViaNostr,
  isTxAlreadyKnown,
  type RelayConfirmation,
} from '../tx-relay';
import { Kind, type NostrClient } from '../nostr-client';
import { finalizeEvent } from 'nostr-tools';
import { deriveNostrKeypair } from '../nostr-client';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock broadcastTransaction
jest.mock('@/utils/mempool', () => ({
  broadcastTransaction: jest.fn(),
}));
import { broadcastTransaction } from '@/utils/mempool';
const mockBroadcast = broadcastTransaction as jest.MockedFunction<typeof broadcastTransaction>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MNEMONIC_ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const MNEMONIC_BOB =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

const kpAlice = deriveNostrKeypair(MNEMONIC_ALICE);
const kpBob = deriveNostrKeypair(MNEMONIC_BOB);

/** Crée un faux NostrClient mockable */
function makeNostrClient(publicKey: string | null = kpAlice.publicKey): NostrClient {
  const subscribeCallbacks = new Map<string, (event: any) => void>();
  let subCounter = 0;

  const client = {
    publicKey,
    isConnected: true,
    connect: jest.fn(),
    disconnect: jest.fn(),
    publish: jest.fn().mockResolvedValue({ id: 'published-event-id' }),
    subscribe: jest.fn((filters: any[], cb: (event: any) => void) => {
      const subId = `sub-${++subCounter}`;
      subscribeCallbacks.set(subId, cb);
      return () => subscribeCallbacks.delete(subId);
    }),
    publishDM: jest.fn(),
    subscribeDMs: jest.fn().mockReturnValue(() => {}),
    publishTxRelay: jest.fn().mockResolvedValue({ id: 'request-event-id' }),
    subscribeTxRelay: jest.fn().mockReturnValue(() => {}),
    publishChannelMessage: jest.fn(),
    publishRelayList: jest.fn(),
    createChannel: jest.fn(),
    subscribeChannel: jest.fn().mockReturnValue(() => {}),
    // Helpers de test pour déclencher des events
    _triggerSubscriber(event: any) {
      for (const cb of subscribeCallbacks.values()) {
        cb(event);
      }
    },
    _subscribeCallbacks: subscribeCallbacks,
  } as unknown as NostrClient & { _triggerSubscriber: (e: any) => void };

  return client;
}

/** Crée un event kind:9001 valide signé par Bob (simulant une demande externe) */
function makeTxRelayRequest(type: string, data: string, signerKey = kpBob.secretKey) {
  return finalizeEvent(
    {
      kind: Kind.TxRelay,
      content: JSON.stringify({ type, data }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    signerKey,
  );
}

/** Crée un event kind:9001 signé par Alice (simule son propre event) */
function makeSelfTxEvent(type: string, data: string) {
  return finalizeEvent(
    {
      kind: Kind.TxRelay,
      content: JSON.stringify({ type, data }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    kpAlice.secretKey,
  );
}

/** Crée un event relay_result (confirmation, pas une demande) */
function makeRelayResultEvent() {
  return finalizeEvent(
    {
      kind: Kind.TxRelay,
      content: JSON.stringify({ success: true }),
      tags: [['t', 'relay_result']],
      created_at: Math.floor(Date.now() / 1000),
    },
    kpBob.secretKey,
  );
}

// ─── Tests TxRelayGateway ─────────────────────────────────────────────────────

describe('TxRelayGateway — cycle de vie', () => {
  test('isRunning est false avant start', () => {
    const client = makeNostrClient();
    const gw = new TxRelayGateway(client);
    expect(gw.isRunning).toBe(false);
  });

  test('start() démarre la souscription, isRunning = true', () => {
    const client = makeNostrClient();
    const gw = new TxRelayGateway(client);
    gw.start();
    expect((client as any).subscribe).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ kinds: [Kind.TxRelay] })]),
      expect.any(Function),
    );
    expect(gw.isRunning).toBe(true);
  });

  test('stop() arrête la souscription, isRunning = false', () => {
    const client = makeNostrClient();
    const gw = new TxRelayGateway(client);
    gw.start();
    gw.stop();
    expect(gw.isRunning).toBe(false);
  });

  test('start() appelé deux fois — stop implicite avant redémarrage', () => {
    const client = makeNostrClient();
    const gw = new TxRelayGateway(client);
    gw.start();
    gw.start(); // second appel = stop + start
    expect((client as any).subscribe).toHaveBeenCalledTimes(2);
    expect(gw.isRunning).toBe(true);
  });

  test('relayedCount et errorCount initialisés à 0', () => {
    const client = makeNostrClient();
    const gw = new TxRelayGateway(client);
    expect(gw.relayedCount).toBe(0);
    expect(gw.errorCount).toBe(0);
  });
});

describe('TxRelayGateway — filtrage des events', () => {
  test('skip event dont pubkey = publicKey du client (auto-relay)', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const selfEvent = makeSelfTxEvent('bitcoin_tx', 'deadbeef');
    (client as any)._triggerSubscriber(selfEvent);

    // Laisser les promesses se résoudre
    await new Promise(r => setTimeout(r, 10));

    // broadcastTransaction NE doit PAS être appelé
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(gw.relayedCount).toBe(0);
  });

  test('skip event avec tag relay_result (confirmation, pas demande)', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const resultEvent = makeRelayResultEvent();
    (client as any)._triggerSubscriber(resultEvent);

    await new Promise(r => setTimeout(r, 10));

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(gw.relayedCount).toBe(0);
  });

  test('skip event déjà traité (idempotence par event.id)', async () => {
    mockBroadcast.mockResolvedValueOnce({ txid: 'abc123' });
    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const event = makeTxRelayRequest('bitcoin_tx', 'cafecafe');
    (client as any)._triggerSubscriber(event);
    await new Promise(r => setTimeout(r, 20));
    (client as any)._triggerSubscriber(event); // second déclenchement
    await new Promise(r => setTimeout(r, 20));

    // broadcast appelé UNE seule fois
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(gw.relayedCount).toBe(1);
  });

  test('payload JSON invalide ignoré sans crash', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const badEvent = finalizeEvent(
      {
        kind: Kind.TxRelay,
        content: 'pas du json {{{',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      kpBob.secretKey,
    );

    // Ne doit pas lancer d'exception
    expect(() => (client as any)._triggerSubscriber(badEvent)).not.toThrow();
    await new Promise(r => setTimeout(r, 10));
    expect(gw.relayedCount).toBe(0);
    expect(gw.errorCount).toBe(0); // ignoré silencieusement, pas compté comme erreur
  });
});

describe('TxRelayGateway — traitement bitcoin_tx', () => {
  beforeEach(() => {
    mockBroadcast.mockReset();
  });

  test('broadcast réussi → publie confirmation {success: true, txid}', async () => {
    const TXID = 'f'.repeat(64);
    mockBroadcast.mockResolvedValueOnce({ txid: TXID });

    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const event = makeTxRelayRequest('bitcoin_tx', 'deadbeef01');
    (client as any)._triggerSubscriber(event);
    await new Promise(r => setTimeout(r, 30));

    expect(mockBroadcast).toHaveBeenCalledWith('deadbeef01', expect.any(String));
    expect((client as any).publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"success":true'),
        tags: expect.arrayContaining([
          ['e', event.id],
          ['p', event.pubkey],
          ['t', 'relay_result'],
        ]),
      }),
    );
    expect(gw.relayedCount).toBe(1);
    expect(gw.errorCount).toBe(0);
  });

  test('broadcast échoue → publie confirmation {success: false, error}', async () => {
    mockBroadcast.mockRejectedValueOnce(new Error('connection refused'));

    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const event = makeTxRelayRequest('bitcoin_tx', 'badhex');
    (client as any)._triggerSubscriber(event);
    await new Promise(r => setTimeout(r, 30));

    expect((client as any).publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"success":false'),
        tags: expect.arrayContaining([['t', 'relay_result']]),
      }),
    );
    expect(gw.errorCount).toBe(1);
  });
});

describe('TxRelayGateway — traitement cashu_token', () => {
  beforeEach(() => { mockBroadcast.mockReset(); });

  test('cashu_token → publie ack sans appel réseau', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const event = makeTxRelayRequest('cashu_token', 'cashuAeyJ...');
    (client as any)._triggerSubscriber(event);
    await new Promise(r => setTimeout(r, 30));

    // Pas d'appel réseau
    expect(mockBroadcast).not.toHaveBeenCalled();
    // Ack publié
    expect((client as any).publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"success":true'),
        tags: expect.arrayContaining([['t', 'relay_result']]),
      }),
    );
    expect(gw.relayedCount).toBe(1);
  });
});

describe('TxRelayGateway — traitement cashu_melt', () => {
  test('cashu_melt → publie erreur "non supporté"', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const gw = new TxRelayGateway(client);
    gw.start();

    const event = makeTxRelayRequest('cashu_melt', 'some-proof');
    (client as any)._triggerSubscriber(event);
    await new Promise(r => setTimeout(r, 30));

    expect((client as any).publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"success":false'),
      }),
    );
    expect(gw.errorCount).toBe(1);
  });
});

// ─── Tests sendBitcoinTxViaNostr ──────────────────────────────────────────────

describe('sendBitcoinTxViaNostr', () => {
  test('résout avec txid et gatewayPubkey quand gateway confirme', async () => {
    const TXID = 'e'.repeat(64);
    const client = makeNostrClient(kpAlice.publicKey);

    // publishTxRelay retourne un event avec un id spécifique
    const requestId = 'req-' + Math.random().toString(36).slice(2);
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: requestId });

    // subscribe intercepté pour simuler une réponse gateway
    (client as any).subscribe = jest.fn((filters: any[], cb: (e: any) => void) => {
      // Simuler une réponse asynchrone du gateway
      setTimeout(() => {
        const confirmEvent = finalizeEvent(
          {
            kind: Kind.TxRelay,
            content: JSON.stringify({ success: true, txid: TXID }),
            tags: [['e', requestId], ['t', 'relay_result']],
            created_at: Math.floor(Date.now() / 1000),
          },
          kpBob.secretKey,
        );
        cb(confirmEvent);
      }, 10);
      return () => {};
    });

    const result = await sendBitcoinTxViaNostr('deadbeefhex', {
      nostrClient: client,
      timeoutMs: 500,
    });

    expect(result.success).toBe(true);
    expect(result.txid).toBe(TXID);
    expect(result.gatewayPubkey).toBe(kpBob.publicKey);
    expect(result.originalEventId).toBe(requestId);
  });

  test('rejette si gateway retourne success=false avec erreur', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const requestId = 'req-fail-' + Math.random().toString(36).slice(2);
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: requestId });

    (client as any).subscribe = jest.fn((filters: any[], cb: (e: any) => void) => {
      setTimeout(() => {
        const errorEvent = finalizeEvent(
          {
            kind: Kind.TxRelay,
            content: JSON.stringify({ success: false, error: 'invalid tx' }),
            tags: [['e', requestId], ['t', 'relay_result']],
            created_at: Math.floor(Date.now() / 1000),
          },
          kpBob.secretKey,
        );
        cb(errorEvent);
      }, 10);
      return () => {};
    });

    await expect(
      sendBitcoinTxViaNostr('badhex', { nostrClient: client, timeoutMs: 500 }),
    ).rejects.toThrow('invalid tx');
  });

  test('rejette si timeout atteint sans réponse', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: 'req-timeout' });
    (client as any).subscribe = jest.fn().mockReturnValue(() => {});

    await expect(
      sendBitcoinTxViaNostr('deadbeef', { nostrClient: client, timeoutMs: 50 }),
    ).rejects.toThrow(/Timeout/);
  }, 10_000);

  test('confirmation malformée ignorée — attend la suivante', async () => {
    const TXID = 'a'.repeat(64);
    const client = makeNostrClient(kpAlice.publicKey);
    const requestId = 'req-malformed';
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: requestId });

    (client as any).subscribe = jest.fn((filters: any[], cb: (e: any) => void) => {
      setTimeout(() => {
        // Premier event malformé
        const badEvent = finalizeEvent(
          {
            kind: Kind.TxRelay,
            content: '{ pas du json',
            tags: [['e', requestId], ['t', 'relay_result']],
            created_at: Math.floor(Date.now() / 1000),
          },
          kpBob.secretKey,
        );
        cb(badEvent);
      }, 5);

      setTimeout(() => {
        // Second event valide
        const goodEvent = finalizeEvent(
          {
            kind: Kind.TxRelay,
            content: JSON.stringify({ success: true, txid: TXID }),
            tags: [['e', requestId], ['t', 'relay_result']],
            created_at: Math.floor(Date.now() / 1000),
          },
          kpBob.secretKey,
        );
        cb(goodEvent);
      }, 20);

      return () => {};
    });

    const result = await sendBitcoinTxViaNostr('deadbeef', {
      nostrClient: client,
      timeoutMs: 500,
    });
    expect(result.txid).toBe(TXID);
  });
});

// ─── Tests sendCashuTokenViaNostr ─────────────────────────────────────────────

describe('sendCashuTokenViaNostr', () => {
  test('résout avec ack du gateway', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const requestId = 'req-cashu-' + Math.random().toString(36).slice(2);
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: requestId });

    (client as any).subscribe = jest.fn((filters: any[], cb: (e: any) => void) => {
      setTimeout(() => {
        const ackEvent = finalizeEvent(
          {
            kind: Kind.TxRelay,
            content: JSON.stringify({ success: true }),
            tags: [['e', requestId], ['t', 'relay_result']],
            created_at: Math.floor(Date.now() / 1000),
          },
          kpBob.secretKey,
        );
        cb(ackEvent);
      }, 10);
      return () => {};
    });

    const result = await sendCashuTokenViaNostr('cashuAeyJfake', undefined, {
      nostrClient: client,
      timeoutMs: 500,
    });

    expect(result.success).toBe(true);
    expect(result.gatewayPubkey).toBe(kpBob.publicKey);
    expect(result.originalEventId).toBe(requestId);
  });

  test('résout (non-fatal) si timeout — token reste valide', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: 'req-cashu-timeout' });
    (client as any).subscribe = jest.fn().mockReturnValue(() => {});

    const result = await sendCashuTokenViaNostr('cashuAeyJfake', undefined, {
      nostrClient: client,
      timeoutMs: 50,
    });

    // Non-fatal : success = false mais pas de throw
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Timeout/i);
    expect(result.gatewayPubkey).toBe('');
  }, 10_000);

  test('transmet targetMint au payload publié', async () => {
    const client = makeNostrClient(kpAlice.publicKey);
    const requestId = 'req-cashu-mint';
    (client as any).publishTxRelay = jest.fn().mockResolvedValue({ id: requestId });
    (client as any).subscribe = jest.fn().mockReturnValue(() => {});

    // Lance sans attendre (timeout)
    sendCashuTokenViaNostr('cashuAeyJfake', 'https://mint.example.com', {
      nostrClient: client,
      timeoutMs: 20,
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 5));

    expect((client as any).publishTxRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cashu_token',
        targetMint: 'https://mint.example.com',
      }),
    );
  });
});

// ─── Tests isTxAlreadyKnown ───────────────────────────────────────────────────

describe('isTxAlreadyKnown', () => {
  const cases = [
    ['txn-already-in-mempool', true],
    ['Transaction already in block chain', true],
    ['already known', true],
    ['duplicate', true],
    ['txn already in mempool', true],
    ['connection refused', false],
    ['insufficient funds', false],
    ['', false],
  ] as const;

  test.each(cases)('error "%s" → %s', (msg, expected) => {
    expect(isTxAlreadyKnown(new Error(msg))).toBe(expected);
  });
});
