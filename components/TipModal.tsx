/**
 * TipModal — Envoyer un tip Cashu rapide dans un DM
 * Sélection automatique des proofs depuis le wallet local, sans mint actif requis.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'; // ✅ useMemo ajouté
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { X, Zap, AlertTriangle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import { getCashuBalance, getUnspentCashuTokens, markCashuTokenSpent, markCashuTokenPending, markCashuTokenUnspent, type DBCashuToken } from '@/utils/database';
import { decodeCashuToken, encodeCashuToken } from '@/utils/cashu';

const PRESETS = [21, 100, 500, 1000];

interface TipModalProps {
  visible: boolean;
  onClose: () => void;
  convId: string;
  convName: string;
  sendCashu: (convId: string, token: string, amountSats: number) => Promise<void>;
}

/** Sélection greedy : token unique le plus proche >= target, sinon cumul de petits tokens */
function selectTokens(tokens: DBCashuToken[], target: number): { selected: DBCashuToken[]; total: number } | null {
  if (!tokens.length) return null;

  // Trier par montant croissant
  const sorted = [...tokens].sort((a, b) => a.amount - b.amount);

  // 1. Chercher le plus petit token unique >= target
  const single = sorted.find(t => t.amount >= target);
  if (single) return { selected: [single], total: single.amount };

  // 2. Accumuler les plus petits jusqu'à atteindre target
  let sum = 0;
  const acc: DBCashuToken[] = [];
  for (const t of sorted) {
    acc.push(t);
    sum += t.amount;
    if (sum >= target) return { selected: acc, total: sum };
  }

  return null; // solde insuffisant
}

