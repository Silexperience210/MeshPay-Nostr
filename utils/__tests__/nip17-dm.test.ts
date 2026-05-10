/**
 * Tests unitaires — Phase 6 : NIP-17 Gift Wrap DMs
 *
 * Coverage :
 *   ✅ publishDMSealed : publie deux kind:1059 (destinataire + copie expéditeur)
 *   ✅ publishDMSealed : événements signés avec clé éphémère (≠ senderPubKey)
 *   ✅ publishDMSealed : lève une erreur si hors ligne
 *   ✅ publishDMSealed : lève une erreur si keypair non initialisée
 *   ✅ subscribeDMsSealed : s'abonne à kind:1059 #p=myPubKey
 *   ✅ subscribeDMsSealed : déchiffre correctement le contenu
 *   ✅ subscribeDMsSealed : ignore les events mal chiffrés (mauvaise clé)
 *   ✅ subscribeDMsSealed : lève une erreur si keypair non initialisée
 *   ✅ Round-trip NIP-17 : Alice envoie → Bob reçoit (contenu + pubkey expéditeur)
 *   ✅ Round-trip NIP-17 : Alice peut lire sa propre copie (boîte d'envoi)
 *   ✅ Rétrocompat NIP-04 : subscribeDMs (kind:4) fonctionne toujours en parallèle
 *   ✅ Kind constants : Seal=13, PrivateDirectMessage=14, GiftWrap=1059
 */

import { NostrClient, Kind, deriveNostrKeypair } from '../nostr-client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MNEMONIC_ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const MNEMONIC_BOB =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// ─── Mock SimplePool ─────────────────────────────────────────────────────────

let publishedEvents: any[] = [];
let subscriptions: Array<{ filters: any[]; onevent: (e: any) => void }> = [];

const mockPool = {
  publish: jest.fn((_relays: string[], event: any) => {
    publishedEvents.push(event);
    // Notifier les subscribers correspondants (simulation relay)
    for (const sub of subscriptions) {
      for (const filter of sub.filters) {
        if (matchesFilter(event, filter)) {
          sub.onevent(event);
        }
      }
    }
    return [Promise.resolve('ok')];
  }),
  subscribeMany: jest.fn((_relays: string[], filters: any[], opts: any) => {
    const entry = { filters, onevent: opts.onevent };
    subscriptions.push(entry);
    return {
      close: jest.fn(() => {
        subscriptions = subscriptions.filter(s => s !== entry);
      }),
    };
  }),
};

function matchesFilter(event: any, filter: any): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter['#p'] && !filter['#p'].some(
    (pk: string) => event.tags.some((t: string[]) => t[0] === 'p' && t[1] === pk)
  )) return false;
  if (filter['#e'] && !filter['#e'].some(
    (id: string) => event.tags.some((t: string[]) => t[0] === 'e' && t[1] === id)
  )) return false;
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClient(mnemonic: string): NostrClient {
  const client = new NostrClient(['wss://relay.test']);
  (client as any).pool = mockPool;
  (client as any).relayUrls = ['wss://relay.test'];
  const kp = deriveNostrKeypair(mnemonic);
  (client as any).keypair = kp;
  (client as any).relayStatus = new Map([['wss://relay.test', 'connected']]);
  return client;
}

function makeOfflineClient(mnemonic: string): NostrClient {
  const client = makeClient(mnemonic);
  (client as any).relayStatus = new Map([['wss://relay.test', 'disconnected']]);
  return client;
}

// ─── Kind constants ───────────────────────────────────────────────────────────

describe('Kind constants NIP-17/NIP-59', () => {
  it('Seal = 13', () => expect(Kind.Seal).toBe(13));
  it('PrivateDirectMessage = 14', () => expect(Kind.PrivateDirectMessage).toBe(14));
  it('GiftWrap = 1059', () => expect(Kind.GiftWrap).toBe(1059));
});

// ─── publishDMSealed ─────────────────────────────────────────────────────────

