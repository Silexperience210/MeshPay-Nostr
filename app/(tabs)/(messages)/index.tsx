import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react'; // ✅ useCallback et useMemo importés
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TouchableOpacity,
  Animated,
  Modal,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Radio, Plus, Wifi, Globe, Hash, User, X, Lock, Search, Eye, EyeOff, Copy, KeyRound, ShieldCheck } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { generateForumKey } from '@/utils/encryption';
import Colors from '@/constants/colors';
import { formatTime } from '@/utils/helpers';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import { useMessages } from '@/providers/MessagesProvider';
import { useNostr } from '@/providers/NostrProvider';
import { nostrClient } from '@/utils/nostr-client';
import { nip19 } from 'nostr-tools';
import type { StoredConversation } from '@/utils/messages-store';
import type { DBContact } from '@/utils/database';
import type { NostrEvent } from 'nostr-tools';

// ✅ OPTIMISATION: Separator component (défini après les styles pour éviter les références avant déclaration)
const SeparatorComponent = React.memo(() => <View style={{ height: 0.5, backgroundColor: Colors.border, marginLeft: 80 }} />);

const SignalDots = React.memo(function SignalDots({ strength }: { strength: number }) {
  const bars = strength >= 70 ? 3 : strength >= 40 ? 2 : 1;
  const color = strength >= 70 ? Colors.green : strength >= 40 ? Colors.yellow : Colors.red;
  return (
    <View style={styles.signalDots}>
      {[1, 2, 3].map((i) => (
        <View
          key={i}
          style={[
            styles.signalDot,
            { backgroundColor: i <= bars ? color : Colors.surfaceHighlight, height: 4 + i * 3 },
          ]}
        />
      ))}
    </View>
  );
});

// ✅ OPTIMISATION: React.memo pour éviter les re-renders inutiles
const ConvItem = React.memo(function ConvItem({ conv, onPress, onLongPress }: { conv: StoredConversation; onPress: () => void; onLongPress: () => void }) {
  const scaleAnim = React.useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true }).start();
  }, [scaleAnim]);
  
  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, { toValue: 1, friction: 3, useNativeDriver: true }).start();
  }, [scaleAnim]);

  const avatar = conv.isForum ? '#' : conv.name.charAt(0).toUpperCase();
  const avatarBg = conv.isForum ? Colors.cyanDim : Colors.surfaceLight;

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={styles.chatItem}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={500}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
      >
        <View style={styles.avatarContainer}>
          <View style={[styles.avatar, { backgroundColor: avatarBg }, conv.online && styles.avatarOnline]}>
            <Text style={styles.avatarText}>{avatar}</Text>
          </View>
          {conv.online && <View style={styles.onlineDot} />}
        </View>

        <View style={styles.chatContent}>
          <View style={styles.chatHeader}>
            <View style={styles.chatNameRow}>
              <Text style={styles.chatName} numberOfLines={1}>{conv.name}</Text>
              {conv.isForum ? (
                <View style={styles.forumBadge}>
                  <Hash size={8} color={Colors.cyan} />
                  <Text style={[styles.meshBadgeText, { color: Colors.cyan }]}>forum</Text>
                </View>
              ) : (
                <View style={styles.meshBadge}>
                  <Lock size={8} color={Colors.accent} />
                  <Text style={styles.meshBadgeText}>E2E</Text>
                </View>
              )}
            </View>
            <Text style={styles.chatTime}>
              {conv.lastMessageTime > 0 ? formatTime(conv.lastMessageTime) : ''}
            </Text>
          </View>

          <View style={styles.chatFooter}>
            <Text style={styles.chatLastMessage} numberOfLines={1}>
              {conv.lastMessage || 'Nouvelle conversation'}
            </Text>
            <View style={styles.chatMeta}>
              <SignalDots strength={conv.online ? 70 : 0} />
              {conv.unreadCount > 0 && (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadText}>{conv.unreadCount}</Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
});

// Valider le nom de forum
function validateForumName(name: string): string | null {
  if (!name.trim()) return 'Entrez un nom de forum';
  if (name.length > 64) return 'Nom trop long (max 64 caractères)';
  if (/[#$+]/.test(name)) return 'Caractères interdits: # $ +';
  return null;
}

// Détecter le type d'identifiant Nostr saisi et retourner { nodeId, pubkey }
function parseNostrInput(input: string): { nodeId: string; pubkey?: string; type: 'mesh' | 'npub' | 'hex64' | 'hex66' } {
  const trimmed = input.trim();

  // npub bech32 (ex: npub1abc...)
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') {
        const hex64 = decoded.data as string;
        const nodeId = 'NOSTR-' + hex64.slice(0, 8).toUpperCase();
        return { nodeId, pubkey: '02' + hex64, type: 'npub' };
      }
    } catch {}
  }

  // Hex 64 chars = x-only pubkey Nostr
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    const hex64 = trimmed.toLowerCase();
    const nodeId = 'NOSTR-' + hex64.slice(0, 8).toUpperCase();
    return { nodeId, pubkey: '02' + hex64, type: 'hex64' };
  }

  // Hex 66 chars = pubkey compressée secp256k1
  if (/^(02|03)[a-f0-9]{64}$/i.test(trimmed)) {
    const hex66 = trimmed.toLowerCase();
    const nodeId = 'NOSTR-' + hex66.slice(2, 10).toUpperCase();
    return { nodeId, pubkey: hex66, type: 'hex66' };
  }

  // Défaut: MESH-XXXX ou autre nodeId local
  return { nodeId: trimmed.toUpperCase(), type: 'mesh' };
}

