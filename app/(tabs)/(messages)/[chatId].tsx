import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, KeyboardAvoidingView, Platform,
  ActivityIndicator, Modal, Alert, Image, Animated,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import * as Clipboard from 'expo-clipboard';
import { Send, CircleDollarSign, Lock, Hash, Radio, Globe, Wifi, X, AlertTriangle, Bitcoin, Mic, Play, Square, Camera, CornerUpLeft, Copy, Trash2, RotateCcw, Shield, User, ChevronDown, Zap } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import Colors from '@/constants/colors';
import { formatMessageTime } from '@/utils/helpers';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import { useMessages } from '@/providers/MessagesProvider';
import { useNostr } from '@/providers/NostrProvider';
import { useBle } from '@/providers/BleProvider';
import { decodeCashuToken, getTokenAmount, verifyCashuToken, generateTokenId, reclaimProofs, fetchMintKeys, encodeCashuToken } from '@/utils/cashu';
import { markCashuTokenSpent, markCashuTokenPending, markCashuTokenUnspent, saveCashuToken, getCashuBalance } from '@/utils/database';
import type { StoredMessage } from '@/utils/messages-store';
import TipModal from '@/components/TipModal';
import {
  requestAudioPermissions,
  startRecording,
  stopRecording,
  audioUriToBase64,
  playAudioBase64,
  formatDuration,
  AUDIO_MAX_DURATION_MS,
  WAVEFORM_PROFILE,
  encodeVoiceMessage,
} from '@/utils/audio';
import type { Audio } from 'expo-av';

// ─── Quote parser ──────────────────────────────────────────────────────────
// Format reply : "↩ NOM: texte cité\n―――\nmessage réel"
const QUOTE_DIVIDER = '\n―――\n';
function parseQuote(text: string): { quote: { from: string; text: string } | null; body: string } {
  if (!text.startsWith('↩ ')) return { quote: null, body: text };
  const div = text.indexOf(QUOTE_DIVIDER);
  if (div === -1) return { quote: null, body: text };
  const line = text.slice(2, div);
  const colon = line.indexOf(': ');
  if (colon === -1) return { quote: null, body: text };
  return { quote: { from: line.slice(0, colon), text: line.slice(colon + 2) }, body: text.slice(div + QUOTE_DIVIDER.length) };
}

// ─── MessageActionsSheet ───────────────────────────────────────────────────
const QUICK_EMOJIS = ['❤️', '👍', '😂', '🔥', '⚡', '₿', '💜'];

