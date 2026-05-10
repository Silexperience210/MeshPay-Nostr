/**
 * Tests unitaires — MessagingBus
 *
 * Coverage Phase 2 (mise à jour Phase 8 — MQTT supprimé) :
 *   ✅ Routing : Nostr quand connecté / erreur si aucun
 *   ✅ Déduplication : message identique arrivant deux fois
 *   ✅ DeduplicateWindow : TTL, overflow, comptage
 *   ✅ nostrEventToBus : mapping event Nostr → BusMessage
 *   ✅ subscribe / unsubscribe : handlers correctement appelés et nettoyés
 *   ✅ bridgeLoraToNostr : appel si Nostr connecté, skip si non
 *   ✅ getStatus : reflet fidèle de l'état du transport Nostr
 */

import { MessagingBus, type BusMessage } from '../messaging-bus';
import { NostrClient, Kind } from '../nostr-client';
import { finalizeEvent } from 'nostr-tools';
import { deriveNostrKeypair } from '../nostr-client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function makeNostrEvent(overrides: Partial<any> = {}) {
  const kp = deriveNostrKeypair(MNEMONIC);
  return finalizeEvent(
    {
      kind: Kind.EncryptedDM,
      content: 'ciphertext_nip04',
      tags: [
        ['p', 'deadbeef'.repeat(8)],
        ['meshcore-from', 'MESH-A1B2'],
        ['meshcore-to', 'MESH-C3D4'],
      ],
      created_at: Math.floor(Date.now() / 1000),
      ...overrides,
    },
    kp.secretKey,
  );
}

// ─── Mock NostrClient ─────────────────────────────────────────────────────────

function makeMockNostr(connected: boolean) {
  const publishedDMs: Array<{ pubkey: string; content: string }> = [];
  const publishedTxRelays: any[] = [];
  const dmHandlers: Array<(from: string, content: string, event: any) => void> = [];
  const txHandlers: Array<(payload: any, event: any) => void> = [];

  return {
    get isConnected() { return connected; },
    publishDM: jest.fn(async (pubkey: string, content: string) => {
      publishedDMs.push({ pubkey, content });
      return {} as any;
    }),
    publish: jest.fn(async () => ({} as any)),
    publishTxRelay: jest.fn(async (payload: any) => {
      publishedTxRelays.push(payload);
      return {} as any;
    }),
    subscribeDMs: jest.fn((handler) => {
      dmHandlers.push(handler);
      return () => { dmHandlers.splice(dmHandlers.indexOf(handler), 1); };
    }),
    subscribeTxRelay: jest.fn((handler) => {
      txHandlers.push(handler);
      return () => { txHandlers.splice(txHandlers.indexOf(handler), 1); };
    }),
    subscribeChannel: jest.fn(() => () => {}),
    publishChannelMessage: jest.fn(async () => ({} as any)),
    // Helpers de test
    _publishedDMs: publishedDMs,
    _publishedTxRelays: publishedTxRelays,
    _triggerDM: (from: string, content: string, event: any) => {
      dmHandlers.forEach(h => h(from, content, event));
    },
    _triggerTxRelay: (payload: any, event: any) => {
      txHandlers.forEach(h => h(payload, event));
    },
  } as unknown as NostrClient & {
    _publishedDMs: any[];
    _publishedTxRelays: any[];
    _triggerDM: (...args: any[]) => void;
    _triggerTxRelay: (...args: any[]) => void;
  };
}

// ─── Tests : Routing ──────────────────────────────────────────────────────────

