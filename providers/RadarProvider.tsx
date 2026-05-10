/**
 * RadarProvider — Contexte dédié radar (radarPeers + myLocation)
 *
 * ✅ AMÉLIORÉ : fusion peers Nostr + LoRa (GatewayPeer) avec champ transport
 *
 * - Peers Nostr  → transport: 'nostr' (découverte via subscribePresence)
 * - Peers LoRa   → transport: 'lora'  (découverts via gatewayState.peers)
 * - Peer des deux → transport: 'both' (merge automatique par nodeId)
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import { type RadarPeer, type PeerTransport, haversineDistance, gpsBearing, distanceToSignal } from '@/utils/radar';
import { nostrClient } from '@/utils/nostr-client';
import { useNostr } from '@/providers/NostrProvider';
import { useMessages } from '@/providers/MessagesProvider';
import { useGateway } from '@/providers/GatewayProvider';
import { useAppSettings } from '@/providers/AppSettingsProvider';

interface RadarState {
  radarPeers: RadarPeer[];
  myLocation: { lat: number; lng: number } | null;
}

const RadarContext = createContext<RadarState>({
  radarPeers: [],
  myLocation: null,
});

export function useRadar(): RadarState {
  return useContext(RadarContext);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fusionne le transport de deux sources pour un même peer */
function mergeTransport(existing: PeerTransport, incoming: PeerTransport): PeerTransport {
  if (existing === incoming) return existing;
  return 'both';
}

/** Génère position pseudo-aléatoire déterministe pour peers sans GPS */
function pseudoPosition(nodeId: string): { distanceMeters: number; bearingRad: number } {
  const hash = nodeId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    distanceMeters: 500 + (hash % 4000),
    bearingRad: (hash % 628) / 100,
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function RadarProvider({ children }: { children: React.ReactNode }) {
  const { identity } = useMessages();
  const { isConnected: nostrConnected } = useNostr();
  const { gatewayState } = useGateway();
  const { isLoRaMode } = useAppSettings();

  const [radarPeers, setRadarPeers] = useState<RadarPeer[]>([]);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);

  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  // ── Batched debounce — applique les mises à jour en un seul setState ──────
  const peerBatchRef = useRef<Map<string, RadarPeer>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queuePeerUpdate = useCallback((peer: RadarPeer) => {
    if (peer.online) {
      // Fusion transport si le peer existe déjà dans le batch
      const existing = peerBatchRef.current.get(peer.nodeId);
      if (existing) {
        peerBatchRef.current.set(peer.nodeId, {
          ...peer,
          transport: mergeTransport(existing.transport, peer.transport),
          // Garde le meilleur signal
          signalStrength: Math.max(existing.signalStrength, peer.signalStrength),
        });
      } else {
        peerBatchRef.current.set(peer.nodeId, peer);
      }
    } else {
      peerBatchRef.current.delete(peer.nodeId);
    }

    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      const batch = new Map(peerBatchRef.current);
      peerBatchRef.current.clear();
      setRadarPeers(prev => {
        // Fusionne avec les peers existants (transport merge)
        const prevMap = new Map(prev.map(p => [p.nodeId, p]));
        for (const [nodeId, newPeer] of batch.entries()) {
          const old = prevMap.get(nodeId);
          if (old) {
            prevMap.set(nodeId, {
              ...newPeer,
              transport: mergeTransport(old.transport, newPeer.transport),
              signalStrength: Math.max(old.signalStrength, newPeer.signalStrength),
            });
          } else {
            prevMap.set(nodeId, newPeer);
          }
        }
        return Array.from(prevMap.values());
      });
    }, 300);
  }, []);

  // ── GPS : permission + watch ──────────────────────────────────────────────
  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (cancelled) return;

      const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setMyLocation(pos);
      myLocationRef.current = pos;

      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
        (location) => {
          if (cancelled) return;
          const p = { lat: location.coords.latitude, lng: location.coords.longitude };
          setMyLocation(p);
          myLocationRef.current = p;
          if (nostrClient.isConnected && identity && !isLoRaMode) {
            nostrClient.publishPresence(identity.nodeId, p.lat, p.lng).catch(() => {});
          }
        }
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [identity]);

  // ── Peers Nostr (subscribePresence) ──────────────────────────────────────
  useEffect(() => {
    if (!nostrConnected || !identity || isLoRaMode) return;

    const unsub = nostrClient.subscribePresence((payload, _event) => {
      if (payload.nodeId === identity.nodeId) return;

      const myPos = myLocationRef.current;
      let distanceMeters: number;
      let bearingRad: number;

      if (myPos && payload.lat !== undefined && payload.lng !== undefined) {
        distanceMeters = haversineDistance(myPos.lat, myPos.lng, payload.lat, payload.lng);
        bearingRad = gpsBearing(myPos.lat, myPos.lng, payload.lat, payload.lng);
      } else {
        ({ distanceMeters, bearingRad } = pseudoPosition(payload.nodeId));
      }

      queuePeerUpdate({
        nodeId: payload.nodeId,
        name: payload.name ?? payload.nodeId,
        distanceMeters,
        bearingRad,
        online: payload.online,
        transport: 'nostr',                          // ← source Nostr
        lat: payload.lat,
        lng: payload.lng,
        lastSeen: payload.ts,
        signalStrength: distanceToSignal(distanceMeters),
      });
    });

    return () => unsub();
  }, [nostrConnected, identity, queuePeerUpdate]);

  // ── Peers LoRa (gatewayState.peers — BLE/MeshCore) ───────────────────────
  useEffect(() => {
    if (!gatewayState?.peers?.length) return;

    const now = Date.now();
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    for (const loraPeer of gatewayState.peers) {
      // Ignore les peers trop anciens
      if (now - loraPeer.lastSeen > STALE_THRESHOLD_MS) continue;
      // Ignore nous-mêmes
      if (loraPeer.nodeId === identity?.nodeId) continue;

      const myPos = myLocationRef.current;
      let distanceMeters: number;
      let bearingRad: number;

      // Les peers LoRa n'ont pas de GPS — position déterministe + distance simulée par hops
      const hopDistance = (loraPeer.hops ?? 1) * 1200; // ~1.2km par hop
      if (myPos) {
        const pseudo = pseudoPosition(loraPeer.nodeId);
        distanceMeters = Math.min(hopDistance, pseudo.distanceMeters);
        bearingRad = pseudo.bearingRad;
      } else {
        ({ distanceMeters, bearingRad } = pseudoPosition(loraPeer.nodeId));
        distanceMeters = Math.min(distanceMeters, hopDistance);
      }

      queuePeerUpdate({
        nodeId: loraPeer.nodeId,
        name: loraPeer.name,
        distanceMeters,
        bearingRad,
        online: true,
        transport: 'lora',                           // ← source LoRa
        hops: loraPeer.hops,
        lastSeen: loraPeer.lastSeen,
        signalStrength: loraPeer.signalStrength,     // RSSI réel depuis GatewayPeer
      });
    }
  }, [gatewayState?.peers, identity?.nodeId, queuePeerUpdate]);

  // ── Nettoyage peers inactifs toutes les 2 minutes ─────────────────────────
  useEffect(() => {
    const PEER_TTL_MS = 10 * 60 * 1000; // 10 min
    const interval = setInterval(() => {
      const now = Date.now();
      setRadarPeers(prev => prev.filter(p => now - p.lastSeen < PEER_TTL_MS));
    }, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <RadarContext.Provider value={{ radarPeers, myLocation }}>
      {children}
    </RadarContext.Provider>
  );
}
