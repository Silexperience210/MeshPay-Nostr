/**
 * RadarProvider — Contexte dédié radar (radarPeers + myLocation)
 *
 * Extrait de MessagesProvider pour éviter que les mises à jour GPS/radar
 * (toutes les 5s) ne re-rendent tout l'arbre de l'app (chat, wallet, settings).
 *
 * Doit être placé DANS MessagesContext pour pouvoir appeler useMessages().
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import { type RadarPeer, haversineDistance, gpsBearing, distanceToSignal } from '@/utils/radar';
import { nostrClient } from '@/utils/nostr-client';
import { useNostr } from '@/providers/NostrProvider';
import { useMessages } from '@/providers/MessagesProvider';

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

export function RadarProvider({ children }: { children: React.ReactNode }) {
  const { identity } = useMessages();
  const { isConnected: nostrConnected } = useNostr();

  const [radarPeers, setRadarPeers] = useState<RadarPeer[]>([]);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);

  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  // ── Batched debounce : tous les peers qui arrivent dans la même fenêtre de 300ms
  // sont appliqués en UN SEUL setState (fix du bug original qui perdait N-1 peers)
  const peerBatchRef = useRef<Map<string, RadarPeer>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queuePeerUpdate = useCallback((peer: RadarPeer) => {
    // Mettre à jour ou supprimer dans le batch courant
    if (peer.online) {
      peerBatchRef.current.set(peer.nodeId, peer);
    } else {
      peerBatchRef.current.delete(peer.nodeId);
    }

    // Armer le flush (repoussé à chaque nouveau peer dans la fenêtre)
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      const batch = new Map(peerBatchRef.current);
      peerBatchRef.current.clear();
      setRadarPeers(prev => {
        let next = prev.filter(p => !batch.has(p.nodeId) && batch.get(p.nodeId)?.online !== false);
        for (const p of batch.values()) {
          next = [p, ...next.filter(x => x.nodeId !== p.nodeId)];
        }
        return next;
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
          // Publier présence Nostr si connecté
          if (nostrClient.isConnected && identity) {
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

  // ── Subscription Nostr presence ───────────────────────────────────────────
  useEffect(() => {
    if (!nostrConnected || !identity) return;

    const unsub = nostrClient.subscribePresence((payload, _event) => {
      if (payload.nodeId === identity.nodeId) return;

      const myPos = myLocationRef.current;
      let distanceMeters = 0;
      let bearingRad = 0;

      if (myPos && payload.lat !== undefined && payload.lng !== undefined) {
        distanceMeters = haversineDistance(myPos.lat, myPos.lng, payload.lat, payload.lng);
        bearingRad = gpsBearing(myPos.lat, myPos.lng, payload.lat, payload.lng);
      } else {
        const hash = payload.nodeId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        distanceMeters = 500 + (hash % 4000);
        bearingRad = (hash % 628) / 100;
      }

      queuePeerUpdate({
        nodeId: payload.nodeId,
        name: payload.name ?? payload.nodeId,
        distanceMeters,
        bearingRad,
        online: payload.online,
        lat: payload.lat,
        lng: payload.lng,
        lastSeen: payload.ts,
        signalStrength: distanceToSignal(distanceMeters),
      });
    });

    return () => unsub();
  }, [nostrConnected, identity, queuePeerUpdate]);

  return (
    <RadarContext.Provider value={{ radarPeers, myLocation }}>
      {children}
    </RadarContext.Provider>
  );
}
