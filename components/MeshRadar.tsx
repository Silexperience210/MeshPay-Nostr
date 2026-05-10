import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Animated, Easing, TouchableOpacity } from 'react-native';
import Colors from '@/constants/colors';
import { type RadarPeer, type PeerTransport, TRANSPORT_COLORS, formatDistance } from '@/utils/radar';

const RADAR_SIZE = 280;
const CENTER = RADAR_SIZE / 2;
const MAX_DISPLAY_METERS = 8000;

// ── Formes selon transport ────────────────────────────────────────────────────
// LoRa  → triangle (onde radio)
// Nostr → cercle   (réseau)
// Both  → losange  (dual connecté)

function LoraShape({ size, color }: { size: number; color: string }) {
  const half = size / 2;
  return (
    <View style={{
      width: 0,
      height: 0,
      borderLeftWidth: half,
      borderRightWidth: half,
      borderBottomWidth: size,
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      borderBottomColor: color,
    }} />
  );
}

function NostrShape({ size, color }: { size: number; color: string }) {
  return (
    <View style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: color,
    }} />
  );
}

function BothShape({ size, color }: { size: number; color: string }) {
  return (
    <View style={{
      width: size,
      height: size,
      backgroundColor: color,
      transform: [{ rotate: '45deg' }],
    }} />
  );
}

function TransportShape({ transport, size, color }: {
  transport: PeerTransport;
  size: number;
  color: string;
}) {
  if (transport === 'lora') return <LoraShape size={size} color={color} />;
  if (transport === 'both') return <BothShape size={size} color={color} />;
  return <NostrShape size={size} color={color} />;
}

// ── Sweep animé ───────────────────────────────────────────────────────────────
function RadarSweep({ isScanning, dominantTransport }: {
  isScanning: boolean;
  dominantTransport: PeerTransport;
}) {
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isScanning) {
      Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 3000,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      ).start();
    } else {
      rotateAnim.stopAnimation();
    }
  }, [isScanning, rotateAnim]);

  if (!isScanning) return null;

  const sweepColor = TRANSPORT_COLORS[dominantTransport];
  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View style={[styles.sweep, { transform: [{ rotate: rotation }] }]}>
      <View style={[styles.sweepLine, { backgroundColor: `${sweepColor}99` }]} />
      <View style={[styles.sweepGlow, { backgroundColor: `${sweepColor}12` }]} />
    </Animated.View>
  );
}

// ── Blip d'un peer ────────────────────────────────────────────────────────────
interface PeerBlipProps {
  peer: RadarPeer;
  index: number;
  onPress?: (peer: RadarPeer) => void;
}

function PeerBlip({ peer, index, onPress }: PeerBlipProps) {
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const appearAnim = useRef(new Animated.Value(0)).current;

  const ratio = Math.min(peer.distanceMeters / MAX_DISPLAY_METERS, 0.92);
  const screenAngle = peer.bearingRad - Math.PI / 2;
  const radius = ratio * (CENTER - 22);
  const x = CENTER + Math.cos(screenAngle) * radius;
  const y = CENTER + Math.sin(screenAngle) * radius;

  const color = TRANSPORT_COLORS[peer.transport];

  // Opacité liée à l'âge (fade progressif sur 10 min)
  const ageSecs = (Date.now() - peer.lastSeen) / 1000;
  const ageOpacity = Math.max(0.35, 1 - ageSecs / 600);

  const blipSize = peer.transport === 'both' ? 11 : 13;
  const label = peer.name.length > 9 ? peer.name.slice(0, 8) + '…' : peer.name;

  useEffect(() => {
    Animated.timing(appearAnim, {
      toValue: 1,
      duration: 500,
      delay: index * 80,
      useNativeDriver: true,
    }).start();

    if (peer.online) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1, duration: 1400, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 0, duration: 1400, useNativeDriver: true }),
        ])
      ).start();
    }
  }, [pulseAnim, appearAnim, index, peer.online]);

  return (
    <Animated.View
      style={[
        styles.blipContainer,
        {
          left: x - blipSize / 2,
          top: y - blipSize / 2,
          opacity: appearAnim,
          transform: [{ scale: appearAnim }],
        },
      ]}
    >
      <TouchableOpacity onPress={() => onPress?.(peer)} activeOpacity={0.7}>
        {/* Halo de pulse */}
        {peer.online && (
          <Animated.View
            style={[
              styles.blipPulse,
              {
                width: blipSize + 14,
                height: blipSize + 14,
                borderRadius: (blipSize + 14) / 2,
                borderColor: color,
                top: -(7),
                left: -(7),
                opacity: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                transform: [{
                  scale: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }),
                }],
              },
            ]}
          />
        )}

        {/* Forme selon transport */}
        <View style={{ shadowColor: color, shadowOpacity: 0.9, shadowRadius: 6, elevation: 6, opacity: ageOpacity }}>
          <TransportShape transport={peer.transport} size={blipSize} color={color} />
        </View>

        {/* Badge hops (LoRa seulement, si > 1 saut) */}
        {peer.transport !== 'nostr' && peer.hops !== undefined && peer.hops > 1 && (
          <View style={[styles.hopsBadge, { borderColor: color }]}>
            <Text style={[styles.hopsText, { color }]}>{peer.hops}</Text>
          </View>
        )}
      </TouchableOpacity>

      <Text style={[styles.blipLabel, { color }]} numberOfLines={1}>{label}</Text>
      <Text style={styles.blipDist} numberOfLines={1}>{formatDistance(peer.distanceMeters)}</Text>
    </Animated.View>
  );
}

