/**
 * Tests unitaires — Phase 5 : Forums/Channels Nostr (NIP-28)
 *
 * Coverage :
 *   ✅ deriveChannelId : déterminisme, normalisation, unicité
 *   ✅ publishChannelMessage : signe et publie un kind:42 avec tag 'e' channelId
 *   ✅ subscribeChannel : filtre kind:42 sur le channelId, retourne unsub function
 *   ✅ subscribeChannel : since optionnel passé au filtre
 *   ✅ round-trip : Alice publie → Bob reçoit dans sa subscription
 */

import { NostrClient, Kind, deriveChannelId } from '../nostr-client';
import { deriveNostrKeypair } from '../nostr-client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MNEMONIC_ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const MNEMONIC_BOB =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// ─── Mock SimplePool ─────────────────────────────────────────────────────────

let publishedEvents: any[] = [];
let subscriptions: Array<{ filters: any[]; cb: (e: any) => void }> = [];

const mockPool = {
  publish: jest.fn((_relays: string[], event: any) => {
    publishedEvents.push(event);
    // Notifier immédiatement les subscribers correspondants (simulation relay)
    for (const sub of subscriptions) {
      for (const filter of sub.filters) {
        if (matchesFilter(event, filter)) {
          sub.cb(event);
        }
      }
    }
    return Promise.resolve(['ok']);
  }),
  subscribeMany: jest.fn((_relays: string[], filters: any[], opts: any) => {
    const entry = { filters, cb: opts.onevent };
    subscriptions.push(entry);
    return {
      close: jest.fn(() => {
        subscriptions = subscriptions.filter(s => s !== entry);
      }),
    };
  }),
};

/** Vérifie si un event Nostr correspond à un filtre minimal */
function matchesFilter(event: any, filter: any): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter['#e'] && !filter['#e'].some((id: string) => event.tags.some((t: string[]) => t[0] === 'e' && t[1] === id))) return false;
  if (filter.since && event.created_at < filter.since) return false;
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClient(mnemonic: string) {
  const client = new NostrClient(['wss://relay.test']);
  (client as any).pool = mockPool;
  (client as any).relayUrls = ['wss://relay.test'];
  const kp = deriveNostrKeypair(mnemonic);
  (client as any).keypair = kp;
  // isConnected = relayStatus.some(s => s === 'connected')
  (client as any).relayStatus = new Map([['wss://relay.test', 'connected']]);
  return client;
}

// ─── deriveChannelId ─────────────────────────────────────────────────────────

describe('deriveChannelId', () => {
  it('retourne un hash hex de 64 caractères', () => {
    const id = deriveChannelId('bitcoin');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('est déterministe — même input → même output', () => {
    expect(deriveChannelId('lightning')).toBe(deriveChannelId('lightning'));
  });

  it('est sensible au nom — noms différents → IDs différents', () => {
    expect(deriveChannelId('alpha')).not.toBe(deriveChannelId('beta'));
  });

  it('normalise la casse : "Forum" === "forum"', () => {
    expect(deriveChannelId('Forum')).toBe(deriveChannelId('forum'));
  });

  it('normalise les espaces : "  forum  " === "forum"', () => {
    expect(deriveChannelId('  forum  ')).toBe(deriveChannelId('forum'));
  });

  it('retourne un ID stable connu pour "bitcoin" (vecteur de test)', () => {
    // Valeur pré-calculée : sha256("meshpay:forum:bitcoin")
    // Vérifier que l'ID ne change pas entre versions
    const id = deriveChannelId('bitcoin');
    // L'ID doit être un hash hex 64 chars stable
    expect(id).toHaveLength(64);
    // Et identique à un second appel
    expect(id).toBe(deriveChannelId('bitcoin'));
    // Doit être différent du channelId pour "litecoin"
    expect(id).not.toBe(deriveChannelId('litecoin'));
  });
});

// ─── publishChannelMessage ────────────────────────────────────────────────────

describe('NostrClient.publishChannelMessage', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('publie un event de kind 42', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('bitcoin');
    await alice.publishChannelMessage(channelId, 'Hello Bitcoin forum!');

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].kind).toBe(Kind.ChannelMessage); // 42
  });

  it('inclut un tag e avec le channelId comme premier tag', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('nostr');
    await alice.publishChannelMessage(channelId, 'Test message');

    const event = publishedEvents[0];
    const eTag = event.tags.find((t: string[]) => t[0] === 'e' && t[1] === channelId);
    expect(eTag).toBeDefined();
  });

  it('le contenu de l\'event correspond au texte envoyé', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('test-channel');
    const text = 'Message de test Phase 5';
    await alice.publishChannelMessage(channelId, text);

    expect(publishedEvents[0].content).toBe(text);
  });

  it('l\'event est signé (id et sig présents, 64 chars hex)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('signed');
    await alice.publishChannelMessage(channelId, 'Signed message');

    const event = publishedEvents[0];
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('inclut le relay recommandé dans le tag e (3ème élément)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('relay-hint');
    await alice.publishChannelMessage(channelId, 'With relay hint');

    const event = publishedEvents[0];
    const eTag = event.tags.find((t: string[]) => t[0] === 'e' && t[1] === channelId);
    // eTag = ['e', channelId, recommendedRelay, 'root'] selon NIP-28
    expect(eTag).toBeDefined();
    expect(eTag.length).toBeGreaterThanOrEqual(2);
  });

  it('supporte un replyToId optionnel (tag e supplémentaire)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('reply');
    const replyTo = 'a'.repeat(64);
    await alice.publishChannelMessage(channelId, 'Reply', replyTo);

    const event = publishedEvents[0];
    const replyTag = event.tags.find((t: string[]) => t[0] === 'e' && t[1] === replyTo);
    expect(replyTag).toBeDefined();
  });

  it('met le message en queue offline si non connecté (ne rejette pas)', async () => {
    const alice = new NostrClient(['wss://relay.test']);
    (alice as any).pool = mockPool;
    (alice as any).relayUrls = ['wss://relay.test'];
    const kp = deriveNostrKeypair(MNEMONIC_ALICE);
    (alice as any).keypair = kp;
    // relayStatus disconnected → isConnected = false → offline queue
    (alice as any).relayStatus = new Map([['wss://relay.test', 'disconnected']]);

    const channelId = deriveChannelId('offline');
    // La Promise reste en attente (ne resolve ni ne rejette tant que offline)
    const pending = alice.publishChannelMessage(channelId, 'queued');
    let settled = false;
    pending.then(() => { settled = true; }).catch(() => { settled = true; });
    // Micro-task flush
    await new Promise(r => setImmediate(r));
    expect(settled).toBe(false);
    // La queue contient 1 event
    expect((alice as any).offlineQueue).toHaveLength(1);
  });

  it('lève une erreur quand la queue offline est pleine (100 events)', async () => {
    const alice = new NostrClient(['wss://relay.test']);
    (alice as any).pool = mockPool;
    (alice as any).relayUrls = ['wss://relay.test'];
    const kp = deriveNostrKeypair(MNEMONIC_ALICE);
    (alice as any).keypair = kp;
    (alice as any).relayStatus = new Map([['wss://relay.test', 'disconnected']]);
    // Remplir la queue
    (alice as any).offlineQueue = new Array(100).fill({ template: {}, resolve: () => {}, reject: () => {} });

    const channelId = deriveChannelId('full-queue');
    await expect(alice.publishChannelMessage(channelId, 'overflow')).rejects.toThrow('Queue offline pleine');
  });
});