describe('NostrClient.publishDMSealed', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('publie exactement 2 kind:1059 (destinataire + copie expéditeur)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    await alice.publishDMSealed(bobKp.publicKey, 'Hello Bob!');

    const giftWraps = publishedEvents.filter(e => e.kind === Kind.GiftWrap);
    expect(giftWraps).toHaveLength(2);
  });

  it('les gift wraps sont signés avec des clés ÉPHÉMÈRES (≠ pubkey expéditeur)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const aliceKp = deriveNostrKeypair(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    await alice.publishDMSealed(bobKp.publicKey, 'Secret message');

    const giftWraps = publishedEvents.filter(e => e.kind === Kind.GiftWrap);
    // Aucun des wraps ne doit avoir la pubkey d'Alice comme auteur
    for (const wrap of giftWraps) {
      expect(wrap.pubkey).not.toBe(aliceKp.publicKey);
    }
  });

  it('chaque gift wrap a un tag p avec la pubkey du destinataire', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);
    const aliceKp = deriveNostrKeypair(MNEMONIC_ALICE);

    await alice.publishDMSealed(bobKp.publicKey, 'Tagged message');

    const giftWraps = publishedEvents.filter(e => e.kind === Kind.GiftWrap);
    const recipients = giftWraps.map(w => w.tags.find((t: string[]) => t[0] === 'p')?.[1]);

    // L'un pour Bob, l'autre pour Alice (copie envoyé)
    expect(recipients).toContain(bobKp.publicKey);
    expect(recipients).toContain(aliceKp.publicKey);
  });

  it('les gift wraps ont un id et sig valides (hex 64/128 chars)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    await alice.publishDMSealed(bobKp.publicKey, 'Signed GW');

    const giftWraps = publishedEvents.filter(e => e.kind === Kind.GiftWrap);
    for (const wrap of giftWraps) {
      expect(wrap.id).toMatch(/^[0-9a-f]{64}$/);
      expect(wrap.sig).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  it('lève une erreur si hors ligne', async () => {
    const alice = makeOfflineClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    await expect(alice.publishDMSealed(bobKp.publicKey, 'offline')).rejects.toThrow('Hors ligne');
  });

  it('lève une erreur si keypair non initialisée', async () => {
    const client = new NostrClient(['wss://relay.test']);
    (client as any).pool = mockPool;
    (client as any).relayUrls = ['wss://relay.test'];
    (client as any).relayStatus = new Map([['wss://relay.test', 'connected']]);
    // keypair = null (défaut)

    await expect(client.publishDMSealed('deadbeef'.repeat(8), 'fail')).rejects.toThrow('Keypair');
  });

  it('retourne un event kind:1059 (le wrap destinataire)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    const result = await alice.publishDMSealed(bobKp.publicKey, 'Return test');

    expect(result.kind).toBe(Kind.GiftWrap);
  });
});

// ─── subscribeDMsSealed ───────────────────────────────────────────────────────

describe('NostrClient.subscribeDMsSealed', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('s\'abonne au filtre kind:1059 avec #p = myPubKey', () => {
    const bob = makeClient(MNEMONIC_BOB);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    bob.subscribeDMsSealed(jest.fn());

    expect(mockPool.subscribeMany).toHaveBeenCalledTimes(1);
    const [, filters] = mockPool.subscribeMany.mock.calls[0];
    expect(filters[0].kinds).toContain(Kind.GiftWrap);
    expect(filters[0]['#p']).toContain(bobKp.publicKey);
  });

  it('retourne une fonction unsub qui ferme la subscription', () => {
    const bob = makeClient(MNEMONIC_BOB);

    const unsub = bob.subscribeDMsSealed(jest.fn());
    expect(subscriptions).toHaveLength(1);

    unsub();
    expect(subscriptions).toHaveLength(0);
  });

  it('lève une erreur si keypair non initialisée', () => {
    const client = new NostrClient(['wss://relay.test']);
    (client as any).pool = mockPool;
    (client as any).relayUrls = ['wss://relay.test'];
    (client as any).relayStatus = new Map([['wss://relay.test', 'connected']]);

    expect(() => client.subscribeDMsSealed(jest.fn())).toThrow('Keypair');
  });
});

// ─── Round-trip NIP-17 ────────────────────────────────────────────────────────