// ── Légende ───────────────────────────────────────────────────────────────────
function RadarLegend({ counts }: { counts: Record<PeerTransport, number> }) {
  return (
    <View style={styles.legend}>
      {counts.lora > 0 && (
        <View style={styles.legendItem}>
          <LoraShape size={8} color={TRANSPORT_COLORS.lora} />
          <Text style={[styles.legendText, { color: TRANSPORT_COLORS.lora }]}>
            LoRa ({counts.lora})
          </Text>
        </View>
      )}
      {counts.nostr > 0 && (
        <View style={styles.legendItem}>
          <NostrShape size={8} color={TRANSPORT_COLORS.nostr} />
          <Text style={[styles.legendText, { color: TRANSPORT_COLORS.nostr }]}>
            Nostr ({counts.nostr})
          </Text>
        </View>
      )}
      {counts.both > 0 && (
        <View style={styles.legendItem}>
          <BothShape size={8} color={TRANSPORT_COLORS.both} />
          <Text style={[styles.legendText, { color: TRANSPORT_COLORS.both }]}>
            Les deux ({counts.both})
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Composant principal ───────────────────────────────────────────────────────
interface MeshRadarProps {
  peers: RadarPeer[];
  isScanning: boolean;
  myNodeId?: string;
  onPeerPress?: (peer: RadarPeer) => void;
}

export default function MeshRadar({ peers, isScanning, myNodeId, onPeerPress }: MeshRadarProps) {
  const rings = useMemo(() => [
    { ratio: 0.25, label: `${(MAX_DISPLAY_METERS * 0.25 / 1000).toFixed(1)} km` },
    { ratio: 0.5,  label: `${(MAX_DISPLAY_METERS * 0.5  / 1000).toFixed(1)} km` },
    { ratio: 0.75, label: `${(MAX_DISPLAY_METERS * 0.75 / 1000).toFixed(1)} km` },
    { ratio: 1,    label: `${(MAX_DISPLAY_METERS        / 1000).toFixed(0)} km` },
  ], []);

  const dominantTransport = useMemo<PeerTransport>(() => {
    const loraCt = peers.filter(p => p.transport === 'lora' || p.transport === 'both').length;
    const nostrCt = peers.filter(p => p.transport === 'nostr' || p.transport === 'both').length;
    if (loraCt > 0 && nostrCt > 0) return 'both';
    if (loraCt > 0) return 'lora';
    return 'nostr';
  }, [peers]);

  const counts = useMemo(() => ({
    lora:  peers.filter(p => p.transport === 'lora').length,
    nostr: peers.filter(p => p.transport === 'nostr').length,
    both:  peers.filter(p => p.transport === 'both').length,
  }), [peers]);

  return (
    <View style={styles.radarContainer}>
      <View style={styles.radar}>
        {rings.map((r, i) => (
          <View
            key={i}
            style={[
              styles.ring,
              {
                width: RADAR_SIZE * r.ratio,
                height: RADAR_SIZE * r.ratio,
                borderRadius: (RADAR_SIZE * r.ratio) / 2,
              },
            ]}
          />
        ))}

        <Text style={[styles.ringLabel, { top: CENTER - RADAR_SIZE * 0.25 / 2 - 2, left: CENTER + 4 }]}>
          {rings[0].label}
        </Text>
        <Text style={[styles.ringLabel, { top: CENTER - RADAR_SIZE * 0.5 / 2 - 2, left: CENTER + 4 }]}>
          {rings[1].label}
        </Text>

        <Text style={styles.cardinalN}>N</Text>
        <Text style={styles.cardinalS}>S</Text>
        <Text style={styles.cardinalE}>E</Text>
        <Text style={styles.cardinalW}>O</Text>

        <View style={styles.crosshairH} />
        <View style={styles.crosshairV} />

        <View style={styles.centerDot}>
          <View style={styles.centerDotInner} />
        </View>
        {myNodeId && (
          <Text style={styles.centerLabel}>{myNodeId.slice(5, 13)}</Text>
        )}

        <RadarSweep isScanning={isScanning} dominantTransport={dominantTransport} />

        {peers.map((peer, index) => (
          <PeerBlip
            key={peer.nodeId}
            peer={peer}
            index={index}
            onPress={onPeerPress}
          />
        ))}

        {peers.length === 0 && !isScanning && (
          <Text style={styles.emptyLabel}>Aucun pair détecté</Text>
        )}
      </View>

      {peers.length > 0 && <RadarLegend counts={counts} />}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  radarContainer: { alignItems: 'center', paddingVertical: 12 },
  radar: { width: RADAR_SIZE, height: RADAR_SIZE, position: 'relative', justifyContent: 'center', alignItems: 'center' },
  ring: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(42, 53, 69, 0.65)' },
  ringLabel: { position: 'absolute', color: Colors.textMuted, fontSize: 7, fontFamily: 'monospace', opacity: 0.55 },
  cardinalN: { position: 'absolute', top: 2, color: Colors.textMuted, fontSize: 8, fontWeight: '700', fontFamily: 'monospace' },
  cardinalS: { position: 'absolute', bottom: 2, color: Colors.textMuted, fontSize: 8, fontWeight: '700', fontFamily: 'monospace' },
  cardinalE: { position: 'absolute', right: 2, color: Colors.textMuted, fontSize: 8, fontWeight: '700', fontFamily: 'monospace' },
  cardinalW: { position: 'absolute', left: 2, color: Colors.textMuted, fontSize: 8, fontWeight: '700', fontFamily: 'monospace' },
  crosshairH: { position: 'absolute', width: RADAR_SIZE, height: 1, backgroundColor: 'rgba(42, 53, 69, 0.35)' },
  crosshairV: { position: 'absolute', width: 1, height: RADAR_SIZE, backgroundColor: 'rgba(42, 53, 69, 0.35)' },
  centerDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(247, 147, 26, 0.2)', justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  centerDotInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.accent },
  centerLabel: { position: 'absolute', top: CENTER + 13, color: Colors.accent, fontSize: 7, fontFamily: 'monospace', fontWeight: '700' },
  sweep: { position: 'absolute', width: RADAR_SIZE, height: RADAR_SIZE, justifyContent: 'center', alignItems: 'center', zIndex: 5 },
  sweepLine: { position: 'absolute', top: CENTER - 1, left: CENTER, width: CENTER - 4, height: 2 },
  sweepGlow: { position: 'absolute', top: CENTER - 24, left: CENTER, width: CENTER - 4, height: 48, borderTopRightRadius: CENTER, borderBottomRightRadius: CENTER },
  blipContainer: { position: 'absolute', alignItems: 'center', zIndex: 15 },
  blipPulse: { position: 'absolute', borderWidth: 1.5 },
  hopsBadge: { position: 'absolute', top: -5, right: -7, width: 10, height: 10, borderRadius: 5, borderWidth: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  hopsText: { fontSize: 6, fontWeight: '700', fontFamily: 'monospace' },
  blipLabel: { fontSize: 7, fontWeight: '700', marginTop: 3, maxWidth: 58, textAlign: 'center', fontFamily: 'monospace' },
  blipDist: { fontSize: 6, color: Colors.textMuted, textAlign: 'center', fontFamily: 'monospace' },
  emptyLabel: { color: Colors.textMuted, fontSize: 11, fontFamily: 'monospace', textAlign: 'center' },
  legend: { flexDirection: 'row', gap: 14, marginTop: 8, paddingHorizontal: 12, flexWrap: 'wrap', justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendText: { fontSize: 10, fontFamily: 'monospace', fontWeight: '600' },
});