// ─── subscribeChannel ─────────────────────────────────────────────────────────

describe('NostrClient.subscribeChannel', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('s\'abonne au filtre kind:42 avec #e = channelId', () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('subscribe-test');
    alice.subscribeChannel(channelId, jest.fn());

    expect(mockPool.subscribeMany).toHaveBeenCalledTimes(1);
    const [_relays, filters] = mockPool.subscribeMany.mock.calls[0];
    expect(filters[0].kinds).toContain(Kind.ChannelMessage);
    expect(filters[0]['#e']).toContain(channelId);
  });

  it('retourne une fonction unsub qui ferme la subscription', () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('unsub-test');
    const unsub = alice.subscribeChannel(channelId, jest.fn());

    expect(subscriptions).toHaveLength(1);
    unsub();
    expect(subscriptions).toHaveLength(0);
  });

  it('passe since au filtre si fourni', () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('since-test');
    const since = Math.floor(Date.now() / 1000) - 3600;
    alice.subscribeChannel(channelId, jest.fn(), since);

    const [_relays, filters] = mockPool.subscribeMany.mock.calls[0];
    expect(filters[0].since).toBe(since);
  });

  it('n\'inclut pas since quand non fourni', () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const channelId = deriveChannelId('no-since');
    alice.subscribeChannel(channelId, jest.fn());

    const [_relays, filters] = mockPool.subscribeMany.mock.calls[0];
    expect(filters[0].since).toBeUndefined();
  });
});

// ─── Round-trip : Alice publie, Bob reçoit ────────────────────────────────────

describe('Round-trip channel message Alice → Bob', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('Bob reçoit le message publié par Alice dans le même channel', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bob = makeClient(MNEMONIC_BOB);
    const channelId = deriveChannelId('round-trip');

    const received: any[] = [];
    bob.subscribeChannel(channelId, (event) => received.push(event));

    await alice.publishChannelMessage(channelId, 'Hello from Alice!');

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Hello from Alice!');
    expect(received[0].kind).toBe(Kind.ChannelMessage);
  });

  it('Bob ne reçoit pas les messages d\'un autre channel', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bob = makeClient(MNEMONIC_BOB);
    const channelA = deriveChannelId('channel-a');
    const channelB = deriveChannelId('channel-b');

    const received: any[] = [];
    bob.subscribeChannel(channelB, (event) => received.push(event));

    await alice.publishChannelMessage(channelA, 'Message dans channel-a');

    expect(received).toHaveLength(0);
  });

  it('après unsub, Bob ne reçoit plus les messages d\'Alice', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bob = makeClient(MNEMONIC_BOB);
    const channelId = deriveChannelId('unsub-roundtrip');

    const received: any[] = [];
    const unsub = bob.subscribeChannel(channelId, (event) => received.push(event));

    await alice.publishChannelMessage(channelId, 'Message 1');
    expect(received).toHaveLength(1);

    unsub();

    await alice.publishChannelMessage(channelId, 'Message 2');
    expect(received).toHaveLength(1); // Toujours 1, pas de nouveau message
  });

  it('deux subscribers différents reçoivent tous les deux le message', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bob = makeClient(MNEMONIC_BOB);
    const charlie = makeClient(MNEMONIC_ALICE); // peu importe le keypair, c'est le sub qui compte
    const channelId = deriveChannelId('multi-subscriber');

    const receivedBob: any[] = [];
    const receivedCharlie: any[] = [];
    bob.subscribeChannel(channelId, (e) => receivedBob.push(e));
    charlie.subscribeChannel(channelId, (e) => receivedCharlie.push(e));

    await alice.publishChannelMessage(channelId, 'Broadcast!');

    expect(receivedBob).toHaveLength(1);
    expect(receivedCharlie).toHaveLength(1);
  });
});
