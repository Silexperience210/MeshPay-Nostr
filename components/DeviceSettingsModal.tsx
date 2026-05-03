/**
 * DeviceSettingsModal — Configuration complète du gateway MeshCore
 *
 * Permet de modifier :
 *  - Nom d'annonce (SetAdvertName)
 *  - Puissance TX (SetTxPower)
 *  - Paramètres radio LoRa (SetRadioParams)
 *  - Position GPS d'annonce (SetAdvertLatLon)
 *  - Portée flood (SetFloodScope)
 *  - Redémarrage device (Reboot)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import {
  X,
  Radio,
  Zap,
  MapPin,
  RotateCw,
  Wifi,
  Save,
  Power,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { useBle } from '@/providers/BleProvider';

interface DeviceSettingsModalProps {
  visible: boolean;
  onClose: () => void;
}

// Presets LoRa fréquences courantes
const FREQ_PRESETS = [
  { label: '433 MHz', hz: 433_000_000 },
  { label: '868 MHz', hz: 868_000_000 },
  { label: '915 MHz', hz: 915_000_000 },
  { label: '923 MHz', hz: 923_000_000 },
];

// Presets BW LoRa
const BW_PRESETS = [
  { label: '125 kHz', hz: 125_000 },
  { label: '250 kHz', hz: 250_000 },
  { label: '500 kHz', hz: 500_000 },
];

// Spreading factors
const SF_VALUES = [7, 8, 9, 10, 11, 12];

// Coding rates
const CR_VALUES = [{ label: '4/5', v: 5 }, { label: '4/6', v: 6 }, { label: '4/7', v: 7 }, { label: '4/8', v: 8 }];

// Région/scope pour flood packets (v1.15.0+)
// La commande SetFloodScope définit une région (string), pas un nombre de hops.
const DEFAULT_REGION = '';

export default function DeviceSettingsModal({ visible, onClose }: DeviceSettingsModalProps) {
  const ble = useBle();
  const info = ble.deviceInfo;

  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'radio' | 'gps' | 'flood' | 'device'>('radio');

  // Radio
  const [freqHz, setFreqHz] = useState(868_000_000);
  const [bwHz, setBwHz] = useState(125_000);
  const [sf, setSf] = useState(10);
  const [cr, setCr] = useState(5);
  const [txPower, setTxPower] = useState(20);

  // Device
  const [advertName, setAdvertName] = useState('');

  // GPS
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');

  // Flood region (v1.15.0+ — définit le scope/région par défaut)
  const [floodRegion, setFloodRegion] = useState('');

  // Init depuis deviceInfo
  useEffect(() => {
    if (!info) return;
    setFreqHz(info.radioFreqHz || 868_000_000);
    setBwHz(info.radioBwHz || 125_000);
    setSf(info.radioSf || 10);
    setCr(5);
    setTxPower(info.txPower || 20);
    setAdvertName(info.name || '');
    if (info.advLat) setLat(info.advLat.toFixed(6));
    if (info.advLon) setLon(info.advLon.toFixed(6));
  }, [info, visible]);

  const handleSaveRadio = useCallback(async () => {
    if (!ble.connected) {
      Alert.alert('Erreur', 'Gateway non connecté — reconnectez via le scanner BLE');
      return;
    }
    setSaving(true);
    try {
      await ble.setRadioParams(freqHz, bwHz, sf, cr);
      await ble.setTxPower(txPower);
      Alert.alert('Radio appliquée', `${(freqHz/1e6).toFixed(3)} MHz · BW ${bwHz/1000}kHz · SF${sf} · ${txPower}dBm\nRedémarrez le gateway pour que les changements soient permanents.`);
    } catch (e: any) {
      Alert.alert('Erreur radio', e.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [ble, freqHz, bwHz, sf, cr, txPower]);

  const handleSaveDevice = useCallback(async () => {
    if (!advertName.trim()) {
      Alert.alert('Erreur', 'Le nom ne peut pas être vide');
      return;
    }
    if (!ble.connected) {
      Alert.alert('Erreur', 'Gateway non connecté — reconnectez via le scanner BLE');
      return;
    }
    setSaving(true);
    try {
      await ble.setAdvertName(advertName.trim());
      Alert.alert('Nom mis à jour', `Le device s'annoncera sous "${advertName.trim()}".\nRedémarrez pour appliquer.`);
    } catch (e: any) {
      Alert.alert('Erreur sauvegarde nom', e.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [ble, advertName]);

  const handleSaveGps = useCallback(async () => {
    if (!ble.connected) {
      Alert.alert('Erreur', 'Gateway non connecté — reconnectez via le scanner BLE');
      return;
    }
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);
    if (isNaN(latN) || isNaN(lonN)) {
      Alert.alert('GPS', 'Coordonnées invalides (ex: 48.856614)');
      return;
    }
    if (latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
      Alert.alert('GPS', 'Hors limites — lat ±90, lon ±180');
      return;
    }
    setSaving(true);
    try {
      await ble.setAdvertLatLon(latN, lonN);
      Alert.alert('GPS mis à jour', `${latN.toFixed(6)}, ${lonN.toFixed(6)}`);
    } catch (e: any) {
      Alert.alert('Erreur GPS', e.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [ble, lat, lon]);

  const handleSaveFlood = useCallback(async () => {
    if (!ble.connected) {
      Alert.alert('Erreur', 'Gateway non connecté — reconnectez via le scanner BLE');
      return;
    }
    const region = floodRegion.trim();
    setSaving(true);
    try {
      await ble.setFloodScope(region || null);
      if (region) {
        Alert.alert('Région appliquée', `Tous les flood packets seront scopés à "${region}".`);
      } else {
        Alert.alert('Scope désactivé', 'Les flood packets ne seront plus scopés à une région.');
      }
    } catch (e: any) {
      Alert.alert('Erreur scope', e.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [ble, floodRegion]);

  const handleReboot = useCallback(() => {
    Alert.alert(
      'Redémarrage',
      'Redémarrer le gateway MeshCore ?',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Redémarrer',
          style: 'destructive',
          onPress: async () => {
            try {
              await ble.reboot();
              onClose();
            } catch (e: any) {
              Alert.alert('Erreur', e.message);
            }
          },
        },
      ]
    );
  }, [ble, onClose]);

  const maxTx = info?.maxTxPower ?? 22;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Radio size={18} color={Colors.accent} />
            <Text style={styles.title}>Paramètres Gateway</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Banner non connecté */}
          {!ble.connected && (
            <View style={styles.warnRow}>
              <Text style={styles.warnText}>Gateway non connecté — les paramètres ne peuvent pas être sauvegardés</Text>
            </View>
          )}

          {/* Device info row */}
          {info && (
            <View style={styles.infoRow}>
              <Text style={styles.infoName}>{info.name}</Text>
              <Text style={styles.infoPubkey}>{info.publicKey.slice(0, 16)}...</Text>
              {ble.batteryVolts != null && (
                <View style={styles.battBadge}>
                  <Zap size={10} color={Colors.green} />
                  <Text style={styles.battText}>{ble.batteryVolts.toFixed(2)}V</Text>
                </View>
              )}
            </View>
          )}

          {/* Tabs */}
          <View style={styles.tabs}>
            {(['radio', 'device', 'gps', 'flood'] as const).map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.tab, tab === t && styles.tabActive]}
                onPress={() => setTab(t)}
              >
                <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                  {t === 'radio' ? 'Radio' : t === 'device' ? 'Nom' : t === 'gps' ? 'GPS' : 'Flood'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {/* ── Radio ── */}
            {tab === 'radio' && (
              <View>
                <Text style={styles.sectionLabel}>Fréquence</Text>
                <View style={styles.presetRow}>
                  {FREQ_PRESETS.map((p) => (
                    <TouchableOpacity
                      key={p.hz}
                      style={[styles.preset, freqHz === p.hz && styles.presetActive]}
                      onPress={() => setFreqHz(p.hz)}
                    >
                      <Text style={[styles.presetText, freqHz === p.hz && styles.presetTextActive]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.input}
                  value={String(freqHz)}
                  onChangeText={(v) => setFreqHz(parseInt(v) || freqHz)}
                  keyboardType="numeric"
                  placeholder="Fréquence Hz"
                  placeholderTextColor={Colors.textMuted}
                />

                <Text style={styles.sectionLabel}>Bandwidth</Text>
                <View style={styles.presetRow}>
                  {BW_PRESETS.map((p) => (
                    <TouchableOpacity
                      key={p.hz}
                      style={[styles.preset, bwHz === p.hz && styles.presetActive]}
                      onPress={() => setBwHz(p.hz)}
                    >
                      <Text style={[styles.presetText, bwHz === p.hz && styles.presetTextActive]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.sectionLabel}>Spreading Factor (SF{sf})</Text>
                <View style={styles.presetRow}>
                  {SF_VALUES.map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.preset, sf === v && styles.presetActive]}
                      onPress={() => setSf(v)}
                    >
                      <Text style={[styles.presetText, sf === v && styles.presetTextActive]}>SF{v}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.sectionLabel}>Coding Rate</Text>
                <View style={styles.presetRow}>
                  {CR_VALUES.map((v) => (
                    <TouchableOpacity
                      key={v.v}
                      style={[styles.preset, cr === v.v && styles.presetActive]}
                      onPress={() => setCr(v.v)}
                    >
                      <Text style={[styles.presetText, cr === v.v && styles.presetTextActive]}>{v.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.sectionLabel}>TX Power: {txPower} dBm (max {maxTx})</Text>
                <View style={styles.sliderRow}>
                  {Array.from({ length: maxTx - 1 }, (_, i) => i + 2).map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.sliderStep, v <= txPower && styles.sliderStepActive]}
                      onPress={() => setTxPower(v)}
                    />
                  ))}
                </View>

                <TouchableOpacity style={[styles.saveBtn, !ble.connected && styles.saveBtnDisabled]} onPress={handleSaveRadio} disabled={saving || !ble.connected}>
                  {saving ? <ActivityIndicator color="#000" size="small" /> : <Save size={16} color="#000" />}
                  <Text style={styles.saveBtnText}>Appliquer radio</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Nom device ── */}
            {tab === 'device' && (
              <View>
                <Text style={styles.sectionLabel}>Nom d'annonce sur le mesh</Text>
                <TextInput
                  style={styles.input}
                  value={advertName}
                  onChangeText={setAdvertName}
                  placeholder="Ex: MeshCore-Home"
                  placeholderTextColor={Colors.textMuted}
                  maxLength={31}
                />
                <Text style={styles.hint}>{advertName.length}/31 caractères</Text>

                <TouchableOpacity style={[styles.saveBtn, (!ble.connected || !advertName.trim()) && styles.saveBtnDisabled]} onPress={handleSaveDevice} disabled={saving || !ble.connected || !advertName.trim()}>
                  {saving ? <ActivityIndicator color="#000" size="small" /> : <Save size={16} color="#000" />}
                  <Text style={styles.saveBtnText}>Sauvegarder le nom</Text>
                </TouchableOpacity>

                <View style={styles.divider} />

                <Text style={styles.sectionLabel}>Actions device</Text>
                <TouchableOpacity style={styles.rebootBtn} onPress={handleReboot}>
                  <Power size={16} color={Colors.red} />
                  <Text style={styles.rebootBtnText}>Redémarrer le gateway</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── GPS ── */}
            {tab === 'gps' && (
              <View>
                <Text style={styles.sectionLabel}>Position GPS annoncée sur le mesh</Text>
                <Text style={styles.hint}>Ces coordonnées sont diffusées avec vos annonces LoRa</Text>
                <TextInput
                  style={styles.input}
                  value={lat}
                  onChangeText={setLat}
                  placeholder="Latitude (ex: 48.856614)"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="decimal-pad"
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  value={lon}
                  onChangeText={setLon}
                  placeholder="Longitude (ex: 2.352222)"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="decimal-pad"
                />
                <TouchableOpacity style={[styles.saveBtn, !ble.connected && styles.saveBtnDisabled]} onPress={handleSaveGps} disabled={saving || !ble.connected}>
                  {saving ? <ActivityIndicator color="#000" size="small" /> : <MapPin size={16} color="#000" />}
                  <Text style={styles.saveBtnText}>Mettre à jour la position</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Flood scope ── */}
            {tab === 'flood' && (
              <View>
                <Text style={styles.sectionLabel}>Région par défaut (scope flood)</Text>
                <Text style={styles.hint}>
                  Définissez une région pour scoper tous les flood packets (adverts, DMs sans path connu, etc.). Laissez vide pour désactiver le scoping.
                </Text>
                <TextInput
                  style={styles.input}
                  value={floodRegion}
                  onChangeText={setFloodRegion}
                  placeholder="Ex: alsace"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="none"
                />
                <Text style={styles.hint}>Laissez vide pour désactiver le scope régional</Text>
                <TouchableOpacity style={styles.saveBtn} onPress={handleSaveFlood} disabled={saving || !ble.connected}>
                  {saving ? <ActivityIndicator color="#000" size="small" /> : <Wifi size={16} color="#000" />}
                  <Text style={styles.saveBtnText}>Appliquer la région</Text>
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
    maxHeight: '92%',
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
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceHighlight,
  },
  infoName: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  infoPubkey: {
    color: Colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  battBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Colors.greenDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  battText: {
    color: Colors.green,
    fontSize: 10,
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
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: Colors.accent,
  },
  tabText: {
    color: Colors.textMuted,
    fontSize: 13,
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
    marginBottom: 8,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  preset: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceHighlight,
  },
  presetActive: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accentDim,
  },
  presetText: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  presetTextActive: {
    color: Colors.accent,
    fontWeight: '700',
  },
  input: {
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  sliderRow: {
    flexDirection: 'row',
    gap: 2,
    marginVertical: 8,
    height: 16,
    alignItems: 'center',
  },
  sliderStep: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.surfaceHighlight,
  },
  sliderStepActive: {
    backgroundColor: Colors.accent,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 20,
  },
  saveBtnText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 15,
  },
  rebootBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.red,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 12,
  },
  rebootBtnText: {
    color: Colors.red,
    fontWeight: '700',
    fontSize: 15,
  },
  hint: {
    color: Colors.textMuted,
    fontSize: 12,
    marginBottom: 8,
    lineHeight: 18,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 20,
  },
  warnRow: {
    backgroundColor: Colors.redDim,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.red,
  },
  warnText: {
    color: Colors.red,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.4,
  },
});