// Forum découvert via NIP-28 kind:40
interface DiscoveredForum {
  channelId: string;
  name: string;
  about: string;
  creatorPubkey: string;
  createdAt: number;
}

// Modal pour nouvelle conversation ou rejoindre un forum
function NewChatModal({ visible, onClose, onDM, onForum }: {
  visible: boolean;
  onClose: () => void;
  onDM: (nodeId: string, name: string, pubkey?: string) => void;
  onForum: (channelName: string, pskHex?: string, skipAnnounce?: boolean) => Promise<void>;
}) {
  const { joinForum: joinForumContext } = useMessages();
  const { isConnected: nostrConnected } = useNostr();
  const [tab, setTab] = useState<'dm' | 'forum' | 'discover'>('dm');
  const [nodeId, setNodeId] = useState('');
  const [name, setName] = useState('');
  // Forum public
  const [channel, setChannel] = useState('');
  // Forum privé
  const [forumType, setForumType] = useState<'public' | 'private'>('public');
  const [privateAction, setPrivateAction] = useState<'create' | 'join'>('create');
  const [privateName, setPrivateName] = useState('');
  const [privateDesc, setPrivateDesc] = useState('');
  const [generatedPsk, setGeneratedPsk] = useState<string | null>(null);
  const [joinPsk, setJoinPsk] = useState('');
  const [showPsk, setShowPsk] = useState(false);
  const [pskCopied, setPskCopied] = useState(false);
  // Discover
  const [newForumName, setNewForumName] = useState('');
  const [newForumDesc, setNewForumDesc] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [discoveredForums, setDiscoveredForums] = useState<DiscoveredForum[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);

  // Reset all state when modal opens
  useEffect(() => {
    if (visible) {
      setTab('dm');
      setNodeId('');
      setName('');
      setChannel('');
      setForumType('public');
      setPrivateAction('create');
      setPrivateName('');
      setPrivateDesc('');
      setGeneratedPsk(null);
      setJoinPsk('');
      setShowPsk(false);
      setPskCopied(false);
      setNewForumName('');
      setNewForumDesc('');
      setShowCreateForm(false);
      setLoading(false);
      setDiscoveredForums([]);
      setDiscoverLoading(false);
    }
  }, [visible]);

  const handleGeneratePsk = () => {
    const psk = generateForumKey();
    setGeneratedPsk(psk);
    setPskCopied(false);
  };

  const handleCopyPsk = () => {
    if (!generatedPsk) return;
    Clipboard.setStringAsync(generatedPsk);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPskCopied(true);
    setTimeout(() => setPskCopied(false), 2000);
  };

  // Découverte de forums via kind:40 quand l'onglet est actif
  useEffect(() => {
    if (tab !== 'discover' || !visible || !nostrConnected) return;

    setDiscoverLoading(true);
    const found = new Map<string, DiscoveredForum>();

    const unsub = nostrClient.subscribeForums((event: NostrEvent) => {
      try {
        const meta = JSON.parse(event.content) as { name?: string; about?: string };
        const forumName = (meta.name ?? '').toLowerCase().trim();
        if (!forumName) return;
        if (!found.has(event.id)) {
          found.set(event.id, {
            channelId: event.id,
            name: forumName,
            about: meta.about ?? '',
            creatorPubkey: event.pubkey,
            createdAt: event.created_at,
          });
          setDiscoveredForums(Array.from(found.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 30));
        }
      } catch {}
    });

    // Arrêt auto après 8 secondes (pas un stream continu)
    const timer = setTimeout(() => {
      setDiscoverLoading(false);
    }, 8000);

    return () => { unsub(); clearTimeout(timer); };
  }, [tab, visible, nostrConnected]);

  const handleDM = () => {
    if (!nodeId.trim()) return;
    const parsed = parseNostrInput(nodeId);
    onDM(parsed.nodeId, name.trim() || parsed.nodeId, parsed.pubkey);
    setNodeId(''); setName('');
    onClose();
  };

  // Rejoindre un forum public par nom
  const handleForum = async () => {
    if (!channel.trim()) return;
    const channelName = channel.trim().toLowerCase().replace(/\s+/g, '-');
    const error = validateForumName(channelName);
    if (error) { Alert.alert('Nom invalide', error); return; }
    try {
      setLoading(true);
      await onForum(channelName);
      setChannel('');
      onClose();
    } catch {
      Alert.alert('Erreur', 'Impossible de rejoindre le forum. Réessayez.');
    } finally {
      setLoading(false);
    }
  };

  // Créer un forum privé avec PSK générée
  const handleCreatePrivateForum = async () => {
    const channelName = privateName.trim().toLowerCase().replace(/\s+/g, '-');
    const error = validateForumName(channelName);
    if (error) { Alert.alert('Nom invalide', error); return; }
    if (!generatedPsk) { Alert.alert('Clé manquante', 'Générez une clé secrète avant de créer le forum.'); return; }
    if (!nostrConnected) { Alert.alert('Non connecté', 'Nostr est requis pour créer un forum.'); return; }
    try {
      setLoading(true);
      await onForum(channelName, generatedPsk);
      setPrivateName(''); setPrivateDesc(''); setGeneratedPsk(null);
      onClose();
    } catch (err) {
      Alert.alert('Erreur', err instanceof Error ? err.message : 'Impossible de créer le forum privé.');
    } finally {
      setLoading(false);
    }
  };

  // Rejoindre un forum privé avec PSK connue
  const handleJoinPrivateForum = async () => {
    const channelName = privateName.trim().toLowerCase().replace(/\s+/g, '-');
    const error = validateForumName(channelName);
    if (error) { Alert.alert('Nom invalide', error); return; }
    if (!joinPsk.trim() || joinPsk.trim().length !== 64) {
      Alert.alert('Clé invalide', 'La clé secrète doit faire 64 caractères hexadécimaux.');
      return;
    }
    try {
      setLoading(true);
      await onForum(channelName, joinPsk.trim(), true); // skipAnnounce = true
      setPrivateName(''); setJoinPsk('');
      onClose();
    } catch (err) {
      Alert.alert('Erreur', err instanceof Error ? err.message : 'Impossible de rejoindre le forum privé.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePublicForum = async () => {
    const error = validateForumName(newForumName);
    if (error) {
      Alert.alert('Nom invalide', error);
      return;
    }

    if (!nostrConnected) {
      Alert.alert(
        'Non connecté',
        'Nostr n\'est pas encore connecté. Veuillez patienter quelques secondes et réessayer.'
      );
      return;
    }

    const channelName = newForumName.toLowerCase().replace(/\s+/g, '-');
    try {
      setLoading(true);
      await joinForumContext(channelName, newForumDesc || `Forum ${newForumName}`);
      Alert.alert('Forum créé!', `"#${channelName}" a été créé et annoncé sur Nostr.`);
      setNewForumName(''); setNewForumDesc(''); setShowCreateForm(false);
      onForum(channelName);
    } catch (err) {
      console.log('[Forum] Erreur création:', err);
      Alert.alert('Erreur', `Impossible de créer le forum: ${err instanceof Error ? err.message : 'Erreur inconnue'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleJoinDiscoveredForum = async (channelName: string, description: string) => {
    try {
      setLoading(true);
      // skipAnnounce = true : ne pas re-publier kind:40, le forum existe déjà sur Nostr
      await joinForumContext(channelName, description, undefined, true);
      Alert.alert('Rejoint !', `Vous avez rejoint #${channelName}`);
      onClose();
    } catch {
      Alert.alert('Erreur', 'Impossible de rejoindre ce forum.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Nouvelle conversation</Text>
            <TouchableOpacity onPress={onClose}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.tabRow}>
            <TouchableOpacity
              style={[styles.tab, tab === 'dm' && styles.tabActive]}
              onPress={() => setTab('dm')}
            >
              <User size={14} color={tab === 'dm' ? Colors.accent : Colors.textMuted} />
              <Text style={[styles.tabText, tab === 'dm' && { color: Colors.accent }]}>DM</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, tab === 'forum' && styles.tabActive]}
              onPress={() => setTab('forum')}
            >
              <Hash size={14} color={tab === 'forum' ? Colors.cyan : Colors.textMuted} />
              <Text style={[styles.tabText, tab === 'forum' && { color: Colors.cyan }]}>Forum</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, tab === 'discover' && styles.tabActive]}
              onPress={() => setTab('discover')}
            >
              <Search size={14} color={tab === 'discover' ? Colors.green : Colors.textMuted} />
              <Text style={[styles.tabText, tab === 'discover' && { color: Colors.green }]}>Découvrir</Text>
            </TouchableOpacity>
          </View>

          {tab === 'dm' ? (
            <View style={styles.modalBody}>
              <Text style={styles.inputLabel}>Identifiant du destinataire</Text>
              <TextInput
                style={styles.modalInput}
                value={nodeId}
                onChangeText={setNodeId}
                placeholder="MESH-XXXX · npub1... · hex64"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {nodeId.length > 0 && (() => {
                const p = parseNostrInput(nodeId);
                const isNostr = p.type !== 'mesh';
                return (
                  <Text style={[styles.inputHint, { color: isNostr ? Colors.purple ?? '#9b59b6' : Colors.textMuted }]}>
                    {isNostr
                      ? `⚡ Nostr — NIP-17 Gift Wrap · NodeID: ${p.nodeId}`
                      : '🔵 MeshCore — chiffrement ECDH BLE/LoRa'}
                  </Text>
                );
              })()}
              <Text style={styles.inputLabel}>Nom (optionnel)</Text>
              <TextInput
                style={styles.modalInput}
                value={name}
                onChangeText={setName}
                placeholder="Alice"
                placeholderTextColor={Colors.textMuted}
              />
              <Text style={styles.inputHint}>
                Accepte MESH-XXXX (BLE/LoRa), npub1... ou clé hex Nostr (NIP-17).
              </Text>
              <TouchableOpacity style={styles.modalBtn} onPress={handleDM}>
                <Lock size={14} color={Colors.black} />
                <Text style={styles.modalBtnText}>Démarrer DM chiffré</Text>
              </TouchableOpacity>
            </View>
          ) : tab === 'forum' ? (
            <View style={styles.modalBody}>
              {/* Toggle Public / Privé */}
              <View style={styles.forumTypeRow}>
                <TouchableOpacity
                  style={[styles.forumTypeBtn, forumType === 'public' && styles.forumTypeBtnActive]}
                  onPress={() => setForumType('public')} activeOpacity={0.7}
                >
                  <Globe size={13} color={forumType === 'public' ? Colors.cyan : Colors.textMuted} />
                  <Text style={[styles.forumTypeTxt, forumType === 'public' && { color: Colors.cyan }]}>Public</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.forumTypeBtn, forumType === 'private' && styles.forumTypeBtnPrivate]}
                  onPress={() => setForumType('private')} activeOpacity={0.7}
                >
                  <ShieldCheck size={13} color={forumType === 'private' ? Colors.accent : Colors.textMuted} />
                  <Text style={[styles.forumTypeTxt, forumType === 'private' && { color: Colors.accent }]}>Privé (PSK)</Text>
                </TouchableOpacity>
              </View>

              {forumType === 'public' ? (
                <>
                  <Text style={styles.inputLabel}>Nom du canal</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={channel}
                    onChangeText={setChannel}
                    placeholder="bitcoin-paris"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="none"
                  />
                  <Text style={styles.inputHint}>
                    Tout le monde connaissant ce nom peut rejoindre. Messages publics sur Nostr (NIP-28).
                  </Text>
                  <TouchableOpacity
                    style={[styles.modalBtn, { backgroundColor: Colors.cyan, opacity: loading ? 0.6 : 1 }]}
                    onPress={handleForum} disabled={loading}
                  >
                    {loading ? <ActivityIndicator size="small" color={Colors.black} /> : (
                      <><Hash size={14} color={Colors.black} /><Text style={styles.modalBtnText}>Rejoindre le forum</Text></>
                    )}
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {/* Sous-onglets Créer / Rejoindre */}
                  <View style={styles.privateSubRow}>
                    <TouchableOpacity
                      style={[styles.privateSubBtn, privateAction === 'create' && styles.privateSubBtnActive]}
                      onPress={() => { setPrivateAction('create'); setGeneratedPsk(null); }} activeOpacity={0.7}
                    >
                      <Text style={[styles.privateSubTxt, privateAction === 'create' && { color: Colors.accent }]}>Créer</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.privateSubBtn, privateAction === 'join' && styles.privateSubBtnActive]}
                      onPress={() => setPrivateAction('join')} activeOpacity={0.7}
                    >
                      <Text style={[styles.privateSubTxt, privateAction === 'join' && { color: Colors.accent }]}>Rejoindre</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.inputLabel}>Nom du forum</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={privateName}
                    onChangeText={setPrivateName}
                    placeholder="mon-forum-secret"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="none"
                  />

                  {privateAction === 'create' ? (
                    <>
                      <TextInput
                        style={styles.modalInput}
                        value={privateDesc}
                        onChangeText={setPrivateDesc}
                        placeholder="Description (optionnel)"
                        placeholderTextColor={Colors.textMuted}
                      />

                      {/* Génération PSK */}
                      {!generatedPsk ? (
                        <TouchableOpacity style={styles.pskGenBtn} onPress={handleGeneratePsk} activeOpacity={0.7}>
                          <KeyRound size={15} color={Colors.accent} />
                          <Text style={styles.pskGenTxt}>Générer une clé secrète</Text>
                        </TouchableOpacity>
                      ) : (
                        <View style={styles.pskBox}>
                          <View style={styles.pskHeader}>
                            <ShieldCheck size={13} color={Colors.accent} />
                            <Text style={styles.pskLabel}>Clé secrète (partagez-la aux membres via DM)</Text>
                          </View>
                          <View style={styles.pskRow}>
                            <Text style={styles.pskValue} numberOfLines={showPsk ? undefined : 1}>
                              {showPsk ? generatedPsk : '••••••••••••••••••••••••••••••••'}
                            </Text>
                            <TouchableOpacity onPress={() => setShowPsk(v => !v)} style={styles.pskEye} activeOpacity={0.7}>
                              {showPsk ? <EyeOff size={14} color={Colors.textMuted} /> : <Eye size={14} color={Colors.textMuted} />}
                            </TouchableOpacity>
                          </View>
                          <TouchableOpacity style={styles.pskCopyBtn} onPress={handleCopyPsk} activeOpacity={0.7}>
                            <Copy size={13} color={pskCopied ? Colors.accent : Colors.textMuted} />
                            <Text style={[styles.pskCopyTxt, pskCopied && { color: Colors.accent }]}>
                              {pskCopied ? 'Copié !' : 'Copier la clé'}
                            </Text>
                          </TouchableOpacity>
                          <Text style={styles.pskWarning}>
                            ⚠️ Partagez cette clé uniquement via DM chiffré. Sans elle, impossible de lire les messages.
                          </Text>
                        </View>
                      )}

                      <TouchableOpacity
                        style={[styles.modalBtn, { opacity: loading || !generatedPsk ? 0.5 : 1 }]}
                        onPress={handleCreatePrivateForum}
                        disabled={loading || !generatedPsk}
                      >
                        {loading ? <ActivityIndicator size="small" color={Colors.black} /> : (
                          <><Lock size={14} color={Colors.black} /><Text style={styles.modalBtnText}>Créer le forum privé</Text></>
                        )}
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <Text style={styles.inputLabel}>Clé secrète (PSK)</Text>
                      <View style={styles.pskInputRow}>
                        <TextInput
                          style={[styles.modalInput, { flex: 1, fontFamily: 'monospace', fontSize: 12 }]}
                          value={joinPsk}
                          onChangeText={setJoinPsk}
                          placeholder="64 caractères hexadécimaux..."
                          placeholderTextColor={Colors.textMuted}
                          autoCapitalize="none"
                          autoCorrect={false}
                          secureTextEntry={!showPsk}
                        />
                        <TouchableOpacity onPress={() => setShowPsk(v => !v)} style={styles.pskEye} activeOpacity={0.7}>
                          {showPsk ? <EyeOff size={14} color={Colors.textMuted} /> : <Eye size={14} color={Colors.textMuted} />}
                        </TouchableOpacity>
                      </View>
                      {joinPsk.length > 0 && joinPsk.length !== 64 && (
                        <Text style={[styles.inputHint, { color: Colors.red }]}>
                          {64 - joinPsk.length} caractères manquants
                        </Text>
                      )}
                      <Text style={styles.inputHint}>
                        Collez la clé partagée par le créateur du forum.
                      </Text>
                      <TouchableOpacity
                        style={[styles.modalBtn, { opacity: loading || joinPsk.length !== 64 ? 0.5 : 1 }]}
                        onPress={handleJoinPrivateForum}
                        disabled={loading || joinPsk.length !== 64}
                      >
                        {loading ? <ActivityIndicator size="small" color={Colors.black} /> : (
                          <><Lock size={14} color={Colors.black} /><Text style={styles.modalBtnText}>Rejoindre le forum privé</Text></>
                        )}
                      </TouchableOpacity>
                    </>
                  )}
                </>
              )}
            </View>
          ) : (
            <View style={styles.modalBody}>
              <TouchableOpacity
                style={styles.createForumBtn}
                onPress={() => setShowCreateForm(!showCreateForm)}
                activeOpacity={0.7}
              >
                <Plus size={16} color={Colors.green} />
                <Text style={[styles.tabText, { color: Colors.green }]}>
                  {showCreateForm ? 'Annuler' : 'Créer un forum public'}
                </Text>
              </TouchableOpacity>

              {showCreateForm && (
                <View style={{ gap: 8, marginTop: 8 }}>
                  <TextInput
                    style={styles.modalInput}
                    placeholder="Nom du forum (ex: bitcoin-paris)"
                    placeholderTextColor={Colors.textMuted}
                    value={newForumName}
                    onChangeText={setNewForumName}
                    autoCapitalize="none"
                  />
                  <TextInput
                    style={styles.modalInput}
                    placeholder="Description (optionnel)"
                    placeholderTextColor={Colors.textMuted}
                    value={newForumDesc}
                    onChangeText={setNewForumDesc}
                  />
                  <TouchableOpacity
                    style={[styles.modalBtn, { backgroundColor: Colors.green, opacity: loading ? 0.6 : 1 }]}
                    onPress={handleCreatePublicForum}
                    disabled={loading}
                  >
                    {loading ? (
                      <ActivityIndicator size="small" color={Colors.black} />
                    ) : (
                      <Text style={styles.modalBtnText}>Créer et Annoncer</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}

              <View style={styles.discoverHeader}>
                <Text style={styles.inputLabel}>Forums Nostr (NIP-28)</Text>
                {discoverLoading && <ActivityIndicator size="small" color={Colors.purple ?? '#9b59b6'} />}
              </View>

              {!nostrConnected ? (
                <View style={styles.discoverEmpty}>
                  <Text style={{ color: Colors.textMuted, fontSize: 13 }}>
                    Nostr non connecté — impossible de chercher des forums.
                  </Text>
                </View>
              ) : discoveredForums.length === 0 ? (
                <View style={styles.discoverEmpty}>
                  <Search size={28} color={Colors.textMuted} />
                  <Text style={{ color: Colors.textMuted, fontSize: 13, marginTop: 8 }}>
                    {discoverLoading ? 'Recherche sur les relays…' : 'Aucun forum trouvé.'}
                  </Text>
                </View>
              ) : (
                <ScrollView style={styles.discoverList} showsVerticalScrollIndicator={false}>
                  {discoveredForums.map((forum) => (
                    <TouchableOpacity
                      key={forum.channelId}
                      style={styles.discoveredForumItem}
                      onPress={() => handleJoinDiscoveredForum(forum.name, forum.about)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.forumIconSmall}>
                        <Hash size={16} color={Colors.cyan} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.discoveredForumName}>#{forum.name}</Text>
                        {forum.about ? (
                          <Text style={styles.discoveredForumDesc} numberOfLines={1}>{forum.about}</Text>
                        ) : null}
                      </View>
                      <Plus size={16} color={Colors.green} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default function MessagesScreen() {
  const router = useRouter();
  const { settings, isInternetMode, isLoRaMode } = useAppSettings();
  const { conversations, identity, startConversation, joinForum, deleteConversation, contacts } = useMessages();
  const { isConnected: nostrConnected, isConnecting: nostrConnecting } = useNostr();
  const [modalVisible, setModalVisible] = useState(false);
  
  // ✅ OPTIMISATION: Deduplicate conversations une seule fois avec useMemo
  // Évite le recalcul à chaque render
  const uniqueConversations = useMemo(() => {
    return conversations.filter((conv, index, self) =>
      index === self.findIndex(c => c.id === conv.id)
    );
  }, [conversations]);

  // ✅ OPTIMISATION: useMemo pour les calculs de mode
  const { modeLabel, modeColor, ModeIcon } = useMemo(() => {
    const modeLabel = settings.connectionMode === 'internet' ? 'Internet Mode'
      : settings.connectionMode === 'bridge' ? 'Bridge Mode' : 'LoRa Mesh';
    const modeColor = settings.connectionMode === 'internet' ? Colors.blue
      : settings.connectionMode === 'bridge' ? Colors.cyan : Colors.green;
    const ModeIcon = settings.connectionMode === 'internet' ? Globe
      : settings.connectionMode === 'bridge' ? Wifi : Radio;
    return { modeLabel, modeColor, ModeIcon };
  }, [settings.connectionMode]);

  // ✅ OPTIMISATION: useCallback stable avec toutes les dépendances
  const handleLongPressConv = useCallback((item: StoredConversation) => {
    Alert.alert(
      item.isForum ? `Quitter #${item.name} ?` : `Supprimer la conversation avec ${item.name} ?`,
      'Tous les messages seront supprimés de cet appareil.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: item.isForum ? 'Quitter' : 'Supprimer',
          style: 'destructive',
          onPress: () => deleteConversation(item.id),
        },
      ]
    );
  }, [deleteConversation]); // ✅ Dépendance stable

  // ✅ OPTIMISATION: renderConv optimisé avec dépendances minimales
  const renderConv = useCallback(
    ({ item }: { item: StoredConversation }) => (
      <ConvItem
        conv={item}
        onPress={() => router.push(`/(messages)/${encodeURIComponent(item.id)}` as never)}
        onLongPress={() => handleLongPressConv(item)}
      />
    ),
    [router, handleLongPressConv] // ✅ Dépendances stables
  );

  const handleDM = async (nodeId: string, name: string, pubkey?: string) => {
    await startConversation(nodeId, name, pubkey);
    router.push(`/(messages)/${encodeURIComponent(nodeId)}` as never);
  };

  const handleDMContact = useCallback(async (contact: DBContact) => {
    await startConversation(contact.nodeId, contact.displayName);
    router.push(`/(messages)/${encodeURIComponent(contact.nodeId)}` as never);
  }, [startConversation, router]);

  const handleForum = async (channelName: string, pskHex?: string, skipAnnounce?: boolean): Promise<void> => {
    await joinForum(channelName, undefined, pskHex, skipAnnounce);
    router.push(`/(messages)/${encodeURIComponent('forum:' + channelName)}` as never);
  };

  return (
    <View style={styles.container}>
      <View style={styles.statusBar}>
        <View style={styles.statusLeft}>
          <ModeIcon size={14} color={modeColor} />
          <Text style={[styles.statusText, { color: modeColor }]}>{modeLabel}</Text>
          <View style={styles.statusDivider} />
          <Text style={styles.statusNodes}>
            {identity ? identity.nodeId : 'No wallet'}
          </Text>
        </View>
        <View style={styles.statusRight}>
          <Text style={[
            styles.statusFreq,
            { color: nostrConnected ? Colors.purple ?? '#9b59b6' : nostrConnecting ? Colors.yellow : Colors.textMuted }
          ]}>
            {nostrConnected ? 'Nostr ●' : nostrConnecting ? 'Nostr...' : 'Nostr ○'}
          </Text>
        </View>
      </View>

      <View style={styles.contactsStrip}>
        <View style={styles.contactsHeader}>
          <Text style={styles.contactsTitle}>Contacts</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.contactsScroll}>
          {contacts.length === 0 ? (
            <View style={styles.contactsEmpty}>
              <Text style={styles.contactsEmptyText}>Aucun contact — ajoutez via l'onglet Réseau</Text>
            </View>
          ) : (
            contacts.map((c) => (
              <TouchableOpacity key={c.nodeId} style={styles.contactChip} onPress={() => handleDMContact(c)} activeOpacity={0.7}>
                <View style={[styles.contactAvatar, c.isFavorite && styles.contactAvatarFav]}>
                  <Text style={styles.contactAvatarText}>{c.displayName.charAt(0).toUpperCase()}</Text>
                </View>
                <Text style={styles.contactName} numberOfLines={1}>{c.displayName}</Text>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </View>

      {/* ✅ OPTIMISATION: FlatList optimisée avec getItemLayout et removeClippedSubviews */}
      <FlatList
        data={uniqueConversations}
        keyExtractor={(item) => item.id}
        renderItem={renderConv}
        contentContainerStyle={[styles.listContent, uniqueConversations.length === 0 && styles.emptyList]}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={SeparatorComponent}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        getItemLayout={(data, index) => ({
          length: 78, // Hauteur estimée d'un item (padding 14*2 + avatar 50)
          offset: 78 * index,
          index,
        })}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Radio size={48} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>Aucune conversation</Text>
            <Text style={styles.emptySubtitle}>
              {identity
                ? `Votre NodeID: ${identity.nodeId}\nPartagez-le pour recevoir des messages.`
                : 'Créez un wallet pour commencer à communiquer.'}
            </Text>
          </View>
        }
      />

      <TouchableOpacity style={styles.fab} activeOpacity={0.8} onPress={() => setModalVisible(true)}>
        <Plus size={24} color={Colors.black} />
      </TouchableOpacity>

      <NewChatModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onDM={handleDM}
        onForum={handleForum}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  statusBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: Colors.surface, borderBottomWidth: 0.5, borderBottomColor: Colors.border,
  },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 12, fontWeight: '600' },
  statusDivider: { width: 1, height: 12, backgroundColor: Colors.border, marginHorizontal: 4 },
  statusNodes: { color: Colors.textSecondary, fontSize: 11, fontFamily: 'monospace' },
  statusFreq: { color: Colors.textMuted, fontSize: 11, fontFamily: 'monospace' },
  statusRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  listContent: { paddingTop: 4, paddingBottom: 100 },
  emptyList: { flex: 1 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', paddingHorizontal: 32, lineHeight: 20 },
  chatItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  avatarContainer: { position: 'relative', marginRight: 14 },
  avatar: {
    width: 50, height: 50, borderRadius: 25,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.5, borderColor: Colors.border,
  },
  avatarOnline: { borderColor: Colors.green },
  avatarText: { color: Colors.text, fontSize: 18, fontWeight: '700' },
  onlineDot: {
    position: 'absolute', bottom: 1, right: 1,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: Colors.green, borderWidth: 2, borderColor: Colors.background,
  },
  chatContent: { flex: 1 },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  chatNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  chatName: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  meshBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.accentGlow, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4,
  },
  forumBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.cyanDim, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4,
  },
  meshBadgeText: { color: Colors.accent, fontSize: 9, fontWeight: '700' },
  chatTime: { color: Colors.textMuted, fontSize: 12 },
  chatFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatLastMessage: { color: Colors.textSecondary, fontSize: 14, flex: 1, marginRight: 8 },
  chatMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  signalDots: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  signalDot: { width: 3, borderRadius: 1.5 },
  unreadBadge: {
    backgroundColor: Colors.accent, minWidth: 20, height: 20,
    borderRadius: 10, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6,
  },
  unreadText: { color: Colors.black, fontSize: 11, fontWeight: '700' },
  separator: { height: 0.5, backgroundColor: Colors.border, marginLeft: 80 },
  // Contacts strip
  contactsStrip: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.border,
    paddingBottom: 10,
    paddingTop: 8,
  },
  contactsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  contactsTitle: {
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  contactsEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  contactsEmptyText: {
    color: Colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
  },
  contactsScroll: {
    paddingHorizontal: 12,
    gap: 12,
  },
  contactChip: {
    alignItems: 'center',
    gap: 4,
    width: 56,
  },
  contactAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  contactAvatarFav: {
    borderColor: Colors.accent,
  },
  contactAvatarText: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  contactName: {
    color: Colors.textSecondary,
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
    width: 56,
  },
  fab: {
    position: 'absolute', bottom: 24, right: 20,
    width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.accent,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.accent, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 8,
  },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, borderBottomWidth: 0.5, borderBottomColor: Colors.border,
  },
  modalTitle: { color: Colors.text, fontSize: 17, fontWeight: '700' },
  tabRow: { flexDirection: 'row', marginHorizontal: 20, marginTop: 16, gap: 8 },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: 10, backgroundColor: Colors.surfaceLight,
  },
  tabActive: { backgroundColor: Colors.surfaceHighlight },
  tabText: { color: Colors.textMuted, fontSize: 13, fontWeight: '600' },
  modalBody: { paddingHorizontal: 20, paddingTop: 16, gap: 8 },
  inputLabel: { color: Colors.textSecondary, fontSize: 12, fontWeight: '600', marginTop: 4 },
  modalInput: {
    backgroundColor: Colors.surfaceLight, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: Colors.text, fontSize: 15, borderWidth: 0.5, borderColor: Colors.border, fontFamily: 'monospace',
  },
  inputHint: { color: Colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  modalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14, marginTop: 8,
  },
  modalBtnText: { color: Colors.black, fontSize: 15, fontWeight: '700' },
  // Forum discovery
  discoverHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 16,
  },
  discoverEmpty: {
    paddingVertical: 32, alignItems: 'center', gap: 4,
  },
  discoverList: {
    maxHeight: 220, marginTop: 8,
  },
  createForumBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8,
    backgroundColor: Colors.surfaceLight, borderWidth: 1, borderColor: Colors.border,
  },
  discoveredForumItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: Colors.surfaceLight, borderRadius: 10,
    padding: 12, marginTop: 8, borderWidth: 0.5, borderColor: Colors.border,
  },
  forumIconSmall: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center',
  },
  discoveredForumName: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  discoveredForumDesc: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  discoveredForumMeta: { color: Colors.textMuted, fontSize: 10, marginTop: 2 },
  // Forum type toggle
  forumTypeRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  forumTypeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 10,
    backgroundColor: Colors.surfaceLight, borderWidth: 1, borderColor: Colors.border,
  },
  forumTypeBtnActive: { borderColor: Colors.cyan, backgroundColor: Colors.cyanDim },
  forumTypeBtnPrivate: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  forumTypeTxt: { color: Colors.textMuted, fontSize: 13, fontWeight: '600' },
  // Private sub-tabs
  privateSubRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  privateSubBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8,
    backgroundColor: Colors.surfaceLight, borderWidth: 1, borderColor: Colors.border,
  },
  privateSubBtnActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  privateSubTxt: { color: Colors.textMuted, fontSize: 13, fontWeight: '600' },
  // PSK display
  pskGenBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 14,
    backgroundColor: Colors.accentDim, borderRadius: 10, borderWidth: 1, borderColor: Colors.accent,
    marginTop: 4,
  },
  pskGenTxt: { color: Colors.accent, fontSize: 14, fontWeight: '700' },
  pskBox: {
    backgroundColor: Colors.surfaceLight, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: Colors.accent, marginTop: 4, gap: 8,
  },
  pskHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pskLabel: { color: Colors.accent, fontSize: 11, fontWeight: '600', flex: 1 },
  pskRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pskValue: { color: Colors.text, fontSize: 11, fontFamily: 'monospace', flex: 1 },
  pskEye: { padding: 6 },
  pskCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pskCopyTxt: { color: Colors.textMuted, fontSize: 12, fontWeight: '600' },
  pskWarning: { color: Colors.yellow, fontSize: 11, lineHeight: 15 },
  pskInputRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