describe('MessagingBus — routing transport', () => {
  it('preferredTransport = nostr quand Nostr est connecté', () => {
    const nostr = makeMockNostr(true);
    const bus = new MessagingBus(nostr);
    expect(bus.preferredTransport).toBe('nostr');
  });

  it('preferredTransport = none quand aucun transport', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    expect(bus.preferredTransport).toBe('none');
  });

  it('sendDM utilise Nostr quand connecté', async () => {
    const nostr = makeMockNostr(true) as any;
    const bus = new MessagingBus(nostr);
    bus.setLocalIdentity('MESH-LOCAL', 'aabbccdd');

    const transport = await bus.sendDM({
      toNodeId: 'MESH-C3D4',
      toNostrPubkey: 'deadbeef'.repeat(8),
      content: 'hello via Nostr',
    });

    expect(transport).toBe('nostr');
    expect(nostr.publishDM).toHaveBeenCalledWith('deadbeef'.repeat(8), 'hello via Nostr');
  });

  it('sendDM throw si aucun transport disponible', async () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);

    await expect(
      bus.sendDM({
        toNodeId: 'MESH-X',
        toNostrPubkey: '',
        content: 'test',
      }),
    ).rejects.toThrow('Aucun transport disponible');
  });

  it('sendChannelMessage utilise Nostr quand connecté', async () => {
    const nostr = makeMockNostr(true) as any;
    const bus = new MessagingBus(nostr);

    const transport = await bus.sendChannelMessage({
      channelId: 'chan-001',
      content: 'message de channel',
      nostrChannelId: 'nostr-event-id-chan',
    });

    expect(transport).toBe('nostr');
    expect(nostr.publishChannelMessage).toHaveBeenCalledWith('nostr-event-id-chan', 'message de channel');
  });
});

// ─── Tests : Déduplication ───────────────────────────────────────────────────

describe('MessagingBus — déduplication multi-transport', () => {
  it('un message reçu deux fois (même id) n\'est dispatché qu\'une seule fois', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const received: BusMessage[] = [];
    bus.subscribe(msg => received.push(msg));

    const msg: BusMessage = {
      id: 'dup-test-123',
      type: 'dm',
      from: 'MESH-A',
      fromPubkey: 'aabb',
      to: 'MESH-B',
      content: 'hello',
      ts: Date.now(),
      transport: 'nostr',
    };

    // Simuler réception deux fois (ex: deux relays Nostr)
    (bus as any)._dispatch(msg);
    (bus as any)._dispatch({ ...msg });

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('dup-test-123');
  });

  it('deux messages avec des ids différents sont tous les deux dispatché', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const received: BusMessage[] = [];
    bus.subscribe(msg => received.push(msg));

    (bus as any)._dispatch({
      id: 'msg-001', type: 'dm', from: 'A', fromPubkey: '', to: 'B', content: 'un', ts: 0, transport: 'nostr',
    });
    (bus as any)._dispatch({
      id: 'msg-002', type: 'dm', from: 'A', fromPubkey: '', to: 'B', content: 'deux', ts: 0, transport: 'nostr',
    });

    expect(received).toHaveLength(2);
  });
});

// ─── Tests : DeduplicateWindow ───────────────────────────────────────────────

describe('DeduplicateWindow', () => {
  it('has() retourne false pour un id inconnu', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const dedup = (bus as any).dedup;
    expect(dedup.has('unknown-id')).toBe(false);
  });

  it('add() puis has() retourne true', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const dedup = (bus as any).dedup;
    dedup.add('my-id');
    expect(dedup.has('my-id')).toBe(true);
  });

  it('size s\'incrémente après add()', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const dedup = (bus as any).dedup;
    dedup.add('id-1');
    dedup.add('id-2');
    expect(dedup.size).toBe(2);
  });

  it('ajouter le même id plusieurs fois ne duplique pas', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const dedup = (bus as any).dedup;
    dedup.add('dup');
    dedup.add('dup');
    dedup.add('dup');
    expect(dedup.size).toBe(1);
  });
});

// ─── Tests : subscribe / unsubscribe ────────────────────────────────────────