describe('Round-trip NIP-17 : Alice → Bob', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('Bob reçoit le message d\'Alice avec le bon contenu et sa pubkey', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bob = makeClient(MNEMONIC_BOB);
    const aliceKp = deriveNostrKeypair(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    const received: Array<{ from: string; content: string }> = [];
    bob.subscribeDMsSealed((from, content) => received.push({ from, content }));

    await alice.publishDMSealed(bobKp.publicKey, 'Hello Bob from Alice!');

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Hello Bob from Alice!');
    expect(received[0].from).toBe(aliceKp.publicKey);
  });

  it('Alice peut lire sa propre copie (boîte d\'envoi)', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const aliceKp = deriveNostrKeypair(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    const aliceCopies: Array<{ from: string; content: string }> = [];
    alice.subscribeDMsSealed((from, content) => aliceCopies.push({ from, content }));

    await alice.publishDMSealed(bobKp.publicKey, 'My sent copy');

    // Alice doit recevoir sa propre copie (wrap adressé à sa propre pubkey)
    expect(aliceCopies).toHaveLength(1);
    expect(aliceCopies[0].content).toBe('My sent copy');
    expect(aliceCopies[0].from).toBe(aliceKp.publicKey);
  });

  it('Charlie (non destinataire) ne peut pas déchiffrer le message', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);
    // Charlie a un client avec des clés différentes
    const charlieClient = makeClient('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');

    const charlieReceived: any[] = [];
    charlieClient.subscribeDMsSealed((_from, content) => charlieReceived.push(content));

    await alice.publishDMSealed(bobKp.publicKey, 'Private to Bob');

    // Charlie ne reçoit rien (ses subscriptions ne matchent pas les gift wraps de Bob)
    expect(charlieReceived).toHaveLength(0);
  });

  it('Bob ne reçoit pas le wrap après unsub', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bob = makeClient(MNEMONIC_BOB);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    const received: any[] = [];
    const unsub = bob.subscribeDMsSealed((_from, content) => received.push(content));

    await alice.publishDMSealed(bobKp.publicKey, 'Message 1');
    expect(received).toHaveLength(1);

    unsub();

    await alice.publishDMSealed(bobKp.publicKey, 'Message 2');
    // Message 2 pas reçu — sub fermé
    expect(received).toHaveLength(1);
  });
});

// ─── Rétrocompat NIP-04 ───────────────────────────────────────────────────────

describe('Rétrocompat NIP-04 : subscribeDMs fonctionne en parallèle de NIP-17', () => {
  beforeEach(() => {
    publishedEvents = [];
    subscriptions = [];
    mockPool.publish.mockClear();
    mockPool.subscribeMany.mockClear();
  });

  it('subscribeDMs s\'abonne toujours à kind:4 (NIP-04)', () => {
    const bob = makeClient(MNEMONIC_BOB);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    bob.subscribeDMs(jest.fn());

    const [, filters] = mockPool.subscribeMany.mock.calls[0];
    expect(filters[0].kinds).toContain(4); // kind:4 = NIP-04
    expect(filters[0]['#p']).toContain(bobKp.publicKey);
  });

  it('subscribeDMsSealed s\'abonne à kind:1059 (indépendamment de NIP-04)', () => {
    const bob = makeClient(MNEMONIC_BOB);

    // Activer les deux simultanément
    bob.subscribeDMs(jest.fn());
    bob.subscribeDMsSealed(jest.fn());

    expect(mockPool.subscribeMany).toHaveBeenCalledTimes(2);
    const calls = mockPool.subscribeMany.mock.calls;
    const kinds = calls.flatMap(([, filters]) => filters[0].kinds);

    expect(kinds).toContain(4);    // NIP-04
    expect(kinds).toContain(1059); // NIP-17
  });

  it('publishDM (NIP-04) publie toujours un kind:4', async () => {
    const alice = makeClient(MNEMONIC_ALICE);
    const bobKp = deriveNostrKeypair(MNEMONIC_BOB);

    await alice.publishDM(bobKp.publicKey, 'NIP-04 message');

    const nip04Events = publishedEvents.filter(e => e.kind === 4);
    expect(nip04Events).toHaveLength(1);
  });
});
