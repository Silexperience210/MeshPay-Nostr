/**
 * MeshStatsModal — Statistiques, batterie et voisins du gateway MeshCore
 *
 * Affiche :
 *  - Batterie (GetBatteryVoltage)
 *  - Stats core / radio / packets (GetStats)
 *  - Voisins 1-hop (GetNeighbours via SendBinaryReq)
 *  - Contacts chargés depuis device
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import {
  X,
  Battery,
  Activity,
  Radio,
  Users,
  RefreshCw,
  Signal,
  Zap,
  Cpu,
  Package,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { useBle } from '@/providers/BleProvider';

interface MeshStatsModalProps {
  visible: boolean;
  onClose: () => void;
  onContactAction?: (pubkeyHex: string, action: 'resetPath' | 'remove' | 'status') => void;
}

type StatsTab = 'battery' | 'core' | 'radio' | 'packets' | 'neighbours';

function formatTime(ts: number): string {
  if (!ts) return '—';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  return `${Math.floor(diff / 3600)}h`;
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

export default function MeshStatsModal({ visible, onClose, onContactAction }: MeshStatsModalProps) {
  const ble = useBle();
  const [tab, setTab] = useState<StatsTab>('battery');
  const [loading, setLoading] = useState(false);

  // Refresh toutes les données au montage
  const refreshAll = useCallback(async () => {
    if (!ble.connected) return;
    setLoading(true);
    try {
      await ble.getBattery();
      await ble.getStats(0); // core
      await ble.getStats(1); // radio
      await ble.getStats(2); // packets
      await ble.getNeighbours();
      await ble.syncContacts();
    } catch (e: any) {
      console.warn('[MeshStatsModal] Refresh:', e.message);
    } finally {
      setLoading(false);
    }
  }, [ble]);

  useEffect(() => {
    if (visible && ble.connected) {
      refreshAll();
    }
  }, [visible, ble.connected]);

  const deviceInfo = ble.deviceInfo;

  // Batterie % estimation (3.2V vide → 4.2V plein pour LiPo)
  const battPct = ble.batteryVolts != null
    ? Math.max(0, Math.min(100, Math.round(((ble.batteryVolts - 3.2) / 1.0) * 100)))
    : null;

  const battColor = battPct == null ? Colors.textMuted
    : battPct > 50 ? Colors.green
    : battPct > 20 ? Colors.yellow
    : Colors.red;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Activity size={18} color={Colors.accent} />
            <Text style={styles.title}>Stats & Mesh</Text>
            <TouchableOpacity onPress={refreshAll} disabled={loading} style={styles.refreshBtn}>
              {loading
                ? <ActivityIndicator size="small" color={Colors.accent} />
                : <RefreshCw size={16} color={Colors.accent} />
              }
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Quick battery bar */}
          {deviceInfo && (
            <View style={styles.deviceRow}>
              <Text style={styles.deviceName}>{deviceInfo.name}</Text>
              <View style={styles.battRow}>
                <Battery size={14} color={battColor} />
                {ble.batteryVolts != null ? (
                  <Text style={[styles.battText, { color: battColor }]}>
                    {ble.batteryVolts.toFixed(2)}V {battPct != null ? `(${battPct}%)` : ''}
                  </Text>
                ) : (
                  <Text style={styles.battText}>—</Text>
                )}
              </View>
            </View>
          )}

          {/* Tabs */}
          <View style={styles.tabs}>
            {([
              { key: 'battery', icon: Battery, label: 'Info' },
              { key: 'neighbours', icon: Signal, label: 'Voisins' },
              { key: 'core', icon: Cpu, label: 'Core' },
              { key: 'radio', icon: Radio, label: 'Radio' },
              { key: 'packets', icon: Package, label: 'Paquets' },
            ] as const).map(({ key, icon: Icon, label }) => (
              <TouchableOpacity
                key={key}
                style={[styles.tab, tab === key && styles.tabActive]}
                onPress={() => setTab(key)}
              >
                <Icon size={14} color={tab === key ? Colors.accent : Colors.textMuted} />
                <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>

            {/* ── Info device ── */}
            {tab === 'battery' && (
              <View>
                <Text style={styles.sectionLabel}>Device Info</Text>
                {deviceInfo ? (
                  <>
                    <StatRow label="Nom" value={deviceInfo.name} />
                    <StatRow label="Fréquence" value={`${(deviceInfo.radioFreqHz / 1e6).toFixed(3)} MHz`} />
                    <StatRow label="Bandwidth" value={`${deviceInfo.radioBwHz / 1000} kHz`} />
                    <StatRow label="SF" value={`SF${deviceInfo.radioSf}`} />
                    <StatRow label="TX Power" value={`${deviceInfo.txPower} dBm (max ${deviceInfo.maxTxPower})`} />
                    {deviceInfo.advLat !== 0 && (
                      <StatRow label="GPS" value={`${deviceInfo.advLat.toFixed(4)}, ${deviceInfo.advLon.toFixed(4)}`} />
                    )}
                    <StatRow label="Pubkey" value={deviceInfo.publicKey.slice(0, 24) + '...'} />
                  </>
                ) : (
                  <Text style={styles.empty}>Connectez un gateway pour voir les infos</Text>
                )}

                <Text style={styles.sectionLabel}>Contacts chargés ({ble.meshContacts.length})</Text>
                {ble.meshContacts.length === 0 ? (
                  <Text style={styles.empty}>Aucun contact dans le device</Text>
                ) : (
                  ble.meshContacts.map((c) => (
                    <View key={c.pubkeyHex} style={styles.contactRow}>
                      <View style={styles.contactAvatar}>
                        <Text style={styles.contactAvatarText}>{c.name.charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={styles.contactInfo}>
                        <Text style={styles.contactName}>{c.name}</Text>
                        <Text style={styles.contactPrefix}>{c.pubkeyPrefix}</Text>
                      </View>
                      <Text style={styles.contactTime}>{formatTime(c.lastSeen)}</Text>
                      <View style={styles.contactActions}>
                        <TouchableOpacity
                          style={styles.actionBtn}
                          onPress={() => onContactAction?.(c.pubkeyHex, 'status')}
                        >
                          <Zap size={12} color={Colors.yellow} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.actionBtn}
                          onPress={() => onContactAction?.(c.pubkeyHex, 'resetPath')}
                        >
                          <RefreshCw size={12} color={Colors.cyan} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.actionBtn}
                          onPress={() => {
                            Alert.alert('Supprimer', `Supprimer ${c.name} ?`, [
                              { text: 'Annuler', style: 'cancel' },
                              { text: 'Supprimer', style: 'destructive', onPress: () => onContactAction?.(c.pubkeyHex, 'remove') },
                            ]);
                          }}
                        >
                          <X size={12} color={Colors.red} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))
                )}
              </View>
            )}

            {/* ── Voisins 1-hop ── */}
            {tab === 'neighbours' && (
              <View>
                <Text style={styles.sectionLabel}>Voisins directs ({ble.neighbours.length})</Text>
                {ble.neighbours.length === 0 ? (
                  <Text style={styles.empty}>Aucun voisin 1-hop détecté</Text>
                ) : (
                  ble.neighbours.map((n) => (
                    <View key={n.pubkeyPrefix} style={styles.neighbourRow}>
                      <View style={styles.neighbourIcon}>
                        <Signal size={16} color={n.rssi > -80 ? Colors.green : n.rssi > -100 ? Colors.yellow : Colors.red} />
                      </View>
                      <View style={styles.neighbourInfo}>
                        <Text style={styles.neighbourName}>{n.name}</Text>
                        <Text style={styles.neighbourPrefix}>{n.pubkeyPrefix}</Text>
                      </View>
                      <View style={styles.neighbourStats}>
                        <Text style={styles.neighbourStat}>RSSI {n.rssi}</Text>
                        <Text style={styles.neighbourStat}>SNR {n.snr.toFixed(1)}</Text>
                        <Text style={styles.neighbourStat}>{n.txPower}dBm</Text>
                        <Text style={styles.neighbourStat}>{formatTime(n.lastHeard)}</Text>
                      </View>
                    </View>
                  ))
                )}
              </View>
            )}

            {/* ── Stats core/radio/packets ── */}
            {(tab === 'core' || tab === 'radio' || tab === 'packets') && (
              <View>
                <Text style={styles.sectionLabel}>
                  Stats {tab === 'core' ? 'Core' : tab === 'radio' ? 'Radio' : 'Paquets'}
                </Text>
                {ble.lastStats && ble.lastStats.type === tab ? (
                  Object.entries(ble.lastStats.raw).map(([key, val]) => (
                    <StatRow key={key} label={key.replace('field_', 'Champ ')} value={val} />
                  ))
                ) : (
                  <Text style={styles.empty}>Appuyez sur ↻ pour charger</Text>
                )}
                <TouchableOpacity
                  style={styles.loadBtn}
                  onPress={() => ble.getStats(tab === 'core' ? 0 : tab === 'radio' ? 1 : 2)}
                >
                  <RefreshCw size={14} color={Colors.accent} />
                  <Text style={styles.loadBtnText}>Charger stats {tab}</Text>
                </TouchableOpacity>
              </View>
            )}

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  refreshBtn: {
    padding: 4,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceHighlight,
  },
  deviceName: {
    flex: 1,
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  battRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  battText: {
    fontSize: 12,
    fontWeight: '600',
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 3,
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: Colors.accent,
  },
  tabText: {
    color: Colors.textMuted,
    fontSize: 10,
  },
  tabTextActive: {
    color: Colors.accent,
    fontWeight: '700',
  },
  body: {
    padding: 16,
  },
  sectionLabel: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 10,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  statLabel: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  statValue: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  empty: {
    color: Colors.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 20,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 10,
  },
  contactAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactAvatarText: {
    color: Colors.accent,
    fontWeight: '700',
    fontSize: 14,
  },
  contactInfo: {
    flex: 1,
  },
  contactName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  contactPrefix: {
    color: Colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  contactTime: {
    color: Colors.textMuted,
    fontSize: 11,
  },
  contactActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: Colors.surfaceHighlight,
  },
  neighbourRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 10,
  },
  neighbourIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  neighbourInfo: {
    flex: 1,
  },
  neighbourName: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  neighbourPrefix: {
    color: Colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  neighbourStats: {
    alignItems: 'flex-end',
    gap: 2,
  },
  neighbourStat: {
    color: Colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  loadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 16,
  },
  loadBtnText: {
    color: Colors.accent,
    fontWeight: '600',
    fontSize: 14,
  },
});