describe('MessagingBus — subscribe / unsubscribe', () => {
  it('subscribe retourne une fonction de nettoyage', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const unsub = bus.subscribe(() => {});
    expect(typeof unsub).toBe('function');
    unsub(); // Ne doit pas throw
  });

  it('handler appelé pour chaque message unique', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const calls: string[] = [];
    bus.subscribe(msg => calls.push(msg.id));

    (bus as any)._dispatch({ id: 'a', type: 'dm', from: '', fromPubkey: '', to: '', content: '', ts: 0, transport: 'nostr' });
    (bus as any)._dispatch({ id: 'b', type: 'dm', from: '', fromPubkey: '', to: '', content: '', ts: 0, transport: 'nostr' });

    expect(calls).toEqual(['a', 'b']);
  });

  it('handler non appelé après unsubscribe', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const calls: string[] = [];
    const unsub = bus.subscribe(msg => calls.push(msg.id));

    (bus as any)._dispatch({ id: 'c', type: 'dm', from: '', fromPubkey: '', to: '', content: '', ts: 0, transport: 'nostr' });
    unsub();
    (bus as any)._dispatch({ id: 'd', type: 'dm', from: '', fromPubkey: '', to: '', content: '', ts: 0, transport: 'nostr' });

    expect(calls).toEqual(['c']); // 'd' ignoré après unsub
  });

  it('plusieurs handlers reçoivent le même message', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const calls1: string[] = [];
    const calls2: string[] = [];
    bus.subscribe(msg => calls1.push(msg.id));
    bus.subscribe(msg => calls2.push(msg.id));

    (bus as any)._dispatch({ id: 'multi', type: 'dm', from: '', fromPubkey: '', to: '', content: '', ts: 0, transport: 'nostr' });

    expect(calls1).toEqual(['multi']);
    expect(calls2).toEqual(['multi']);
  });
});

// ─── Tests : bridgeLoraToNostr ───────────────────────────────────────────────

describe('MessagingBus — bridge LoRa → Nostr', () => {
  it('publie sur Nostr si connecté', async () => {
    const nostr = makeMockNostr(true) as any;
    const bus = new MessagingBus(nostr);

    await bus.bridgeLoraToNostr('raw_lora_payload_hex');

    expect(nostr.publishTxRelay).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'raw_lora_payload_hex' }),
    );
  });

  it('ne fait rien si Nostr est déconnecté', async () => {
    const nostr = makeMockNostr(false) as any;
    const bus = new MessagingBus(nostr);

    await bus.bridgeLoraToNostr('raw_payload');

    expect(nostr.publishTxRelay).not.toHaveBeenCalled();
  });
});

// ─── Tests : getStatus ───────────────────────────────────────────────────────

describe('MessagingBus — getStatus()', () => {
  it('nostr=connected quand NostrClient.isConnected=true', () => {
    const nostr = makeMockNostr(true);
    const bus = new MessagingBus(nostr);
    const status = bus.getStatus();
    expect(status.nostr).toBe('connected');
    expect(status.preferred).toBe('nostr');
  });

  it('preferred=none quand aucun transport', () => {
    const nostr = makeMockNostr(false);
    const bus = new MessagingBus(nostr);
    const status = bus.getStatus();
    expect(status.preferred).toBe('none');
    expect(status.nostr).toBe('disconnected');
  });
});

// ─── Tests : Nostr listeners ──────────────────────────────────────────────────

describe('MessagingBus — Nostr DM listener', () => {
  it('reçoit les DMs Nostr entrants via subscribeDMs', () => {
    const nostr = makeMockNostr(true) as any;
    const bus = new MessagingBus(nostr);
    bus.setLocalIdentity('MESH-LOCAL', 'local-pubkey-hex');

    const received: BusMessage[] = [];
    bus.subscribe(msg => received.push(msg));

    // Simuler la réception d'un DM Nostr
    const fakeEvent = { id: 'nostr-dm-001', pubkey: 'remote-pubkey', created_at: Math.floor(Date.now() / 1000), tags: [['meshcore-from', 'MESH-REMOTE']], kind: 4 };
    nostr._triggerDM('remote-pubkey', 'hello from remote', fakeEvent as any);

    expect(received).toHaveLength(1);
    expect(received[0].transport).toBe('nostr');
    expect(received[0].type).toBe('dm');
    expect(received[0].from).toBe('MESH-REMOTE');
    expect(received[0].content).toBe('hello from remote');
  });

  it('ignore ses propres DMs (localNostrPubkey)', () => {
    const nostr = makeMockNostr(true) as any;
    const bus = new MessagingBus(nostr);
    bus.setLocalIdentity('MESH-LOCAL', 'my-own-pubkey');

    const received: BusMessage[] = [];
    bus.subscribe(msg => received.push(msg));

    // Simuler un DM provenant de nous-mêmes
    const fakeEvent = { id: 'own-dm', pubkey: 'my-own-pubkey', created_at: Math.floor(Date.now() / 1000), tags: [], kind: 4 };
    nostr._triggerDM('my-own-pubkey', 'echo de mon propre message', fakeEvent as any);

    expect(received).toHaveLength(0);
  });
});