function MessageActionsSheet({ message, visible, onClose, onReply, onReact, onDelete, onReclaim, activeReactions }: {
  message: StoredMessage | null;
  visible: boolean;
  onClose: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onDelete: () => void;
  onReclaim: () => void;
  activeReactions: string[];
}) {
  if (!message) return null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={actionStyles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={actionStyles.sheet}>
          <View style={actionStyles.handle} />

          {/* Emoji reactions rapides */}
          <View style={actionStyles.emojiRow}>
            {QUICK_EMOJIS.map(e => {
              const active = activeReactions.includes(e);
              return (
                <TouchableOpacity key={e} onPress={() => { onReact(e); onClose(); }} activeOpacity={0.7}>
                  <View style={[actionStyles.emojiBtn, active && actionStyles.emojiBtnActive]}>
                    <Text style={actionStyles.emoji}>{e}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={actionStyles.divider} />

          <TouchableOpacity style={actionStyles.action} onPress={() => { onReply(); onClose(); }} activeOpacity={0.7}>
            <CornerUpLeft size={18} color={Colors.text} />
            <Text style={actionStyles.actionText}>Répondre</Text>
          </TouchableOpacity>

          {!!message.text && (
            <TouchableOpacity style={actionStyles.action} onPress={() => { Clipboard.setStringAsync(message.text!); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); onClose(); }} activeOpacity={0.7}>
              <Copy size={18} color={Colors.text} />
              <Text style={actionStyles.actionText}>Copier</Text>
            </TouchableOpacity>
          )}

          {message.type === 'cashu' && message.isMine && (
            <TouchableOpacity style={actionStyles.action} onPress={() => { onReclaim(); onClose(); }} activeOpacity={0.7}>
              <RotateCcw size={18} color={Colors.yellow} />
              <Text style={[actionStyles.actionText, { color: Colors.yellow }]}>Récupérer les sats</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={actionStyles.action} onPress={() => { onDelete(); onClose(); }} activeOpacity={0.7}>
            <Trash2 size={18} color={Colors.red} />
            <Text style={[actionStyles.actionText, { color: Colors.red }]}>Supprimer</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── ProfileSheet ──────────────────────────────────────────────────────────
function ProfileSheet({ nodeId, pubkey, name, onClose }: { nodeId: string; pubkey?: string; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((val: string, label: string) => {
    Clipboard.setStringAsync(val);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const isMesh = nodeId.startsWith('MESH-');
  const isNostr = nodeId.startsWith('NOSTR-');

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={profileStyles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={profileStyles.sheet}>
          <View style={profileStyles.handle} />
          <View style={profileStyles.avatarWrap}>
            <Text style={profileStyles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={profileStyles.name}>{name}</Text>
          <View style={profileStyles.badgeRow}>
            {isMesh && <View style={[profileStyles.badge, { backgroundColor: Colors.cyanDim }]}><Text style={[profileStyles.badgeText, { color: Colors.cyan }]}>📡 MeshCore</Text></View>}
            {isNostr && <View style={[profileStyles.badge, { backgroundColor: 'rgba(160,32,240,0.15)' }]}><Text style={[profileStyles.badgeText, { color: '#a020f0' }]}>⚡ Nostr</Text></View>}
            <View style={[profileStyles.badge, { backgroundColor: Colors.accentDim }]}><Shield size={10} color={Colors.accent} /><Text style={[profileStyles.badgeText, { color: Colors.accent }]}> Vérifié E2E</Text></View>
          </View>

          <View style={profileStyles.fields}>
            <TouchableOpacity style={profileStyles.field} onPress={() => copy(nodeId, 'NodeID')} activeOpacity={0.7}>
              <Text style={profileStyles.fieldLabel}>NodeID</Text>
              <View style={profileStyles.fieldRow}>
                <Text style={profileStyles.fieldValue}>{nodeId}</Text>
                <Copy size={13} color={copied === 'NodeID' ? Colors.accent : Colors.textMuted} />
              </View>
              {copied === 'NodeID' && <Text style={profileStyles.copiedHint}>Copié !</Text>}
            </TouchableOpacity>

            {pubkey && (
              <TouchableOpacity style={profileStyles.field} onPress={() => copy(pubkey, 'Pubkey')} activeOpacity={0.7}>
                <Text style={profileStyles.fieldLabel}>Clé publique</Text>
                <View style={profileStyles.fieldRow}>
                  <Text style={profileStyles.fieldValue} numberOfLines={1}>{pubkey.slice(0, 20)}…{pubkey.slice(-8)}</Text>
                  <Copy size={13} color={copied === 'Pubkey' ? Colors.accent : Colors.textMuted} />
                </View>
                {copied === 'Pubkey' && <Text style={profileStyles.copiedHint}>Copié !</Text>}
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function PaymentBubble({ amount }: { amount: number }) {
  return (
    <View style={styles.paymentBubble}>
      <Bitcoin size={16} color={Colors.accent} />
      <Text style={styles.paymentAmount}>{amount.toLocaleString()} sats</Text>
    </View>
  );
}

function CashuBubble({ amount, received }: { amount: number; received?: boolean }) {
  return (
    <View style={styles.cashuBubble}>
      <View style={styles.cashuHeader}>
        <CircleDollarSign size={14} color={Colors.cyan} />
        <Text style={styles.cashuLabel}>Cashu Token</Text>
        {received && (
          <View style={styles.cashuReceivedBadge}>
            <Text style={styles.cashuReceivedText}>✓ Reçu</Text>
          </View>
        )}
      </View>
      <Text style={styles.cashuAmount}>{amount.toLocaleString()} sats</Text>
      {received && <Text style={styles.cashuHint}>Appuyer pour copier</Text>}
    </View>
  );
}

// Périodes d'animation par barre — différentes pour un effet organique non-robotique
const BAR_PERIODS = [185, 215, 162, 235, 178, 202, 190, 245, 168, 198, 218, 174, 208, 192, 182, 225];

function AudioBubble({ audioData, audioDuration, isMe }: { audioData?: string; audioDuration?: number; isMe: boolean }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0.0 → 1.0
  const soundRef = useRef<Audio.Sound | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Un Animated.Value par barre, initialisé au profil statique
  const barAnims = useRef(
    WAVEFORM_PROFILE.map(h => new Animated.Value(h))
  ).current;

  // Démarrer / arrêter les animations de barres selon l'état de lecture
  useEffect(() => {
    if (!isPlaying) {
      WAVEFORM_PROFILE.forEach((h, i) => barAnims[i].setValue(h));
      return;
    }
    // Chaque barre boucle indépendamment avec sa propre période
    const loops = barAnims.map((anim, i) => {
      const base = WAVEFORM_PROFILE[i];
      const period = BAR_PERIODS[i];
      return Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: Math.min(1.0, base + 0.42), duration: period, useNativeDriver: false }),
          Animated.timing(anim, { toValue: Math.max(0.12, base - 0.28), duration: Math.round(period * 0.75), useNativeDriver: false }),
        ])
      );
    });
    // Démarrage en escalier : cascade gauche → droite (30ms entre chaque barre)
    const timeouts = loops.map((loop, i) => {
      const t = setTimeout(() => loop.start(), i * 30);
      return { loop, t };
    });
    return () => {
      for (const { loop, t } of timeouts) { clearTimeout(t); loop.stop(); }
      WAVEFORM_PROFILE.forEach((h, i) => barAnims[i].setValue(h));
    };
  }, [isPlaying]);

  const handlePlay = useCallback(async () => {
    if (!audioData) return;
    if (isPlaying) {
      await soundRef.current?.stopAsync();
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      setIsPlaying(false);
      setProgress(0);
      soundRef.current = null;
      return;
    }
    setIsPlaying(true);
    setProgress(0);
    try {
      const sound = await playAudioBase64(audioData, () => {
        if (progressTimerRef.current) clearInterval(progressTimerRef.current);
        setIsPlaying(false);
        setProgress(0);
        soundRef.current = null;
      });
      soundRef.current = sound;
      // Suivi de la position toutes les 100ms pour colorier les barres "jouées"
      progressTimerRef.current = setInterval(async () => {
        if (!soundRef.current || !audioDuration) return;
        try {
          const st = await soundRef.current.getStatusAsync();
          if (st.isLoaded) setProgress(Math.min(1, (st.positionMillis ?? 0) / audioDuration));
        } catch {}
      }, 100);
    } catch {
      setIsPlaying(false);
    }
  }, [audioData, isPlaying, audioDuration]);

  useEffect(() => () => {
    soundRef.current?.unloadAsync().catch(() => {});
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
  }, []);

  const duration = audioDuration ?? 0;
  const playedBars = Math.floor(progress * WAVEFORM_PROFILE.length);

  return (
    <View style={styles.audioBubble}>
      {/* Bouton Play / Stop */}
      <TouchableOpacity
        onPress={() => void handlePlay()}
        style={[styles.audioPlayBtn, isMe && styles.audioPlayBtnMe]}
        activeOpacity={0.7}
      >
        {isPlaying
          ? <Square size={13} color={isMe ? Colors.black : Colors.accent} />
          : <Play  size={13} color={isMe ? Colors.black : Colors.accent} fill={isMe ? Colors.black : Colors.accent} />}
      </TouchableOpacity>

      {/* Waveform animée : chaque barre pulse indépendamment + progress */}
      <View style={styles.audioWaveform}>
        {barAnims.map((anim, i) => {
          const played = isPlaying && i < playedBars;
          return (
            <Animated.View
              key={i}
              style={[
                styles.audioBar,
                {
                  height: anim.interpolate({ inputRange: [0, 1], outputRange: [3, 26] }),
                  backgroundColor: isMe
                    ? played ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.22)'
                    : played ? Colors.accent : Colors.accentDim,
                  opacity: played ? 1 : 0.6,
                },
              ]}
            />
          );
        })}
      </View>

      {/* Durée : affiche la position courante pendant la lecture */}
      <Text style={[styles.audioDuration, isMe && styles.audioDurationMe]}>
        {isPlaying && duration > 0 ? formatDuration(progress * duration) : formatDuration(duration)}
      </Text>
    </View>
  );
}

function ImageBubble({ imageData, imageMime, isMe }: { imageData?: string; imageMime?: string; isMe: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!imageData) return null;

  const uri = `data:${imageMime ?? 'image/jpeg'};base64,${imageData}`;

  return (
    <>
      <TouchableOpacity onPress={() => setExpanded(true)} activeOpacity={0.85}>
        <Image
          source={{ uri }}
          style={[styles.imageBubble, isMe ? styles.imageBubbleMe : styles.imageBubbleThem]}
          resizeMode="cover"
        />
        {imageMime === 'image/gif' && (
          <View style={styles.gifBadge}>
            <Text style={styles.gifBadgeText}>GIF</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Visionneuse plein écran */}
      <Modal visible={expanded} transparent animationType="fade" onRequestClose={() => setExpanded(false)}>
        <TouchableOpacity style={styles.imageViewer} activeOpacity={1} onPress={() => setExpanded(false)}>
          <Image source={{ uri }} style={styles.imageViewerFull} resizeMode="contain" />
          <View style={styles.imageViewerClose}>
            <X size={22} color={Colors.white} />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const MessageBubble = React.memo(function MessageBubble({ message, displayName, onLongPress, onCashuPress, onSenderTap, reactions, onReactionPress }: {
  message: StoredMessage;
  displayName?: string;
  onLongPress?: () => void;
  onCashuPress?: () => void;
  onSenderTap?: () => void;
  reactions?: string[];
  onReactionPress?: (emoji: string) => void;
}) {
  const isMe = message.isMine;
  const senderName = displayName ?? message.fromNodeId;
  const { quote, body } = message.text ? parseQuote(message.text) : { quote: null, body: message.text };

  return (
    <View style={[styles.messageBubbleOuter, isMe ? styles.outerRight : styles.outerLeft]}>
      <TouchableOpacity
        style={[styles.messageBubbleContainer, isMe ? styles.bubbleRight : styles.bubbleLeft]}
        onLongPress={onLongPress}
        onPress={message.type === 'cashu' && !isMe ? onCashuPress : undefined}
        delayLongPress={400}
        activeOpacity={message.type === 'cashu' && !isMe ? 0.75 : 1}
      >
        {!isMe && (
          <TouchableOpacity onPress={onSenderTap} activeOpacity={0.6}>
            <Text style={styles.senderLabel}>{senderName}</Text>
          </TouchableOpacity>
        )}
        <View style={[
          styles.messageBubble,
          isMe ? styles.myBubble : styles.theirBubble,
          message.type === 'btc_tx' && styles.paymentWrapper,
          message.type === 'cashu' && styles.cashuWrapper,
          (message.type === 'image' || message.type === 'gif') && styles.imageWrapper,
        ]}>
          {/* Quote block si réponse */}
          {quote && (
            <View style={[styles.quoteBlock, isMe && styles.quoteBlockMe]}>
              <View style={styles.quoteLine} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.quoteFrom, isMe && styles.quoteFromMe]}>{quote.from}</Text>
                <Text style={[styles.quoteText, isMe && styles.quoteTextMe]} numberOfLines={2}>{quote.text}</Text>
              </View>
            </View>
          )}

          {message.type === 'audio' ? (
            <AudioBubble audioData={message.audioData} audioDuration={message.audioDuration} isMe={isMe} />
          ) : (message.type === 'image' || message.type === 'gif') ? (
            <ImageBubble imageData={message.imageData} imageMime={message.imageMime} isMe={isMe} />
          ) : message.type === 'cashu' && message.cashuAmount ? (
            <CashuBubble amount={message.cashuAmount} received={!isMe} />
          ) : message.type === 'btc_tx' && message.btcAmount ? (
            <PaymentBubble amount={message.btcAmount} />
          ) : (
            <Text style={[styles.messageText, isMe && styles.myMessageText]}>
              {body ?? message.text}
            </Text>
          )}
          <View style={styles.messageFooter}>
            <Text style={[styles.messageTime, isMe && styles.myMessageTime]}>
              {formatMessageTime(message.timestamp)}
            </Text>
            {message.transport && (
              <View style={[
                styles.transportBadge,
                message.transport === 'nostr' ? styles.transportNostr
                : message.transport === 'ble' ? styles.transportBle
                : styles.transportLora,
              ]}>
                <Text style={styles.transportBadgeText}>
                  {message.transport === 'nostr' ? '⚡' : message.transport === 'ble' ? '🔵' : '📡'}
                </Text>
              </View>
            )}
            {isMe && (
              <Text style={[styles.messageStatus, message.status === 'delivered' && styles.statusDelivered, message.status === 'failed' && styles.statusFailed]}>
                {message.status === 'delivered' ? '✓✓' : message.status === 'sent' ? '✓' : message.status === 'sending' ? '◎' : '✗'}
              </Text>
            )}
          </View>
        </View>
      </TouchableOpacity>

      {/* Réactions emoji sous la bulle */}
      {reactions && reactions.length > 0 && (
        <View style={[styles.reactionsRow, isMe && styles.reactionsRowMe]}>
          {reactions.map((emoji, i) => (
            <TouchableOpacity key={i} onPress={() => onReactionPress?.(emoji)} activeOpacity={0.7} style={styles.reactionChip}>
              <Text style={styles.reactionEmoji}>{emoji}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
// Comparateur custom : re-render seulement si les données changent, pas les callbacks
}, (prev, next) =>
  prev.message === next.message &&
  prev.displayName === next.displayName &&
  prev.reactions === next.reactions
);

// Modal d'envoi d'un token Cashu
function CashuSendModal({
  visible,
  onClose,
  onSend,
}: {
  visible: boolean;
  onClose: () => void;
  onSend: (token: string, amount: number) => Promise<void>;
}) {
  const [tokenInput, setTokenInput] = useState('');
  const [preview, setPreview] = useState<{ amount: number; mint: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const handleParse = useCallback(async (text: string) => {
    setTokenInput(text);
    setError(null);
    setPreview(null);
    const trimmed = text.trim();
    if (!trimmed) return;
    
    // ✅ NOUVEAU : Vérification complète du token
    const verification = await verifyCashuToken(trimmed);
    if (!verification.valid) {
      setError(verification.error || 'Token Cashu invalide');
      return;
    }
    
    setPreview({ amount: verification.amount || 0, mint: verification.mintUrl || 'mint inconnu' });
  }, []);

  const handleSend = useCallback(async () => {
    if (!preview || isSending) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsSending(true);
    
    let tokenId: string | null = null;
    
    try {
      // ✅ NOUVEAU : Marquer comme pending avant envoi
      const decoded = decodeCashuToken(tokenInput.trim());
      if (decoded) {
        tokenId = generateTokenId(decoded);
        await markCashuTokenPending(tokenId);
        console.log('[Cashu] Token marqué pending:', tokenId);
      }
      
      await onSend(tokenInput.trim(), preview.amount);
      
      // ✅ Envoi réussi → marquer spent
      if (tokenId) {
        await markCashuTokenSpent(tokenId);
        console.log('[Cashu] Token marqué spent:', tokenId);
      }
      
      setTokenInput('');
      setPreview(null);
      onClose();
    } catch (err) {
      // ✅ Échec → rollback à unspent
      if (tokenId) {
        await markCashuTokenUnspent(tokenId);
        console.log('[Cashu] Token remis à unspent (échec envoi):', tokenId);
      }
      setError(err instanceof Error ? err.message : 'Erreur envoi');
    } finally {
      setIsSending(false);
    }
  }, [preview, isSending, tokenInput, onSend, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={cashuStyles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={cashuStyles.sheet}>
          <View style={cashuStyles.handle} />
          <View style={cashuStyles.header}>
            <CircleDollarSign size={20} color={Colors.cyan} />
            <Text style={cashuStyles.title}>Envoyer Cashu</Text>
            <TouchableOpacity onPress={onClose} style={cashuStyles.closeBtn}>
              <X size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={cashuStyles.label}>Token Cashu (cashuA…)</Text>
          <TextInput
            style={[cashuStyles.input, error ? cashuStyles.inputError : null]}
            value={tokenInput}
            onChangeText={handleParse}
            placeholder="cashuAeyJ0b2tlbiI6..."
            placeholderTextColor={Colors.textMuted}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />

          {error && (
            <View style={cashuStyles.errorRow}>
              <AlertTriangle size={12} color={Colors.red} />
              <Text style={cashuStyles.errorText}>{error}</Text>
            </View>
          )}

          {preview && (
            <View style={cashuStyles.preview}>
              <View style={cashuStyles.previewRow}>
                <Text style={cashuStyles.previewLabel}>Montant</Text>
                <Text style={cashuStyles.previewAmount}>{preview.amount.toLocaleString()} sats</Text>
              </View>
              <View style={cashuStyles.previewRow}>
                <Text style={cashuStyles.previewLabel}>Mint</Text>
                <Text style={cashuStyles.previewMint} numberOfLines={1}>{preview.mint}</Text>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[cashuStyles.sendBtn, !preview && cashuStyles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!preview || isSending}
            activeOpacity={0.8}
          >
            {isSending
              ? <ActivityIndicator size="small" color={Colors.black} />
              : <Text style={cashuStyles.sendBtnText}>
                  Envoyer {preview ? `${preview.amount.toLocaleString()} sats` : ''}
                </Text>
            }
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const convId = decodeURIComponent(chatId ?? '');
  const { settings, isLoRaMode } = useAppSettings();
  const { conversations, messagesByConv, sendMessage, sendAudio, sendImage, sendCashu, loadConversationMessages, markRead, deleteMessage, contacts, startConversation } = useMessages();
  const { isConnected: nostrConnected } = useNostr();
  const ble = useBle();

  const conv = conversations.find(c => c.id === convId);
  const messages = messagesByConv[convId] ?? [];

  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCashuModal, setShowCashuModal] = useState(false);
  const [showTipModal, setShowTipModal] = useState(false);
  const [isSendingMedia, setIsSendingMedia] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  // Reply
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  // Réactions emoji : messageId → emojis
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  // Actions sheet (long press)
  const [actionsSheet, setActionsSheet] = useState<StoredMessage | null>(null);
  // Profile sheet (tap sender)
  const [profileSheet, setProfileSheet] = useState<{ nodeId: string; pubkey?: string; name: string } | null>(null);
  const headerHeight = useHeaderHeight();
  const flatListRef = useRef<FlatList>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Animations ripple pour l'overlay d'enregistrement
  const ripple1 = useRef(new Animated.Value(0)).current;
  const ripple2 = useRef(new Animated.Value(0)).current;
  const ripple3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isRecording) {
      ripple1.setValue(0); ripple2.setValue(0); ripple3.setValue(0);
      return;
    }
    const pulse = (anim: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 350, useNativeDriver: true }),
      ]));
    const a1 = pulse(ripple1, 0);
    const a2 = pulse(ripple2, 280);
    const a3 = pulse(ripple3, 560);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [isRecording]);

  const isForum = convId.startsWith('forum:');

  // Map nodeId → displayName depuis les contacts
  const contactNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of contacts) {
      map[c.nodeId] = c.displayName;
    }
    return map;
  }, [contacts]);

  // Charger les messages au montage
  useEffect(() => {
    loadConversationMessages(convId);
    markRead(convId);
    // FIX #3: Résolution proactive pubkey si DM sans pubkey connue
    if (!convId.startsWith('forum:')) {
      startConversation(convId).catch(() => {});
    }
  }, [convId]);

  // Scroll vers le bas à chaque nouveau message
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isSending) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputText('');
    setIsSending(true);
    setError(null);
    try {
      // Préfixer avec la quote si réponse
      let finalText = text;
      if (replyTo) {
        const quotedFrom = replyTo.isMine ? 'Vous' : (contactNameMap[replyTo.fromNodeId] ?? replyTo.fromNodeId.slice(0, 12));
        const quotedText = replyTo.text ?? (replyTo.type === 'cashu' ? `💰 ${replyTo.cashuAmount} sats` : replyTo.type ?? '');
        finalText = `↩ ${quotedFrom}: ${quotedText}${QUOTE_DIVIDER}${text}`;
        setReplyTo(null);
      }
      await sendMessage(convId, finalText, 'text');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur envoi');
    } finally {
      setIsSending(false);
    }
  }, [inputText, isSending, convId, sendMessage, replyTo, contactNameMap]);

  const router = useRouter();

  const handleCashuTap = useCallback((item: StoredMessage) => {
    if (!item.cashuToken) return;
    Clipboard.setStringAsync(item.cashuToken);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert(
      '✓ Token copié !',
      item.cashuAmount + ' sats\nCe token est déjà importé dans votre wallet.',
      [
        { text: 'OK', style: 'cancel' },
        { text: 'Aller au wallet', onPress: () => router.push('/(tabs)/wallet') },
      ]
    );
  }, [router]);

  const handleReclaimToken = useCallback(async (item: StoredMessage) => {
    if (!item.cashuToken) return;
    const decoded = decodeCashuToken(item.cashuToken);
    if (!decoded) return Alert.alert('Erreur', 'Token invalide');

    const entry = decoded.token[0];
    if (!entry) return Alert.alert('Erreur', 'Token vide');
    const { mint: mintUrl, proofs } = entry;
    const keysetId = proofs[0]?.id;
    if (!keysetId) return Alert.alert('Erreur', 'Keyset introuvable');

    Alert.alert(
      '↩ Récupérer les sats ?',
      `Vérification que le destinataire n'a pas encore encaissé ce token de ${item.cashuAmount ?? 0} sats...`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Récupérer',
          onPress: async () => {
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              const keysets = await fetchMintKeys(mintUrl);
              const keyset = keysets.find(k => k.id === keysetId && k.active) ?? keysets[0];
              if (!keyset) throw new Error('Keyset introuvable sur le mint');

              const newProofs = await reclaimProofs(mintUrl, proofs, keyset.id, keyset.keys);
              const newToken = { token: [{ mint: mintUrl, proofs: newProofs }] };
              const encoded = encodeCashuToken(newToken);
              const amount = newProofs.reduce((s, p) => s + p.amount, 0);
              await saveCashuToken({
                id: generateTokenId(newToken),
                mintUrl,
                amount,
                token: encoded,
                proofs: JSON.stringify(newProofs),
                keysetId: keyset.id,
                state: 'unspent',
                source: 'reclaim',
                memo: `Récupéré · ${amount} sats`,
                unverified: false,
                retryCount: 0,
              });
              deleteMessage(item.id, convId);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('✓ Récupéré !', `${amount} sats récupérés dans votre wallet.`);
            } catch (err) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              const msg = err instanceof Error ? err.message : 'Erreur inconnue';
              if (msg.includes('already spent')) {
                Alert.alert('Impossible', 'Le destinataire a déjà encaissé ce token.');
              } else {
                Alert.alert('Erreur', msg);
              }
            }
          },
        },
      ]
    );
  }, [convId, deleteMessage]);

  const handleLongPressMessage = useCallback((item: StoredMessage) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionsSheet(item);
  }, []);

  const handleToggleReaction = useCallback((msgId: string, emoji: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setReactions(prev => {
      const curr = prev[msgId] ?? [];
      const has = curr.includes(emoji);
      return { ...prev, [msgId]: has ? curr.filter(e => e !== emoji) : [...curr, emoji] };
    });
  }, []);

  const handleSenderTap = useCallback((item: StoredMessage) => {
    const name = contactNameMap[item.fromNodeId] ?? item.fromNodeId;
    const contact = contacts.find(c => c.nodeId === item.fromNodeId);
    setProfileSheet({ nodeId: item.fromNodeId, pubkey: contact?.pubkeyHex, name });
  }, [contactNameMap, contacts]);

  const handlePickMedia = useCallback(async () => {
    if (isRecording || isSendingMedia) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission requise', "L'accès à la galerie est nécessaire pour envoyer des images.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.5,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert('Erreur', "Impossible de lire l'image.");
        return;
      }
      // Vérifier la taille (~300 KB max pour NIP-17 DM)
      if (asset.base64.length > 400000) {
        Alert.alert('Image trop volumineuse', 'Choisissez une image plus petite (max ~300 KB).');
        return;
      }
      const mime = asset.mimeType ?? 'image/jpeg';
      setIsSendingMedia(true);
      try {
        await sendImage(convId, asset.base64, mime);
      } finally {
        setIsSendingMedia(false);
      }
    } catch (err) {
      setIsSendingMedia(false);
      const msg = err instanceof Error ? err.message : 'Erreur';
      Alert.alert('Erreur', msg);
    }
  }, [isRecording, isSendingMedia, convId, sendImage]);

  const handleMicPressOut = useCallback(async (sendIt = true) => {
    if (!recordingRef.current) return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setRecordingDuration(0);
    try {
      const { uri, durationMs } = await stopRecording(rec);
      if (!sendIt || durationMs < 500) return; // Trop court, ignorer
      const base64 = await audioUriToBase64(uri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await sendAudio(convId, base64, durationMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur envoi audio';
      setError(msg);
    }
  }, [convId, sendAudio]);

  const handleMicPressIn = useCallback(async () => {
    const granted = await requestAudioPermissions();
    if (!granted) {
      Alert.alert('Permission requise', 'L\'accès au microphone est nécessaire pour envoyer des messages vocaux.');
      return;
    }
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const recording = await startRecording();
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(d => d + 1000);
      }, 1000);
      // Auto-stop à 30 secondes
      setTimeout(() => {
        if (recordingRef.current) handleMicPressOut(true);
      }, AUDIO_MAX_DURATION_MS);
    } catch {
      Alert.alert('Erreur', 'Impossible de démarrer l\'enregistrement.');
    }
  }, [handleMicPressOut]);

  // Ref pour que renderMessage accède aux reactions sans les avoir dans ses deps
  // (évite de recréer renderMessage — et donc re-rendre tous les items — à chaque reaction)
  const reactionsRef = useRef(reactions);
  useEffect(() => { reactionsRef.current = reactions; }, [reactions]);

  const renderMessage = useCallback(
    ({ item }: { item: StoredMessage }) => (
      <MessageBubble
        message={item}
        displayName={contactNameMap[item.fromNodeId]}
        onLongPress={() => handleLongPressMessage(item)}
        onCashuPress={() => handleCashuTap(item)}
        onSenderTap={item.isMine ? undefined : () => handleSenderTap(item)}
        reactions={reactionsRef.current[item.id]}
        onReactionPress={(emoji) => handleToggleReaction(item.id, emoji)}
      />
    ),
    [handleLongPressMessage, handleCashuTap, handleSenderTap, handleToggleReaction, contactNameMap]
  );

  // ListEmptyComponent extrait pour éviter une re-création à chaque render
  const emptyChatComponent = useMemo(() => (
    <View style={styles.emptyChat}>
      <Lock size={32} color={Colors.textMuted} />
      <Text style={styles.emptyChatText}>
        {!nostrConnected ? 'Connexion Nostr en cours...' : 'Aucun message. Dites bonjour !'}
      </Text>
    </View>
  ), [nostrConnected]);

  const convName = conv?.name ?? convId;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => !isForum ? (
            <TouchableOpacity
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setShowTipModal(true); }}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              activeOpacity={0.7}
            >
              <Zap size={20} color={Colors.yellow} />
            </TouchableOpacity>
          ) : null,
          headerTitle: () => {
            const transportLabel = ble.loraActive
              ? (nostrConnected ? 'LoRa+Nostr' : 'LoRa')
              : ble.connected ? 'BLE (pas de relay)'
              : nostrConnected ? 'Nostr' : 'Offline';
            const transportColor = ble.loraActive ? Colors.cyan
              : ble.connected ? Colors.yellow
              : nostrConnected ? Colors.green : Colors.textMuted;
            const TransportIcon = ble.loraActive || ble.connected ? Radio : Globe;

            return (
              <View style={styles.headerTitle}>
                <View style={styles.headerNameRow}>
                  {isForum ? <Hash size={14} color={Colors.cyan} /> : <Lock size={12} color={Colors.accent} />}
                  <Text style={styles.headerName}>{convName}</Text>
                </View>
                <View style={styles.headerMeta}>
                  <TransportIcon size={10} color={transportColor} />
                  <Text style={[styles.headerTransport, { color: transportColor }]}>{transportLabel}</Text>
                  <Text style={styles.headerNodeId}> • {convId.slice(0, 15)}</Text>
                </View>
              </View>
            );
          },
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
      >
        <View style={styles.meshInfo}>
          <Shield size={11} color={Colors.accent} />
          <Text style={styles.meshInfoText}>
            {isForum
              ? `Forum · AES-GCM-256 · PSK`
              : nostrConnected
                ? `NIP-44 · ChaCha20-Poly1305 · HKDF`
                : `Mesh E2E · ECDH secp256k1 · AES-GCM-256`}
          </Text>
          <Lock size={10} color={Colors.accent} />
        </View>

        {error && (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          style={{ flex: 1 }}
          contentContainerStyle={styles.messagesList}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          windowSize={8}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={true}
          extraData={reactions}
          ListEmptyComponent={emptyChatComponent}
        />

        {/* Indicateur d'enregistrement au-dessus de la barre — layout stable */}
        {isRecording && (
          <View style={styles.recordingOverlay}>
            {/* Dot avec ripples concentriques */}
            <View style={styles.recordingPulseWrap}>
              {[ripple1, ripple2, ripple3].map((anim, i) => (
                <Animated.View
                  key={i}
                  style={{
                    position: 'absolute',
                    width: 10 + i * 14,
                    height: 10 + i * 14,
                    borderRadius: 5 + i * 7,
                    borderWidth: 1.5,
                    borderColor: Colors.red,
                    opacity: anim,
                    transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.6] }) }],
                  }}
                />
              ))}
              <View style={styles.recordingDot} />
            </View>
            <Text style={styles.recordingText}>
              ● REC  {formatDuration(recordingDuration)}
            </Text>
            <TouchableOpacity onPress={() => void handleMicPressOut(false)} style={styles.recordingCancelBtn} activeOpacity={0.7}>
              <X size={14} color={Colors.red} />
              <Text style={styles.recordingCancelText}>Annuler</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Reply bar — apparaît au-dessus de l'input quand on répond */}
        {replyTo && (
          <View style={styles.replyBar}>
            <View style={styles.replyBarLine} />
            <View style={{ flex: 1 }}>
              <Text style={styles.replyBarFrom}>
                ↩ {replyTo.isMine ? 'Vous' : (contactNameMap[replyTo.fromNodeId] ?? replyTo.fromNodeId.slice(0, 12))}
              </Text>
              <Text style={styles.replyBarText} numberOfLines={1}>
                {replyTo.text ?? (replyTo.type === 'cashu' ? `💰 ${replyTo.cashuAmount} sats` : replyTo.type)}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTo(null)} style={{ padding: 6 }} activeOpacity={0.7}>
              <X size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.inputContainer}>
          {/* Bouton Média (photo/GIF) — toujours présent */}
          <TouchableOpacity
            style={styles.cashuSendButton}
            activeOpacity={0.7}
            onPress={handlePickMedia}
            disabled={isRecording || isSendingMedia}
          >
            {isSendingMedia
              ? <ActivityIndicator size="small" color={Colors.blue} />
              : <Camera size={20} color={isRecording ? Colors.textMuted : Colors.blue} />}
          </TouchableOpacity>

          {/* Bouton Cashu — toujours présent, pas de switch de layout */}
          <TouchableOpacity
            style={styles.cashuSendButton}
            activeOpacity={0.7}
            onPress={() => {
              if (isRecording) return;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setShowCashuModal(true);
            }}
          >
            <CircleDollarSign size={20} color={isRecording ? Colors.textMuted : Colors.cyan} />
          </TouchableOpacity>

          {/* TextInput — toujours présent */}
          <TextInput
            style={styles.textInput}
            value={inputText}
            onChangeText={setInputText}
            placeholder={isRecording ? '' : isForum ? 'Message au forum...' : 'Message chiffré E2E...'}
            placeholderTextColor={Colors.textMuted}
            multiline
            maxLength={500}
            editable={!isRecording}
            onSubmitEditing={handleSend}
          />

          {/* Bouton Send ou Mic — seul switch autorisé */}
          {inputText.trim() && !isRecording ? (
            <TouchableOpacity
              style={[styles.sendButton, !isSending && styles.sendButtonActive]}
              onPress={handleSend}
              disabled={isSending}
              activeOpacity={0.7}
            >
              {isSending
                ? <ActivityIndicator size="small" color={Colors.black} />
                : <Send size={18} color={Colors.black} />}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.sendButton, isRecording ? styles.micButtonRecording : styles.micButton]}
              onPress={isRecording ? () => void handleMicPressOut(true) : () => void handleMicPressIn()}
              activeOpacity={0.7}
            >
              <Mic size={18} color={isRecording ? Colors.white : Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      <CashuSendModal
        visible={showCashuModal}
        onClose={() => setShowCashuModal(false)}
        onSend={async (token, amount) => {
          await sendCashu(convId, token, amount);
        }}
      />

      <MessageActionsSheet
        message={actionsSheet}
        visible={!!actionsSheet}
        onClose={() => setActionsSheet(null)}
        onReply={() => { if (actionsSheet) setReplyTo(actionsSheet); }}
        onReact={(emoji) => { if (actionsSheet) handleToggleReaction(actionsSheet.id, emoji); }}
        onDelete={() => { if (actionsSheet) deleteMessage(actionsSheet.id, convId); }}
        onReclaim={() => { if (actionsSheet) handleReclaimToken(actionsSheet); }}
        activeReactions={actionsSheet ? (reactions[actionsSheet.id] ?? []) : []}
      />

      {profileSheet && (
        <ProfileSheet
          nodeId={profileSheet.nodeId}
          pubkey={profileSheet.pubkey}
          name={profileSheet.name}
          onClose={() => setProfileSheet(null)}
        />
      )}

      <TipModal
        visible={showTipModal}
        onClose={() => setShowTipModal(false)}
        convId={convId}
        convName={convName}
        sendCashu={sendCashu}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  headerTitle: { alignItems: 'center' },
  headerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerName: { color: Colors.text, fontSize: 16, fontWeight: '700' },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  headerDot: { width: 6, height: 6, borderRadius: 3 },
  headerTransport: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  headerNodeId: { color: Colors.textMuted, fontSize: 10, fontFamily: 'monospace' },
  meshInfo: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 7, backgroundColor: Colors.surface,
    borderBottomWidth: 0.5, borderBottomColor: Colors.border,
  },
  meshInfoText: { color: Colors.accent, fontSize: 11, fontFamily: 'monospace', opacity: 0.7 },
  // Reply bar
  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: Colors.surfaceLight,
    paddingHorizontal: 14, paddingVertical: 10,
    borderTopWidth: 0.5, borderTopColor: Colors.border,
  },
  replyBarLine: { width: 3, height: '100%', minHeight: 32, borderRadius: 2, backgroundColor: Colors.accent },
  replyBarFrom: { color: Colors.accent, fontSize: 11, fontWeight: '700', marginBottom: 2 },
  replyBarText: { color: Colors.textMuted, fontSize: 13 },
  // Message outer wrapper (bubble + reactions)
  messageBubbleOuter: { marginBottom: 8 },
  outerRight: { alignItems: 'flex-end' },
  outerLeft: { alignItems: 'flex-start' },
  // Quote block inside bubble
  quoteBlock: {
    flexDirection: 'row', gap: 8, marginBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 8, padding: 8,
  },
  quoteBlockMe: { backgroundColor: 'rgba(0,0,0,0.18)' },
  quoteLine: { width: 3, borderRadius: 2, backgroundColor: Colors.textMuted },
  quoteFrom: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', marginBottom: 2 },
  quoteFromMe: { color: 'rgba(0,0,0,0.5)' },
  quoteText: { color: Colors.textMuted, fontSize: 12 },
  quoteTextMe: { color: 'rgba(0,0,0,0.5)' },
  // Reactions
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, marginLeft: 4 },
  reactionsRowMe: { justifyContent: 'flex-end', marginRight: 4 },
  reactionChip: {
    backgroundColor: Colors.surfaceLight, borderRadius: 12,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: Colors.border,
  },
  reactionEmoji: { fontSize: 16 },
  errorBar: { backgroundColor: Colors.redDim, paddingHorizontal: 16, paddingVertical: 8 },
  errorText: { color: Colors.red, fontSize: 12 },
  messagesList: { paddingHorizontal: 12, paddingVertical: 12, paddingBottom: 8 },
  emptyChat: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyChatText: { color: Colors.textMuted, fontSize: 14, textAlign: 'center' },
  messageBubbleContainer: { marginBottom: 6, maxWidth: '85%' },
  bubbleRight: { alignSelf: 'flex-end' },
  bubbleLeft: { alignSelf: 'flex-start' },
  senderLabel: { color: Colors.textMuted, fontSize: 10, fontFamily: 'monospace', marginBottom: 2, marginLeft: 4 },
  messageBubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  myBubble: { backgroundColor: Colors.accent, borderBottomRightRadius: 4 },
  theirBubble: { backgroundColor: Colors.surfaceLight, borderBottomLeftRadius: 4 },
  paymentWrapper: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.accentDim },
  cashuWrapper: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: 'rgba(34,211,238,0.25)' },
  paymentBubble: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  paymentAmount: { color: Colors.accent, fontSize: 16, fontWeight: '700' },
  cashuBubble: { gap: 4 },
  cashuHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
  cashuReceivedBadge: { marginLeft: 8, backgroundColor: 'rgba(34,211,238,0.15)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  cashuReceivedText: { color: Colors.cyan, fontSize: 9, fontWeight: '700' as const },
  cashuHint: { color: 'rgba(34,211,238,0.55)', fontSize: 10, marginTop: 2 },
  cashuLabel: { color: Colors.cyan, fontSize: 11, fontWeight: '700' },
  cashuAmount: { color: Colors.cyan, fontSize: 20, fontWeight: '800' },
  messageText: { color: Colors.text, fontSize: 15, lineHeight: 20 },
  myMessageText: { color: Colors.black },
  messageFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 4, marginTop: 4 },
  messageTime: { color: Colors.textMuted, fontSize: 10 },
  myMessageTime: { color: 'rgba(0,0,0,0.5)' },
  messageStatus: { fontSize: 10, color: 'rgba(0,0,0,0.5)' },
  statusDelivered: { color: 'rgba(0,0,0,0.7)' },
  statusFailed: { color: Colors.red },
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: Colors.surface, borderTopWidth: 0.5, borderTopColor: Colors.border, gap: 6,
  },
  cashuSendButton: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.cyanDim, justifyContent: 'center', alignItems: 'center',
  },
  textInput: {
    flex: 1, backgroundColor: Colors.surfaceLight, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, color: Colors.text,
    fontSize: 15, minHeight: 40, maxHeight: 100, borderWidth: 0.5, borderColor: Colors.border,
  },
  sendButton: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surfaceLight, justifyContent: 'center', alignItems: 'center',
  },
  sendButtonActive: { backgroundColor: Colors.accent },
  micButton: {},
  micButtonRecording: { backgroundColor: Colors.red },
  // Overlay enregistrement (au-dessus de l'input, sans changer sa structure)
  recordingOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.redDim,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 0.5,
    borderTopColor: Colors.red + '40',
  },
  recordingPulseWrap: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.red,
  },
  recordingText: {
    flex: 1,
    color: Colors.red,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  recordingCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: Colors.surface,
  },
  recordingCancelText: {
    color: Colors.red,
    fontSize: 12,
    fontWeight: '600',
  },
  // Audio bubble
  audioBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
    minWidth: 160,
  },
  audioPlayBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.accentGlow,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioPlayBtnMe: {
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  audioWaveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 28,
  },
  audioBar: {
    width: 3,
    borderRadius: 1.5,
    opacity: 0.7,
  },
  audioBarMe: {
    backgroundColor: Colors.black,
  },
  audioBarThem: {
    backgroundColor: Colors.accent,
  },
  audioDuration: {
    color: Colors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  audioDurationMe: {
    color: 'rgba(0,0,0,0.5)',
  },
  // Wrapper sans padding pour les images (évite le padding de messageBubble)
  imageWrapper: { padding: 0, overflow: 'hidden' },
  // Image / GIF bubble
  imageBubble: {
    width: 200,
    height: 160,
    borderRadius: 12,
  },
  imageBubbleMe: {
    borderBottomRightRadius: 4,
  },
  imageBubbleThem: {
    borderBottomLeftRadius: 4,
  },
  gifBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  gifBadgeText: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  transportBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    marginHorizontal: 3,
  },
  transportNostr: { backgroundColor: 'rgba(160, 32, 240, 0.15)' },
  transportBle:   { backgroundColor: 'rgba(0, 120, 255, 0.15)' },
  transportLora:  { backgroundColor: 'rgba(0, 200, 100, 0.15)' },
  transportBadgeText: { fontSize: 10 },
  // Visionneuse plein écran
  imageViewer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerFull: {
    width: '100%',
    height: '85%',
  },
  imageViewerClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    padding: 10,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
  },
  white: { color: '#fff' },
});

const actionStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 16, paddingBottom: 40, paddingTop: 4,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.surfaceHighlight,
    alignSelf: 'center', marginBottom: 16,
  },
  emojiRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12 },
  emojiBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.surfaceLight,
    justifyContent: 'center', alignItems: 'center',
  },
  emojiBtnActive: { backgroundColor: Colors.accentDim, borderWidth: 1.5, borderColor: Colors.accent },
  emoji: { fontSize: 22 },
  divider: { height: 0.5, backgroundColor: Colors.border, marginVertical: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 8 },
  actionText: { color: Colors.text, fontSize: 16 },
});

const profileStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 20, paddingBottom: 48, paddingTop: 4,
    alignItems: 'center',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.surfaceHighlight,
    alignSelf: 'center', marginBottom: 20,
  },
  avatarWrap: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.accentDim,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: { color: Colors.accent, fontSize: 28, fontWeight: '800' },
  name: { color: Colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  badgeRow: { flexDirection: 'row', gap: 8, marginBottom: 24, flexWrap: 'wrap', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  fields: { width: '100%', gap: 12 },
  field: {
    backgroundColor: Colors.surfaceLight, borderRadius: 14,
    padding: 14, borderWidth: 0.5, borderColor: Colors.border,
  },
  fieldLabel: { color: Colors.textMuted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldValue: { color: Colors.text, fontSize: 14, fontFamily: 'monospace', flex: 1, marginRight: 8 },
  copiedHint: { color: Colors.accent, fontSize: 11, marginTop: 4, fontWeight: '600' },
});

const cashuStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingBottom: 40,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.surfaceHighlight,
    alignSelf: 'center', marginTop: 10, marginBottom: 16,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20,
  },
  title: {
    flex: 1, color: Colors.text, fontSize: 17, fontWeight: '700',
  },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.surfaceLight, justifyContent: 'center', alignItems: 'center',
  },
  label: {
    color: Colors.textMuted, fontSize: 12, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
  },
  input: {
    backgroundColor: Colors.surfaceLight, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    color: Colors.text, fontSize: 13, fontFamily: 'monospace',
    borderWidth: 1, borderColor: Colors.border, minHeight: 80,
    textAlignVertical: 'top',
  },
  inputError: { borderColor: Colors.red },
  errorRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
  },
  errorText: { color: Colors.red, fontSize: 12 },
  preview: {
    backgroundColor: Colors.cyanDim, borderRadius: 12,
    padding: 14, marginTop: 14, gap: 8,
    borderWidth: 1, borderColor: 'rgba(34,211,238,0.3)',
  },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  previewLabel: { color: Colors.textMuted, fontSize: 12 },
  previewAmount: { color: Colors.cyan, fontSize: 22, fontWeight: '800' },
  previewMint: { color: Colors.textSecondary, fontSize: 11, fontFamily: 'monospace', maxWidth: '65%' },
  sendBtn: {
    marginTop: 20, backgroundColor: Colors.cyan,
    paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: Colors.surfaceLight },
  sendBtnText: { color: Colors.black, fontSize: 16, fontWeight: '700' },
});