function TipModalComponent({ visible, onClose, convId, convName, sendCashu }: TipModalProps) {
  const [balance, setBalance] = useState(0);
  const [tokens, setTokens] = useState<DBCashuToken[]>([]);
  const [amount, setAmount] = useState<number>(100);
  const [customStr, setCustomStr] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) {
      setIsCustom(false);
      setCustomStr('');
      setAmount(100);
      setError('');
      return;
    }
    (async () => {
      const [bal, tkns] = await Promise.all([getCashuBalance(), getUnspentCashuTokens()]);
      setBalance(bal.total);
      setTokens(tkns);
    })();
  }, [visible]);

  // ✅ OPTIMISATION: useMemo pour les calculs
  const effectiveAmount = useMemo(() => 
    isCustom ? (parseInt(customStr, 10) || 0) : amount,
    [isCustom, customStr, amount]
  );
  
  const selection = useMemo(() => 
    tokens.length ? selectTokens(tokens, effectiveAmount) : null,
    [tokens, effectiveAmount]
  );
  
  const willSend = selection?.total ?? 0;
  const overpay = willSend > effectiveAmount ? willSend - effectiveAmount : 0;

  // ✅ OPTIMISATION: useCallback avec dépendances complètes
  const handleConfirm = useCallback(async () => {
    if (effectiveAmount <= 0) { setError('Montant invalide.'); return; }
    if (!selection) { setError('Solde insuffisant.'); return; }

    setError('');
    setIsSending(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const pendingIds: string[] = [];
    try {
      // Marquer pending
      for (const t of selection.selected) {
        await markCashuTokenPending(t.id);
        pendingIds.push(t.id);
      }

      // Combiner les proofs en un seul token cashu
      const allProofs = selection.selected.flatMap(t => {
        const decoded = decodeCashuToken(t.token);
        return decoded?.token?.[0]?.proofs ?? [];
      });
      const mintUrl = selection.selected[0].mintUrl;
      const combinedToken = encodeCashuToken({ token: [{ mint: mintUrl, proofs: allProofs }] });

      await sendCashu(convId, combinedToken, selection.total);

      // Marquer spent
      for (const id of pendingIds) await markCashuTokenSpent(id);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err: any) {
      // Rollback
      for (const id of pendingIds) await markCashuTokenUnspent(id);
      setError(err?.message ?? 'Erreur lors de l\'envoi.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSending(false);
    }
  }, [effectiveAmount, selection, convId, sendCashu, onClose]); // ✅ Toutes les dépendances

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet}>
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <Zap size={20} color={Colors.yellow} />
            <Text style={styles.title}>Tip à {convName}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
              <X size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Solde */}
          <Text style={styles.balance}>Solde disponible : {balance.toLocaleString()} sats</Text>

          {/* Presets */}
          <View style={styles.presets}>
            {PRESETS.map(p => (
              <TouchableOpacity
                key={p}
                style={[styles.preset, !isCustom && amount === p && styles.presetActive]}
                onPress={() => { setIsCustom(false); setAmount(p); setError(''); }}
                activeOpacity={0.7}
              >
                <Text style={[styles.presetText, !isCustom && amount === p && styles.presetTextActive]}>
                  {p.toLocaleString()}
                </Text>
                <Text style={[styles.presetSats, !isCustom && amount === p && styles.presetTextActive]}>sats</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.preset, isCustom && styles.presetActive]}
              onPress={() => { setIsCustom(true); setError(''); }}
              activeOpacity={0.7}
            >
              <Text style={[styles.presetText, isCustom && styles.presetTextActive]}>Libre</Text>
            </TouchableOpacity>
          </View>

          {/* Input montant libre */}
          {isCustom && (
            <TextInput
              style={styles.customInput}
              value={customStr}
              onChangeText={v => { setCustomStr(v.replace(/\D/g, '')); setError(''); }}
              placeholder="Montant en sats"
              placeholderTextColor={Colors.textMuted}
              keyboardType="numeric"
              autoFocus
            />
          )}

          {/* Résumé du token qui sera envoyé */}
          {effectiveAmount > 0 && (
            <View style={styles.summary}>
              {selection ? (
                <>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Tip</Text>
                    <Text style={styles.summaryValue}>{effectiveAmount.toLocaleString()} sats</Text>
                  </View>
                  {overpay > 0 && (
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryNote}>Token arrondi à {willSend.toLocaleString()} sats</Text>
                    </View>
                  )}
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Envoi réel</Text>
                    <Text style={[styles.summaryValue, { color: Colors.yellow }]}>{willSend.toLocaleString()} sats</Text>
                  </View>
                </>
              ) : (
                <View style={styles.summaryRow}>
                  <AlertTriangle size={12} color={Colors.red} />
                  <Text style={[styles.summaryNote, { color: Colors.red }]}>Solde insuffisant</Text>
                </View>
              )}
            </View>
          )}

          {!!error && (
            <View style={styles.errorRow}>
              <AlertTriangle size={12} color={Colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Bouton confirmer */}
          <TouchableOpacity
            style={[styles.confirmBtn, (!selection || isSending) && styles.confirmBtnDisabled]}
            onPress={handleConfirm}
            disabled={!selection || isSending}
            activeOpacity={0.8}
          >
            {isSending
              ? <ActivityIndicator size="small" color={Colors.black} />
              : <><Zap size={16} color={Colors.black} /><Text style={styles.confirmText}>Envoyer {willSend > 0 ? `${willSend.toLocaleString()} sats` : ''}</Text></>
            }
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ✅ OPTIMISATION: React.memo pour éviter les re-renders inutiles
const TipModal = React.memo(TipModalComponent);
export default TipModal;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
  },
  closeBtn: {
    padding: 4,
  },
  balance: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 16,
  },
  presets: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  preset: {
    flex: 1,
    minWidth: 60,
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  presetActive: {
    borderColor: Colors.yellow,
    backgroundColor: Colors.yellowDim,
  },
  presetText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
  },
  presetTextActive: {
    color: Colors.yellow,
  },
  presetSats: {
    fontSize: 10,
    color: Colors.textMuted,
    marginTop: 2,
  },
  customInput: {
    backgroundColor: Colors.surfaceLight,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 14,
    color: Colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  summary: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 10,
    padding: 12,
    gap: 4,
    marginBottom: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  summaryValue: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
  },
  summaryNote: {
    fontSize: 12,
    color: Colors.textMuted,
    fontStyle: 'italic',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  errorText: {
    fontSize: 13,
    color: Colors.red,
  },
  confirmBtn: {
    backgroundColor: Colors.yellow,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    color: Colors.black,
    fontWeight: '700',
    fontSize: 16,
  },
});
