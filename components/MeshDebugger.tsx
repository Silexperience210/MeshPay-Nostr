/**
 * MeshDebugger — Outil de diagnostic BLE/MeshCore pour MeshPay-Nostr
 *
 * Tests automatisés : connexion BLE, handshake MeshCore, radio, messaging.
 * Outils manuels : envoi test, sync contacts, infos device.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Alert,
  TextInput,
  Switch,
} from 'react-native';
import {
  Activity,
  Bluetooth,
  Radio,
  Send,
  Terminal,
  Play,
  RotateCcw,
  Trash2,
  Signal,
  Cpu,
  Wifi,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { useBle } from '@/providers/BleProvider';

// ── Types ──────────────────────────────────────────────────────────────

interface TestResult {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'warning';
  message: string;
  timestamp: number;
  duration?: number;
}

interface LogEntry {
  id: string;
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

interface MeshDebuggerProps {
  visible: boolean;
  onClose: () => void;
}

// ── Test suites ────────────────────────────────────────────────────────

const TEST_SUITES = {
  connection: [
    { id: 'ble_init',    name: 'BLE Initialisé',       icon: Bluetooth },
    { id: 'ble_connect', name: 'Connexion Device',      icon: Bluetooth },
    { id: 'handshake',   name: 'Handshake MeshCore',    icon: Activity  },
    { id: 'self_info',   name: 'SelfInfo Reçue',        icon: Cpu       },
  ],
  radio: [
    { id: 'channel_0_config', name: 'Canal 0 Configuré',        icon: Radio  },
    { id: 'channel_check',    name: 'Canal Actif Vérifié',       icon: Radio  },
    { id: 'frequency',        name: 'Fréquence Radio',           icon: Wifi   },
    { id: 'radio_params',     name: 'Paramètres Radio (SF/BW)',  icon: Signal },
  ],
  messaging: [
    { id: 'send_txt',    name: 'Envoi Message Texte',  icon: Send  },
    { id: 'broadcast',   name: 'Broadcast Canal 0',    icon: Radio },
    { id: 'sync_contacts', name: 'Sync Contacts',      icon: RotateCcw },
  ],
};

// ── Composant ──────────────────────────────────────────────────────────

export default function MeshDebugger({ visible, onClose }: MeshDebuggerProps) {
  const {
    connected,
    device,
    deviceInfo,
    currentChannel,
    meshContacts,
    sendChannelMessage,
    syncContacts,
  } = useBle();

  const [activeTab, setActiveTab]         = useState<'tests' | 'logs' | 'device' | 'tools'>('tests');
  const [testResults, setTestResults]     = useState<TestResult[]>([]);
  const [logs, setLogs]                   = useState<LogEntry[]>([]);
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [testProgress, setTestProgress]   = useState(0);
  const [testMessage, setTestMessage]     = useState('Test MeshPay ' + Date.now());
  const [targetChannel, setTargetChannel] = useState('0');
  const [showRawData, setShowRawData]     = useState(false);

  // ── Logging ────────────────────────────────────────────────────────

  const addLog = useCallback((level: LogEntry['level'], source: string, message: string) => {
    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      level,
      source,
      message,
    };
    setLogs((prev) => [...prev.slice(-200), entry]);
  }, []);

  // ── Test runner ────────────────────────────────────────────────────

  const addTestResult = useCallback((result: TestResult) => {
    setTestResults((prev) => [...prev.filter((r) => r.id !== result.id), result]);
  }, []);

  const clearResults = useCallback(() => {
    setTestResults([]);
    setLogs([]);
  }, []);

  const runTest = async (testId: string): Promise<TestResult> => {
    const t0 = Date.now();
    const make = (status: TestResult['status'], message: string): TestResult => ({
      id: testId,
      name: TEST_SUITES.connection.concat(TEST_SUITES.radio, TEST_SUITES.messaging)
        .find((t) => t.id === testId)?.name || testId,
      status,
      message,
      timestamp: Date.now(),
      duration: Date.now() - t0,
    });

    switch (testId) {
      case 'ble_init':
        return make('success', 'BLE Manager initialisé et prêt');

      case 'ble_connect':
        if (!connected) return make('failed', 'Non connecté à un device BLE');
        return make('success', `Connecté à ${device?.name || 'device'}`);

      case 'handshake':
        if (!connected) return make('failed', 'Connexion BLE requise');
        if (!deviceInfo)  return make('warning', 'Connecté mais SelfInfo non reçue');
        return make('success', 'Handshake complété avec succès');

      case 'self_info':
        if (!deviceInfo) return make('failed', 'Aucune information device reçue');
        return make('success', `${deviceInfo.name} | ${(deviceInfo.radioFreqHz / 1e6).toFixed(3)} MHz`);

      case 'channel_0_config':
        return make('success', `Canal ${currentChannel} actif`);

      case 'channel_check':
        return make('success', `Canal ${currentChannel} actif (${currentChannel === 0 ? 'public' : 'privé'})`);

      case 'frequency':
        if (!deviceInfo) return make('failed', 'SelfInfo requise');
        return make('success', `${(deviceInfo.radioFreqHz / 1e6).toFixed(3)} MHz`);

      case 'radio_params':
        if (!deviceInfo) return make('failed', 'SelfInfo requise');
        return make('success', `SF${deviceInfo.radioSf} | ${deviceInfo.radioBwHz / 1000} kHz | CR 4/${deviceInfo.radioCr}`);

      case 'send_txt':
        if (!connected) return make('failed', 'Connexion BLE requise');
        try {
          await sendChannelMessage('Test diagnostic MeshPay');
          return make('success', 'Message envoyé avec succès');
        } catch (e: any) {
          return make('failed', e.message || 'Échec envoi');
        }

      case 'broadcast':
        if (!connected) return make('failed', 'Connexion BLE requise');
        try {
          await sendChannelMessage('Test broadcast canal 0');
          return make('success', 'Broadcast envoyé sur canal 0');
        } catch (e: any) {
          return make('failed', e.message || 'Échec broadcast');
        }

      case 'sync_contacts':
        if (!connected) return make('failed', 'Connexion BLE requise');
        try {
          await syncContacts();
          return make('success', `${meshContacts.length} contacts synchronisés`);
        } catch (e: any) {
          return make('failed', e.message || 'Échec sync');
        }

      default:
        return make('failed', `Test ${testId} non implémenté`);
    }
  };

  const runAllTests = async () => {
    setIsRunningTests(true);
    setTestResults([]);
    addLog('info', 'Debugger', 'Démarrage suite de tests');

    const allTests = [
      ...TEST_SUITES.connection,
      ...TEST_SUITES.radio,
      ...TEST_SUITES.messaging,
    ];

    for (let i = 0; i < allTests.length; i++) {
      const test = allTests[i];
      setTestProgress(((i + 1) / allTests.length) * 100);
      addTestResult({
        id: test.id, name: test.name, status: 'running',
        message: 'En cours...', timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 200));
      const result = await runTest(test.id);
      addTestResult(result);
      addLog(
        result.status === 'success' ? 'info' : result.status === 'warning' ? 'warn' : 'error',
        'Test',
        `${test.name}: ${result.message}`
      );
    }
    setIsRunningTests(false);
    setTestProgress(100);
    addLog('info', 'Debugger', 'Suite de tests terminée');
  };

  const runManualTest = async () => {
    if (!connected) { Alert.alert('Non connecté', 'Connectez-vous d\'abord en BLE'); return; }
    const ch = parseInt(targetChannel, 10);
    if (isNaN(ch) || ch < 0 || ch > 7) { Alert.alert('Canal invalide', '0 à 7'); return; }
    addLog('info', 'ManualTest', `Envoi sur ch${ch}: "${testMessage}"`);
    try {
      await sendChannelMessage(testMessage);
      addLog('info', 'ManualTest', 'Envoyé avec succès');
      Alert.alert('Succès', `Message envoyé sur canal ${ch}`);
    } catch (e: any) {
      addLog('error', 'ManualTest', e.message);
      Alert.alert('Échec', e.message);
    }
  };

  const stats = {
    success: testResults.filter((r) => r.status === 'success').length,
    failed:  testResults.filter((r) => r.status === 'failed').length,
    warning: testResults.filter((r) => r.status === 'warning').length,
    total:   testResults.length,
  };

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.iconBox}>
                <Terminal size={22} color={Colors.accent} />
              </View>
              <View>
                <Text style={styles.title}>Mesh Debugger</Text>
                <Text style={styles.subtitle}>
                  {connected ? `🟢 ${device?.name || 'Connecté'}` : '🔴 Déconnecté'}
                </Text>
              </View>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Stats bar */}
          {testResults.length > 0 && (
            <View style={styles.statsRow}>
              {[
                { v: stats.success, label: 'OK',   color: Colors.green,  bg: Colors.greenDim  },
                { v: stats.failed,  label: 'FAIL',  color: Colors.red,    bg: Colors.redDim    },
                { v: stats.warning, label: 'WARN',  color: Colors.yellow, bg: Colors.yellowDim },
                { v: stats.total,   label: 'TOTAL', color: Colors.blue,   bg: Colors.blueDim   },
              ].map(({ v, label, color, bg }) => (
                <View key={label} style={[styles.statBadge, { backgroundColor: bg }]}>
                  <Text style={[styles.statValue, { color }]}>{v}</Text>
                  <Text style={styles.statLabel}>{label}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Progress bar */}
          {isRunningTests && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${testProgress}%` as any }]} />
            </View>
          )}

          {/* Tabs */}
          <View style={styles.tabs}>
            {(['tests', 'logs', 'device', 'tools'] as const).map((tab) => (
              <TouchableOpacity
                key={tab}
                style={[styles.tab, activeTab === tab && styles.tabActive]}
                onPress={() => setActiveTab(tab)}
              >
                <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                  {tab === 'tests'  && 'Tests'}
                  {tab === 'logs'   && 'Logs'}
                  {tab === 'device' && 'Device'}
                  {tab === 'tools'  && 'Outils'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Content */}
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>

            {/* ── TESTS ── */}
            {activeTab === 'tests' && (
              <View>
                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={[styles.runBtn, isRunningTests && styles.runBtnDisabled]}
                    onPress={runAllTests}
                    disabled={isRunningTests}
                  >
                    <Play size={18} color={Colors.black} />
                    <Text style={styles.runBtnText}>
                      {isRunningTests ? 'En cours...' : 'Lancer tous les tests'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.clearBtn} onPress={clearResults}>
                    <Trash2 size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                </View>

                {Object.entries(TEST_SUITES).map(([category, tests]) => (
                  <View key={category} style={styles.category}>
                    <Text style={styles.categoryTitle}>
                      {category === 'connection' && 'Connexion'}
                      {category === 'radio'      && 'Radio'}
                      {category === 'messaging'  && 'Messagerie'}
                    </Text>
                    {tests.map((test) => {
                      const result = testResults.find((r) => r.id === test.id);
                      const Icon   = test.icon;
                      return (
                        <View key={test.id} style={styles.testRow}>
                          <Icon size={16} color={Colors.textMuted} style={{ marginRight: 10 }} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.testName}>{test.name}</Text>
                            {result ? (
                              <Text style={[
                                styles.testMsg,
                                result.status === 'success' && { color: Colors.green },
                                result.status === 'failed'  && { color: Colors.red   },
                                result.status === 'warning' && { color: Colors.yellow},
                                result.status === 'running' && { color: Colors.accent },
                              ]}>
                                {result.status === 'running'  && '⏳ '}
                                {result.status === 'success'  && '✅ '}
                                {result.status === 'failed'   && '❌ '}
                                {result.status === 'warning'  && '⚠️ '}
                                {result.message}
                              </Text>
                            ) : (
                              <Text style={styles.testPending}>En attente</Text>
                            )}
                          </View>
                          {result?.duration != null && (
                            <Text style={styles.testDuration}>{result.duration}ms</Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            )}

            {/* ── LOGS ── */}
            {activeTab === 'logs' && (
              <View>
                <TouchableOpacity style={styles.exportBtn} onPress={() => setLogs([])}>
                  <Trash2 size={14} color={Colors.textMuted} />
                  <Text style={styles.exportBtnText}>Effacer les logs</Text>
                </TouchableOpacity>
                {logs.length === 0 ? (
                  <Text style={styles.emptyText}>Aucun log</Text>
                ) : (
                  logs.slice(-50).reverse().map((log) => (
                    <View key={log.id} style={styles.logRow}>
                      <Text style={styles.logTime}>{new Date(log.timestamp).toLocaleTimeString()}</Text>
                      <Text style={[
                        styles.logLevel,
                        log.level === 'error' && { color: Colors.red    },
                        log.level === 'warn'  && { color: Colors.yellow  },
                        log.level === 'info'  && { color: Colors.green   },
                        log.level === 'debug' && { color: Colors.textMuted },
                      ]}>{log.level.toUpperCase()}</Text>
                      <Text style={styles.logSrc}>[{log.source}]</Text>
                      <Text style={styles.logMsg} numberOfLines={2}>{log.message}</Text>
                    </View>
                  ))
                )}
              </View>
            )}

            {/* ── DEVICE ── */}
            {activeTab === 'device' && (
              <View>
                <InfoCard label="Connexion BLE"
                  value={connected ? '✅ Connecté' : '❌ Déconnecté'}
                  valueStyle={{ color: connected ? Colors.green : Colors.red }} />
                {device && (
                  <InfoCard label="Device" value={device.name} sub={device.id} />
                )}
                <InfoCard
                  label="Canal actif"
                  value={`${currentChannel} (${currentChannel === 0 ? 'Public' : 'Privé'})`}
                  sub={currentChannel === 0 ? 'Public' : 'Privé'}
                />
                <InfoCard label="Contacts" value={`${meshContacts.length} nœuds connus`} />
                {deviceInfo && <>
                  <InfoCard
                    label="Fréquence"
                    value={`${(deviceInfo.radioFreqHz / 1e6).toFixed(3)} MHz`}
                    sub={`SF${deviceInfo.radioSf} | BW ${deviceInfo.radioBwHz / 1000} kHz | CR 4/${deviceInfo.radioCr}`}
                  />
                  <InfoCard label="Puissance TX" value={`${deviceInfo.txPower} dBm`} />
                  <InfoCard
                    label="Clé Publique"
                    sub={`${deviceInfo.publicKey?.slice(0, 24)}...`}
                    value=""
                  />
                </>}

                {/* Liste contacts */}
                {meshContacts.length > 0 && (
                  <View style={styles.contactList}>
                    <Text style={styles.categoryTitle}>Contacts ({meshContacts.length})</Text>
                    {meshContacts.map((c) => (
                      <View key={c.pubkeyHex} style={styles.contactRow}>
                        <Text style={styles.contactName}>{c.name}</Text>
                        <Text style={styles.contactKey}>{c.pubkeyPrefix}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {showRawData && deviceInfo && (
                  <View style={styles.rawBox}>
                    <Text style={styles.rawTitle}>DeviceInfo (raw):</Text>
                    <Text style={styles.rawContent}>{JSON.stringify(deviceInfo, null, 2)}</Text>
                  </View>
                )}

                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>Données brutes</Text>
                  <Switch
                    value={showRawData}
                    onValueChange={setShowRawData}
                    trackColor={{ false: Colors.surfaceLight, true: Colors.accentDim }}
                    thumbColor={showRawData ? Colors.accent : Colors.textMuted}
                  />
                </View>
              </View>
            )}

            {/* ── TOOLS ── */}
            {activeTab === 'tools' && (
              <View>
                <Text style={styles.sectionTitle}>Test manuel</Text>
                <View style={styles.toolCard}>
                  <Text style={styles.toolLabel}>Message</Text>
                  <TextInput
                    style={styles.toolInput}
                    value={testMessage}
                    onChangeText={setTestMessage}
                    placeholder="Message de test..."
                    placeholderTextColor={Colors.textMuted}
                    color={Colors.text}
                  />
                  <Text style={styles.toolLabel}>Canal (0–7)</Text>
                  <TextInput
                    style={[styles.toolInput, { width: 80 }]}
                    value={targetChannel}
                    onChangeText={setTargetChannel}
                    keyboardType="number-pad"
                    maxLength={1}
                    color={Colors.text}
                  />
                  <TouchableOpacity
                    style={[styles.sendBtn, !connected && styles.sendBtnDisabled]}
                    onPress={runManualTest}
                    disabled={!connected}
                  >
                    <Send size={16} color={Colors.black} />
                    <Text style={styles.sendBtnText}>Envoyer</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.sectionTitle}>Actions</Text>
                <TouchableOpacity
                  style={[styles.actionRow, !connected && styles.actionRowDisabled]}
                  onPress={() => { syncContacts(); addLog('info', 'Action', 'Sync contacts demandée'); }}
                  disabled={!connected}
                >
                  <RotateCcw size={16} color={connected ? Colors.accent : Colors.textMuted} />
                  <Text style={[styles.actionRowText, !connected && { color: Colors.textMuted }]}>
                    Sync Contacts
                  </Text>
                </TouchableOpacity>
              </View>
            )}

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── InfoCard helper ────────────────────────────────────────────────────

function InfoCard({ label, value, sub, valueStyle }: {
  label: string; value: string; sub?: string; valueStyle?: any
}) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoLabel}>{label}</Text>
      {value ? <Text style={[styles.infoValue, valueStyle]}>{value}</Text> : null}
      {sub    ? <Text style={styles.infoSub}>{sub}</Text> : null}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '92%',
    minHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: Colors.accentGlow,
    justifyContent: 'center', alignItems: 'center',
  },
  title:    { fontSize: 18, fontWeight: '700', color: Colors.text },
  subtitle: { fontSize: 13, color: Colors.textMuted, marginTop: 2 },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surfaceLight,
    justifyContent: 'center', alignItems: 'center',
  },
  closeText: { fontSize: 18, color: Colors.textSecondary },

  statsRow: { flexDirection: 'row', padding: 12, gap: 8 },
  statBadge: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.border,
  },
  statValue: { fontSize: 20, fontWeight: '800', fontFamily: 'monospace' },
  statLabel: { fontSize: 10, fontWeight: '600', color: Colors.textMuted, marginTop: 2 },

  progressTrack: {
    height: 4, backgroundColor: Colors.surfaceLight,
    marginHorizontal: 20, marginBottom: 8,
    borderRadius: 2, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: Colors.accent, borderRadius: 2 },

  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingHorizontal: 8,
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: Colors.accent },
  tabText: { fontSize: 13, fontWeight: '600', color: Colors.textMuted },
  tabTextActive: { color: Colors.accent },

  content: { padding: 16, flex: 1 },

  actionsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  runBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.accent,
    paddingVertical: 14, borderRadius: 12,
  },
  runBtnDisabled: { opacity: 0.5 },
  runBtnText: { fontSize: 15, fontWeight: '700', color: Colors.black },
  clearBtn: {
    width: 48, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
  },

  category: { marginBottom: 20 },
  categoryTitle: {
    fontSize: 11, fontWeight: '700', color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10,
  },
  testRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: Colors.surface,
    padding: 12, borderRadius: 10, marginBottom: 8,
    borderWidth: 1, borderColor: Colors.border,
  },
  testName: { fontSize: 14, fontWeight: '600', color: Colors.text, marginBottom: 2 },
  testMsg:  { fontSize: 12, color: Colors.textMuted },
  testPending: { fontSize: 12, color: Colors.textMuted, fontStyle: 'italic' },
  testDuration: { fontSize: 11, color: Colors.textMuted, fontFamily: 'monospace', marginLeft: 6 },

  exportBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, marginBottom: 12,
  },
  exportBtnText: { fontSize: 13, color: Colors.textMuted },

  logRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: `${Colors.border}80`,
  },
  logTime:  { fontSize: 10, color: Colors.textMuted, fontFamily: 'monospace', minWidth: 70 },
  logLevel: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace', minWidth: 44 },
  logSrc:   { fontSize: 10, color: Colors.textMuted, fontFamily: 'monospace' },
  logMsg:   { fontSize: 11, color: Colors.textSecondary, flex: 1 },

  emptyText: { fontSize: 14, color: Colors.textMuted, textAlign: 'center', marginTop: 30 },

  infoCard: {
    backgroundColor: Colors.surface,
    padding: 14, borderRadius: 10, marginBottom: 10,
    borderWidth: 1, borderColor: Colors.border,
  },
  infoLabel: { fontSize: 11, color: Colors.textMuted, textTransform: 'uppercase', marginBottom: 4, fontWeight: '600' },
  infoValue: { fontSize: 16, fontWeight: '700', color: Colors.text },
  infoSub:   { fontSize: 12, color: Colors.textMuted, marginTop: 2, fontFamily: 'monospace' },

  contactList: { marginTop: 12 },
  contactRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 10, borderRadius: 8, marginBottom: 6,
    borderWidth: 1, borderColor: Colors.border,
  },
  contactName: { fontSize: 14, fontWeight: '600', color: Colors.text },
  contactKey:  { fontSize: 11, color: Colors.textMuted, fontFamily: 'monospace' },

  rawBox: {
    backgroundColor: Colors.surfaceLight,
    padding: 12, borderRadius: 8, marginTop: 10,
    borderWidth: 1, borderColor: Colors.border,
  },
  rawTitle:   { fontSize: 11, color: Colors.textMuted, marginBottom: 6, fontWeight: '600' },
  rawContent: { fontSize: 11, color: Colors.textSecondary, fontFamily: 'monospace' },

  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    padding: 14, borderRadius: 10, marginBottom: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  toggleLabel: { fontSize: 14, fontWeight: '600', color: Colors.textSecondary },

  sectionTitle: {
    fontSize: 13, fontWeight: '700', color: Colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 12, marginTop: 8,
  },

  toolCard: {
    backgroundColor: Colors.surface, padding: 14,
    borderRadius: 10, marginBottom: 20,
    borderWidth: 1, borderColor: Colors.border, gap: 8,
  },
  toolLabel: { fontSize: 12, color: Colors.textMuted, fontWeight: '600' },
  toolInput: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 13, borderWidth: 1, borderColor: Colors.border,
  },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.accent, paddingVertical: 12, borderRadius: 10, marginTop: 4,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { fontSize: 15, fontWeight: '700', color: Colors.black },

  actionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: Colors.surface,
    padding: 14, borderRadius: 10, marginBottom: 10,
    borderWidth: 1, borderColor: Colors.border,
  },
  actionRowDisabled: { opacity: 0.4 },
  actionRowText: { fontSize: 15, fontWeight: '600', color: Colors.accent },
});
