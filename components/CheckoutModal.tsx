/**
 * CheckoutModal — Processus d'achat complet
 *
 * Flows de paiement (du plus autonome au moins) :
 *  1. Cashu Direct        → proofs locaux → token joint au DM (0 internet côté paiement)
 *  2. Lightning Melt      → LNURL-pay → invoice → meltTokens(proofs) → preimage → DM paid
 *  3. On-chain Direct     → sendBitcoin() → txid → DM paid (si vendeur a publié adresse)
 *  4. LoRa Cashu Offline  → encode token → BLE sendChannelMessage → vendeur reçoit offline
 *  5. DM Flow (fallback)  → envoie commande → vendeur répond avec invoice/adresse
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  X,
  Package,
  MapPin,
  CreditCard,
  Zap,
  Bitcoin,
  Radio,
  ChevronRight,
  Check,
  Wallet,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { type ShopProduct, type DeliveryForm, type PaymentMethod, type DeliveryZone, formatSats, encodeLoRaPayment, generateId } from '@/utils/shop';
import { useShop } from '@/providers/ShopProvider';
import { useBle } from '@/providers/BleProvider';
import { useBitcoin } from '@/providers/BitcoinProvider';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import { getCashuBalance, getUnspentCashuTokens, markCashuTokenPending, markCashuTokenSpent, type DBCashuToken } from '@/utils/database';
import { encodeCashuToken, decodeCashuToken, meltTokens, fetchLNURLInvoice } from '@/utils/cashu';
import { encodeChunkHeader, CHUNK_PREFIX, CHUNK_VERSION } from '@/utils/chunking';

// Taille max d'un message canal LoRa (limite ble-gateway.sendChannelMessage)
const LORA_CHAN_LIMIT = 150;
// Header MCHK worst case : "MCHK|1|XXXX|99/99|CASHU|" = 25 chars → marge 5 → 30
const MCHK_HEADER_RESERVE = 30;
// Données utiles par chunk LoRa
const LORA_CHUNK_DATA = LORA_CHAN_LIMIT - MCHK_HEADER_RESERVE; // 120 chars

/**
 * Découpe un message en chunks LoRa compatibles avec sendChannelMessage (≤150B)
 * et les envoie avec un délai de duty-cycle entre chaque paquet.
 */
async function sendLoRaChunked(
  text: string,
  sender: (chunk: string) => Promise<void>,
  dataType: 'CASHU' | 'RAW' = 'CASHU',
): Promise<void> {
  // Générer un ID de message aléatoire 4 chars alphanum
  const msgId = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0');
  const totalChunks = Math.ceil(text.length / LORA_CHUNK_DATA);

  for (let i = 0; i < totalChunks; i++) {
    const payload = text.slice(i * LORA_CHUNK_DATA, (i + 1) * LORA_CHUNK_DATA);
    const header = encodeChunkHeader({
      prefix: CHUNK_PREFIX,
      version: CHUNK_VERSION,
      messageId: msgId,
      chunkIndex: i,
      totalChunks,
      dataType,
    });
    const raw = header + payload;
    await sender(raw);
    // Respecter le duty-cycle LoRa SF12 — pause entre paquets
    if (i < totalChunks - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log(`[LoRa] Envoyé ${totalChunks} chunk(s) pour message ${msgId} (${text.length}B total)`);
}

interface CheckoutModalProps {
  visible: boolean;
  product: ShopProduct | null;
  shippingZones?: DeliveryZone[];
  onClose: () => void;
  onOrderPlaced: (orderId: string) => void;
}

type Step = 'delivery' | 'payment' | 'confirm';

/** Sélection greedy identique à TipModal */
function selectCashuTokens(
  tokens: DBCashuToken[],
  target: number,
): { selected: DBCashuToken[]; total: number } | null {
  if (!tokens.length) return null;
  const sorted = [...tokens].sort((a, b) => a.amount - b.amount);
  const single = sorted.find((t) => t.amount >= target);
  if (single) return { selected: [single], total: single.amount };
  let sum = 0;
  const acc: DBCashuToken[] = [];
  for (const t of sorted) {
    acc.push(t);
    sum += t.amount;
    if (sum >= target) return { selected: acc, total: sum };
  }
  return null;
}

export default function CheckoutModal({
  visible,
  product,
  shippingZones = [],
  onClose,
  onOrderPlaced,
}: CheckoutModalProps) {
  const { placeOrder } = useShop();
  const ble = useBle();
  const { sendBitcoin, feeEstimates, balance: btcBalance } = useBitcoin();
  const { settings } = useAppSettings();

  const [step, setStep] = useState<Step>('delivery');
  const [loading, setLoading] = useState(false);

  // Livraison
  const [delivery, setDelivery] = useState<DeliveryForm>({
    name: '', address: '', city: '', postalCode: '', country: 'France', phone: '', notes: '',
  });
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cashu');
  const [selectedZone, setSelectedZone] = useState<DeliveryZone | null>(
    shippingZones.length > 0 ? shippingZones[0] : null,
  );
  const shippingSats = selectedZone?.costSats ?? 0;

  // Cashu wallet
  const [cashuBalance, setCashuBalance] = useState(0);
  const [cashuTokens, setCashuTokens] = useState<DBCashuToken[]>([]);

  useEffect(() => {
    if (visible && step === 'payment') {
      getCashuBalance().then((b) => setCashuBalance(b.total));
      getUnspentCashuTokens().then(setCashuTokens);
    }
  }, [visible, step]);

  const totalSats = (product?.priceSats ?? 0) + shippingSats;

  const handleClose = useCallback(() => {
    setStep('delivery');
    setLoading(false);
    onClose();
  }, [onClose]);

  const validateDelivery = useCallback(() => {
    if (!delivery.name.trim()) { Alert.alert('Champ manquant', 'Entrez votre nom'); return false; }
    if (!delivery.address.trim()) { Alert.alert('Champ manquant', 'Entrez votre adresse'); return false; }
    if (!delivery.city.trim()) { Alert.alert('Champ manquant', 'Entrez votre ville'); return false; }
    if (!delivery.postalCode.trim()) { Alert.alert('Champ manquant', 'Entrez votre code postal'); return false; }
    return true;
  }, [delivery]);

  // ── Cashu direct ───────────────────────────────────────────────────────────
  const handleCashuDirect = useCallback(async () => {
    if (!product) return;
    setLoading(true);
    try {
      const selection = selectCashuTokens(cashuTokens, totalSats);
      if (!selection) throw new Error(`Solde Cashu insuffisant (${cashuBalance} sat disponibles)`);

      // Marquer pending pendant l'envoi
      await Promise.all(selection.selected.map((t) => markCashuTokenPending(t.id)));

      // Encoder le token (regroupe les proofs sélectionnés)
      const decodedTokens = selection.selected
        .map((t) => decodeCashuToken(t.token))
        .filter(Boolean);

      const allProofs = decodedTokens.flatMap((t) => t!.token.map((e) => e.proofs).flat());
      const mintUrl = decodedTokens[0]?.token[0]?.mint ?? settings.defaultCashuMint;
      const encoded = encodeCashuToken({
        token: [{ mint: mintUrl, proofs: allProofs }],
      });

      const order = await placeOrder(product, delivery, 'cashu', shippingSats, { cashuToken: encoded });

      // Marquer dépensé après succès
      await Promise.all(selection.selected.map((t) => markCashuTokenSpent(t.id)));

      handleClose();
      onOrderPlaced(order.id);
    } catch (e: any) {
      Alert.alert('Erreur Cashu', e.message ?? 'Impossible de préparer le paiement');
      // Restaurer pending → unspent si erreur
      try {
        const { markCashuTokenUnspent } = await import('@/utils/database');
        const selection2 = selectCashuTokens(cashuTokens, totalSats);
        if (selection2) await Promise.all(selection2.selected.map((t) => markCashuTokenUnspent(t.id)));
      } catch {}
    } finally {
      setLoading(false);
    }
  }, [product, cashuTokens, cashuBalance, totalSats, delivery, shippingSats, placeOrder, handleClose, onOrderPlaced, settings.defaultCashuMint]);

  // ── Lightning via Cashu Melt (autonome — LNURL-pay → invoice → meltTokens) ─
  // Le buyer n'attend PAS la réponse du vendeur : le mint paie l'invoice directement.
  const handleLightningMelt = useCallback(async () => {
    if (!product || !product.sellerLightningAddress) return;
    setLoading(true);
    try {
      // 1. Résoudre l'adresse LN du vendeur → BOLT11 invoice
      const invoice = await fetchLNURLInvoice(product.sellerLightningAddress, totalSats);

      // 2. Sélectionner les proofs Cashu (+ 2% buffer pour fee_reserve mint)
      const feeBuffer = Math.max(10, Math.ceil(totalSats * 0.02));
      const selection = selectCashuTokens(cashuTokens, totalSats + feeBuffer);
      if (!selection) throw new Error(`Solde Cashu insuffisant pour le melt (${cashuBalance} sat disponibles)`);

      const decoded = selection.selected.map((t) => decodeCashuToken(t.token)).filter(Boolean);
      const allProofs = decoded.flatMap((t) => t!.token.map((e) => e.proofs).flat());
      const mintUrl = decoded[0]?.token[0]?.mint ?? settings.defaultCashuMint;

      await Promise.all(selection.selected.map((t) => markCashuTokenPending(t.id)));

      // 3. Melt → le mint règle l'invoice Lightning Network
      const result = await meltTokens(mintUrl, allProofs, invoice);
      if (!result.paid) throw new Error('Le mint n\'a pas pu payer l\'invoice Lightning');

      // 4. Marquer dépensé + créer commande avec preimage comme preuve de paiement
      await Promise.all(selection.selected.map((t) => markCashuTokenSpent(t.id)));
      const order = await placeOrder(product, delivery, 'lightning', shippingSats, {
        txid: result.preimage ?? invoice.slice(-16),
      });

      handleClose();
      onOrderPlaced(order.id);
    } catch (e: any) {
      Alert.alert('Erreur Lightning Melt', e.message ?? 'Paiement échoué');
      try {
        const { markCashuTokenUnspent } = await import('@/utils/database');
        const sel = selectCashuTokens(cashuTokens, totalSats);
        if (sel) await Promise.all(sel.selected.map((t) => markCashuTokenUnspent(t.id)));
      } catch {}
    } finally {
      setLoading(false);
    }
  }, [product, totalSats, cashuTokens, cashuBalance, delivery, shippingSats, placeOrder, handleClose, onOrderPlaced, settings.defaultCashuMint]);

  // ── LoRa Cashu Offline (BLE gateway requis — zéro internet) ─────────────────
  // Encode le token Cashu et l'envoie via le mesh LoRa local.
  // Le vendeur reçoit le token hors-ligne et le redempt quand il a du réseau.
  const handleLoRaCashu = useCallback(async () => {
    if (!product) return;
    if (!ble.connected) { Alert.alert('Gateway requis', 'Connectez un gateway BLE pour payer en LoRa offline.'); return; }
    setLoading(true);
    try {
      const selection = selectCashuTokens(cashuTokens, totalSats);
      if (!selection) throw new Error(`Solde Cashu insuffisant (${cashuBalance} sat)`);

      const decoded = selection.selected.map((t) => decodeCashuToken(t.token)).filter(Boolean);
      const allProofs = decoded.flatMap((t) => t!.token.map((e) => e.proofs).flat());
      const mintUrl = decoded[0]?.token[0]?.mint ?? settings.defaultCashuMint;
      const encoded = encodeCashuToken({ token: [{ mint: mintUrl, proofs: allProofs }] });

      await Promise.all(selection.selected.map((t) => markCashuTokenPending(t.id)));

      // Générer l'orderId et construire le message PAY: complet
      const loraMsg = encodeLoRaPayment(generateId(), product, totalSats, encoded);
      // Envoyer en chunks MCHK si le message dépasse la limite LoRa (toujours le cas pour un token Cashu)
      await sendLoRaChunked(loraMsg, (chunk) => ble.sendChannelMessage(chunk));

      await Promise.all(selection.selected.map((t) => markCashuTokenSpent(t.id)));
      const order = await placeOrder(product, delivery, 'lora_cashu', shippingSats, { cashuToken: encoded });

      handleClose();
      onOrderPlaced(order.id);
    } catch (e: any) {
      Alert.alert('Erreur LoRa', e.message ?? 'Envoi échoué');
      try {
        const { markCashuTokenUnspent } = await import('@/utils/database');
        const sel = selectCashuTokens(cashuTokens, totalSats);
        if (sel) await Promise.all(sel.selected.map((t) => markCashuTokenUnspent(t.id)));
      } catch {}
    } finally {
      setLoading(false);
    }
  }, [product, totalSats, cashuTokens, cashuBalance, delivery, shippingSats, placeOrder, ble, handleClose, onOrderPlaced, settings.defaultCashuMint]);

  // ── On-chain direct (si vendeur a publié son adresse) ──────────────────────
  const handleOnchainDirect = useCallback(async (sellerAddress: string) => {
    if (!product) return;
    setLoading(true);
    try {
      const feeRate = feeEstimates?.['3'] ?? 10;
      const { txid } = await sendBitcoin(sellerAddress, totalSats, feeRate);
      const order = await placeOrder(product, delivery, 'onchain', shippingSats, { txid });
      handleClose();
      onOrderPlaced(order.id);
    } catch (e: any) {
      Alert.alert('Erreur Bitcoin', e.message ?? 'Impossible d\'envoyer la transaction');
    } finally {
      setLoading(false);
    }
  }, [product, totalSats, delivery, shippingSats, sendBitcoin, feeEstimates, placeOrder, handleClose, onOrderPlaced]);

  // ── DM flow (Lightning + on-chain sans adresse) ────────────────────────────
  const handleDMFlow = useCallback(async () => {
    if (!product) return;
    setLoading(true);
    try {
      const order = await placeOrder(product, delivery, paymentMethod, shippingSats);
      handleClose();
      onOrderPlaced(order.id);
    } catch (e: any) {
      Alert.alert('Erreur', e.message ?? 'Impossible de passer la commande');
    } finally {
      setLoading(false);
    }
  }, [product, delivery, paymentMethod, shippingSats, placeOrder, handleClose, onOrderPlaced]);

  if (!product) return null;

  const cashuSelection = cashuTokens.length ? selectCashuTokens(cashuTokens, totalSats) : null;
  const hasEnoughCashu = cashuSelection !== null;
  const sellerBtcAddress = product.sellerBitcoinAddress;
  const sellerLnAddress = product.sellerLightningAddress;
  // Lightning Melt disponible si vendeur a une LN address ET buyer a assez de Cashu
  const canLightningMelt = !!(sellerLnAddress && hasEnoughCashu);
  // LoRa Cashu disponible si BLE connecté ET assez de Cashu
  const canLoRaCashu = ble.connected && hasEnoughCashu;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Package size={18} color={Colors.accent} />
            <Text style={styles.headerTitle}>{product.name}</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Prix */}
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>Total</Text>
            <Text style={styles.priceValue}>{formatSats(totalSats)}</Text>
          </View>

          {/* Étapes */}
          <View style={styles.steps}>
            {(['delivery', 'payment', 'confirm'] as Step[]).map((s, i) => (
              <View key={s} style={styles.stepItem}>
                <View style={[styles.stepDot, step === s && styles.stepDotActive, i < ['delivery', 'payment', 'confirm'].indexOf(step) && styles.stepDotDone]}>
                  {i < ['delivery', 'payment', 'confirm'].indexOf(step)
                    ? <Check size={10} color={Colors.background} />
                    : <Text style={styles.stepNum}>{i + 1}</Text>}
                </View>
                <Text style={[styles.stepLabel, step === s && styles.stepLabelActive]}>
                  {s === 'delivery' ? 'Livraison' : s === 'payment' ? 'Paiement' : 'Confirmer'}
                </Text>
              </View>
            ))}
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {/* ── Étape 1 : Livraison ── */}
            {step === 'delivery' && (
              <View>
                <View style={styles.sectionHeader}>
                  <MapPin size={16} color={Colors.blue} />
                  <Text style={styles.sectionTitle}>Adresse de livraison</Text>
                </View>
                <Text style={styles.privacyNote}>
                  🔒 Ces informations sont chiffrées et envoyées directement au vendeur.
                </Text>
                <Field label="Nom complet *" value={delivery.name} onChangeText={(v) => setDelivery((d) => ({ ...d, name: v }))} placeholder="Jean Dupont" />
                <Field label="Adresse *" value={delivery.address} onChangeText={(v) => setDelivery((d) => ({ ...d, address: v }))} placeholder="12 rue de la Paix" />
                <View style={styles.row2}>
                  <View style={{ flex: 1 }}>
                    <Field label="Code postal *" value={delivery.postalCode} onChangeText={(v) => setDelivery((d) => ({ ...d, postalCode: v }))} placeholder="75001" keyboardType="numeric" />
                  </View>
                  <View style={{ flex: 2, marginLeft: 8 }}>
                    <Field label="Ville *" value={delivery.city} onChangeText={(v) => setDelivery((d) => ({ ...d, city: v }))} placeholder="Paris" />
                  </View>
                </View>
                <Field label="Pays *" value={delivery.country} onChangeText={(v) => setDelivery((d) => ({ ...d, country: v }))} placeholder="France" />
                <Field label="Téléphone" value={delivery.phone ?? ''} onChangeText={(v) => setDelivery((d) => ({ ...d, phone: v }))} placeholder="+33 6 00 00 00 00" keyboardType="phone-pad" />
                <Field label="Notes pour le vendeur" value={delivery.notes ?? ''} onChangeText={(v) => setDelivery((d) => ({ ...d, notes: v }))} placeholder="Instructions de livraison..." multiline />

                {shippingZones.length > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={[styles.sectionTitle, { fontSize: 13, marginBottom: 8 }]}>Zone de livraison</Text>
                    {shippingZones.map((zone) => (
                      <TouchableOpacity
                        key={zone.id}
                        style={[styles.zoneRow, selectedZone?.id === zone.id && styles.zoneRowActive]}
                        onPress={() => setSelectedZone(zone)}
                      >
                        <Text style={[styles.zoneLabel, selectedZone?.id === zone.id && { color: Colors.accent }]}>{zone.name}</Text>
                        <Text style={[styles.zoneCost, selectedZone?.id === zone.id && { color: Colors.accent }]}>
                          {zone.costSats === 0 ? 'Gratuit' : formatSats(zone.costSats)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                <TouchableOpacity style={styles.nextBtn} onPress={() => { if (validateDelivery()) setStep('payment'); }}>
                  <Text style={styles.nextBtnText}>Choisir le paiement</Text>
                  <ChevronRight size={18} color={Colors.background} />
                </TouchableOpacity>
              </View>
            )}

            {/* ── Étape 2 : Paiement ── */}
            {step === 'payment' && (
              <View>
                <View style={styles.sectionHeader}>
                  <CreditCard size={16} color={Colors.blue} />
                  <Text style={styles.sectionTitle}>Mode de paiement</Text>
                </View>

                {/* ─ Cashu ─ */}
                <TouchableOpacity
                  style={[styles.payOption, paymentMethod === 'cashu' && styles.payOptionActive]}
                  onPress={() => setPaymentMethod('cashu')}
                >
                  <View style={[styles.payIcon, paymentMethod === 'cashu' && styles.payIconActive]}>
                    <Zap size={20} color={paymentMethod === 'cashu' ? Colors.background : Colors.textMuted} />
                  </View>
                  <View style={styles.payInfo}>
                    <Text style={[styles.payLabel, paymentMethod === 'cashu' && styles.payLabelActive]}>Cashu eCash</Text>
                    <Text style={styles.payDesc}>
                      Paiement immédiat depuis votre wallet local
                    </Text>
                    <View style={styles.payBadge}>
                      <Wallet size={10} color={Colors.green} />
                      <Text style={styles.payBadgeText}>
                        {cashuBalance} sat dispo • {hasEnoughCashu ? '✓ Suffisant' : '✗ Insuffisant'}
                      </Text>
                    </View>
                  </View>
                  {paymentMethod === 'cashu' && <View style={styles.payCheck}><Check size={14} color={Colors.accent} /></View>}
                </TouchableOpacity>

                {/* ─ Lightning (Melt si possible, DM flow sinon) ─ */}
                <TouchableOpacity
                  style={[styles.payOption, paymentMethod === 'lightning' && styles.payOptionActive]}
                  onPress={() => setPaymentMethod('lightning')}
                >
                  <View style={[styles.payIcon, paymentMethod === 'lightning' && styles.payIconActive]}>
                    <Zap size={20} color={paymentMethod === 'lightning' ? Colors.background : Colors.textMuted} />
                  </View>
                  <View style={styles.payInfo}>
                    <Text style={[styles.payLabel, paymentMethod === 'lightning' && styles.payLabelActive]}>Lightning Network</Text>
                    {canLightningMelt ? (
                      <Text style={styles.payDesc}>
                        Vos sats Cashu règlent l'invoice de <Text style={{ color: Colors.accent }}>{sellerLnAddress}</Text> via votre mint — paiement instantané sans attendre le vendeur.
                      </Text>
                    ) : sellerLnAddress ? (
                      <Text style={styles.payDesc}>
                        Adresse vendeur : <Text style={{ color: Colors.accent }}>{sellerLnAddress}</Text>
                        {'\n'}Rechargez votre Cashu pour activer le melt automatique.
                      </Text>
                    ) : (
                      <Text style={styles.payDesc}>Le vendeur vous enverra une invoice BOLT11 par message privé.</Text>
                    )}
                    {canLightningMelt ? (
                      <View style={styles.payBadge}>
                        <Zap size={10} color={Colors.green} />
                        <Text style={styles.payBadgeText}>⚡ Melt direct — aucune attente</Text>
                      </View>
                    ) : (
                      <View style={[styles.payBadge, { backgroundColor: Colors.yellowDim }]}>
                        <Text style={[styles.payBadgeText, { color: Colors.yellow }]}>⏳ Attente réponse vendeur</Text>
                      </View>
                    )}
                  </View>
                  {paymentMethod === 'lightning' && <View style={styles.payCheck}><Check size={14} color={Colors.accent} /></View>}
                </TouchableOpacity>

                {/* ─ LoRa Cashu Offline ─ */}
                <TouchableOpacity
                  style={[styles.payOption, paymentMethod === 'lora_cashu' && styles.payOptionActive, !ble.connected && styles.payOptionDimmed]}
                  onPress={() => ble.connected && setPaymentMethod('lora_cashu')}
                >
                  <View style={[styles.payIcon, paymentMethod === 'lora_cashu' && styles.payIconActive, !ble.connected && { opacity: 0.4 }]}>
                    <Radio size={20} color={paymentMethod === 'lora_cashu' ? Colors.background : Colors.textMuted} />
                  </View>
                  <View style={styles.payInfo}>
                    <Text style={[styles.payLabel, paymentMethod === 'lora_cashu' && styles.payLabelActive, !ble.connected && { opacity: 0.5 }]}>
                      LoRa Cashu Offline
                    </Text>
                    <Text style={[styles.payDesc, !ble.connected && { opacity: 0.5 }]}>
                      {ble.connected
                        ? 'Token Cashu envoyé directement au vendeur via le mesh LoRa local. Zéro internet requis.'
                        : 'Connectez un gateway BLE pour payer en LoRa offline.'}
                    </Text>
                    {ble.connected ? (
                      <View style={[styles.payBadge, { backgroundColor: Colors.greenDim }]}>
                        <Radio size={10} color={Colors.green} />
                        <Text style={styles.payBadgeText}>
                          {hasEnoughCashu ? '📡 Gateway connecté — paiement offline' : '✗ Solde Cashu insuffisant'}
                        </Text>
                      </View>
                    ) : (
                      <View style={[styles.payBadge, { backgroundColor: Colors.surfaceHighlight }]}>
                        <Text style={[styles.payBadgeText, { color: Colors.textMuted }]}>🔌 Gateway BLE requis</Text>
                      </View>
                    )}
                  </View>
                  {paymentMethod === 'lora_cashu' && <View style={styles.payCheck}><Check size={14} color={Colors.accent} /></View>}
                </TouchableOpacity>

                {/* ─ On-chain ─ */}
                <TouchableOpacity
                  style={[styles.payOption, paymentMethod === 'onchain' && styles.payOptionActive]}
                  onPress={() => setPaymentMethod('onchain')}
                >
                  <View style={[styles.payIcon, paymentMethod === 'onchain' && styles.payIconActive]}>
                    <Bitcoin size={20} color={paymentMethod === 'onchain' ? Colors.background : Colors.textMuted} />
                  </View>
                  <View style={styles.payInfo}>
                    <Text style={[styles.payLabel, paymentMethod === 'onchain' && styles.payLabelActive]}>Bitcoin on-chain</Text>
                    {sellerBtcAddress ? (
                      <>
                        <Text style={styles.payDesc}>
                          Paiement direct à l'adresse du vendeur.
                        </Text>
                        <Text style={[styles.payDesc, { color: Colors.textMuted, fontSize: 10, fontFamily: 'monospace' }]} numberOfLines={1}>
                          {sellerBtcAddress}
                        </Text>
                        <View style={styles.payBadge}>
                          <Wallet size={10} color={Colors.green} />
                          <Text style={styles.payBadgeText}>{btcBalance} sat dispo • Frais ~{feeEstimates?.['3'] ?? 10} sat/vB</Text>
                        </View>
                      </>
                    ) : (
                      <Text style={styles.payDesc}>
                        Le vendeur vous enverra son adresse Bitcoin par message privé après réception de votre commande.
                      </Text>
                    )}
                    {!sellerBtcAddress && (
                      <View style={[styles.payBadge, { backgroundColor: Colors.yellowDim }]}>
                        <Text style={[styles.payBadgeText, { color: Colors.yellow }]}>⏳ Attente réponse vendeur</Text>
                      </View>
                    )}
                  </View>
                  {paymentMethod === 'onchain' && <View style={styles.payCheck}><Check size={14} color={Colors.accent} /></View>}
                </TouchableOpacity>

                <View style={styles.btnRow}>
                  <TouchableOpacity style={styles.backBtn} onPress={() => setStep('delivery')}>
                    <Text style={styles.backBtnText}>Retour</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.nextBtn2} onPress={() => setStep('confirm')}>
                    <Text style={styles.nextBtnText}>Confirmer</Text>
                    <ChevronRight size={18} color={Colors.background} />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* ── Étape 3 : Confirmation ── */}
            {step === 'confirm' && (
              <View>
                <Text style={styles.confirmTitle}>Récapitulatif</Text>

                <View style={styles.summaryCard}>
                  <SummaryRow label="Produit" value={product.name} />
                  <SummaryRow label="Prix" value={formatSats(product.priceSats)} />
                  <SummaryRow label="Livraison" value={shippingSats === 0 ? 'Offerte' : formatSats(shippingSats)} />
                  <SummaryRow label="Total" value={formatSats(totalSats)} highlight />
                  <SummaryRow label="Livraison à" value={`${delivery.name}, ${delivery.city}`} />
                </View>

                {/* Info spécifique au mode de paiement */}
                {paymentMethod === 'cashu' && (
                  <View style={[styles.payInfoBox, { borderColor: Colors.green }]}>
                    <Zap size={16} color={Colors.green} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.payInfoTitle, { color: Colors.green }]}>Paiement Cashu immédiat</Text>
                      <Text style={styles.payInfoText}>
                        {hasEnoughCashu
                          ? `${cashuSelection!.total} sat seront débités de votre wallet et joints à la commande. Le vendeur reçoit le paiement dans le même message.`
                          : `Solde insuffisant (${cashuBalance} sat). Rechargez votre wallet Cashu ou changez de méthode.`
                        }
                      </Text>
                    </View>
                  </View>
                )}

                {paymentMethod === 'lightning' && canLightningMelt && (
                  <View style={[styles.payInfoBox, { borderColor: Colors.green }]}>
                    <Zap size={16} color={Colors.green} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.payInfoTitle, { color: Colors.green }]}>Lightning via Cashu Melt</Text>
                      <Text style={styles.payInfoText}>
                        Votre mint contacte {sellerLnAddress} pour générer une invoice, puis la règle avec vos proofs Cashu. Le preimage est joint à la commande comme preuve de paiement.
                      </Text>
                    </View>
                  </View>
                )}

                {paymentMethod === 'lightning' && !canLightningMelt && (
                  <View style={[styles.payInfoBox, { borderColor: Colors.yellow }]}>
                    <Zap size={16} color={Colors.yellow} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.payInfoTitle, { color: Colors.yellow }]}>Attente invoice Lightning</Text>
                      <Text style={styles.payInfoText}>
                        {sellerLnAddress
                          ? `Commande envoyée. Le vendeur (${sellerLnAddress}) générera une invoice et vous la transmettra par message privé.`
                          : 'Commande envoyée chiffrée. Le vendeur vous enverra une invoice BOLT11 par message privé.'
                        }
                      </Text>
                    </View>
                  </View>
                )}

                {paymentMethod === 'lora_cashu' && (
                  <View style={[styles.payInfoBox, { borderColor: Colors.green }]}>
                    <Radio size={16} color={Colors.green} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.payInfoTitle, { color: Colors.green }]}>Paiement LoRa Cashu Offline</Text>
                      <Text style={styles.payInfoText}>
                        Le token Cashu est encodé et envoyé via le mesh LoRa local. Le vendeur le reçoit immédiatement sur son appareil et le redempt dès qu'il a du réseau.
                      </Text>
                    </View>
                  </View>
                )}

                {paymentMethod === 'onchain' && (
                  <View style={[styles.payInfoBox, { borderColor: sellerBtcAddress ? Colors.accent : Colors.yellow }]}>
                    <Bitcoin size={16} color={sellerBtcAddress ? Colors.accent : Colors.yellow} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.payInfoTitle, { color: sellerBtcAddress ? Colors.accent : Colors.yellow }]}>
                        {sellerBtcAddress ? 'Paiement Bitcoin direct' : 'Attente adresse Bitcoin'}
                      </Text>
                      <Text style={styles.payInfoText}>
                        {sellerBtcAddress
                          ? `Transaction envoyée directement à l'adresse du vendeur. Le txid sera inclus dans votre commande.`
                          : 'Votre commande est envoyée au vendeur. Il vous enverra son adresse Bitcoin par message privé.'
                        }
                      </Text>
                    </View>
                  </View>
                )}

                <View style={styles.btnRow}>
                  <TouchableOpacity style={styles.backBtn} onPress={() => setStep('payment')}>
                    <Text style={styles.backBtnText}>Retour</Text>
                  </TouchableOpacity>

                  {/* Bouton adapté au flow */}
                  {paymentMethod === 'cashu' && (
                    <TouchableOpacity
                      style={[styles.confirmBtn, (!hasEnoughCashu || loading) && styles.confirmBtnDisabled]}
                      onPress={handleCashuDirect}
                      disabled={!hasEnoughCashu || loading}
                    >
                      {loading
                        ? <ActivityIndicator size="small" color={Colors.background} />
                        : <Text style={styles.confirmBtnText}>⚡ Payer {formatSats(totalSats)}</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {paymentMethod === 'lightning' && canLightningMelt && (
                    <TouchableOpacity
                      style={[styles.confirmBtn, loading && styles.confirmBtnDisabled]}
                      onPress={handleLightningMelt}
                      disabled={loading}
                    >
                      {loading
                        ? <ActivityIndicator size="small" color={Colors.background} />
                        : <Text style={styles.confirmBtnText}>⚡ Melt {formatSats(totalSats)}</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {paymentMethod === 'lightning' && !canLightningMelt && (
                    <TouchableOpacity
                      style={[styles.confirmBtn, loading && styles.confirmBtnDisabled]}
                      onPress={handleDMFlow}
                      disabled={loading}
                    >
                      {loading
                        ? <ActivityIndicator size="small" color={Colors.background} />
                        : <Text style={styles.confirmBtnText}>Envoyer la commande</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {paymentMethod === 'onchain' && sellerBtcAddress && (
                    <TouchableOpacity
                      style={[styles.confirmBtn, (btcBalance < totalSats || loading) && styles.confirmBtnDisabled]}
                      onPress={() => handleOnchainDirect(sellerBtcAddress)}
                      disabled={btcBalance < totalSats || loading}
                    >
                      {loading
                        ? <ActivityIndicator size="small" color={Colors.background} />
                        : <Text style={styles.confirmBtnText}>₿ Envoyer {formatSats(totalSats)}</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {paymentMethod === 'onchain' && !sellerBtcAddress && (
                    <TouchableOpacity
                      style={[styles.confirmBtn, loading && styles.confirmBtnDisabled]}
                      onPress={handleDMFlow}
                      disabled={loading}
                    >
                      {loading
                        ? <ActivityIndicator size="small" color={Colors.background} />
                        : <Text style={styles.confirmBtnText}>Envoyer la commande</Text>
                      }
                    </TouchableOpacity>
                  )}

                  {paymentMethod === 'lora_cashu' && (
                    <TouchableOpacity
                      style={[styles.confirmBtn, (!canLoRaCashu || loading) && styles.confirmBtnDisabled]}
                      onPress={handleLoRaCashu}
                      disabled={!canLoRaCashu || loading}
                    >
                      {loading
                        ? <ActivityIndicator size="small" color={Colors.background} />
                        : <Text style={styles.confirmBtnText}>📡 Payer via LoRa</Text>
                      }
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, value, onChangeText, placeholder, multiline, keyboardType }: {
  label: string; value: string; onChangeText: (v: string) => void;
  placeholder?: string; multiline?: boolean; keyboardType?: any;
}) {
  return (
    <View style={fieldStyles.container}>
      <Text style={fieldStyles.label}>{label}</Text>
      <TextInput
        style={[fieldStyles.input, multiline && fieldStyles.inputMulti]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textMuted}
        multiline={multiline}
        keyboardType={keyboardType}
        numberOfLines={multiline ? 3 : 1}
      />
    </View>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={summaryStyles.row}>
      <Text style={summaryStyles.label}>{label}</Text>
      <Text style={[summaryStyles.value, highlight && summaryStyles.highlight]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  container: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '95%' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { flex: 1, color: Colors.text, fontSize: 15, fontWeight: '700' },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: Colors.accentGlow },
  priceLabel: { color: Colors.textMuted, fontSize: 13 },
  priceValue: { color: Colors.accent, fontSize: 18, fontWeight: '800', fontFamily: 'monospace' },
  steps: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 12, gap: 24, borderBottomWidth: 1, borderBottomColor: Colors.border },
  stepItem: { alignItems: 'center', gap: 4 },
  stepDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.surfaceHighlight, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  stepDotActive: { borderColor: Colors.accent, backgroundColor: Colors.accentGlow },
  stepDotDone: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  stepNum: { color: Colors.textMuted, fontSize: 11, fontWeight: '700' },
  stepLabel: { color: Colors.textMuted, fontSize: 10 },
  stepLabelActive: { color: Colors.accent, fontWeight: '700' },
  body: { padding: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { color: Colors.text, fontSize: 15, fontWeight: '700' },
  privacyNote: { backgroundColor: Colors.blueDim, borderRadius: 8, padding: 10, marginBottom: 16, color: Colors.blue, fontSize: 12, lineHeight: 18 },
  row2: { flexDirection: 'row' },
  nextBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14, marginTop: 20, marginBottom: 24 },
  nextBtn2: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14 },
  nextBtnText: { color: Colors.background, fontSize: 15, fontWeight: '700' },
  backBtn: { paddingVertical: 14, paddingHorizontal: 20, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  backBtnText: { color: Colors.textMuted, fontSize: 14, fontWeight: '600' },
  btnRow: { flexDirection: 'row', marginTop: 20, marginBottom: 24 },
  payOption: { flexDirection: 'row', alignItems: 'flex-start', borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 14, marginBottom: 10, gap: 12 },
  payOptionActive: { borderColor: Colors.accent, backgroundColor: Colors.accentGlow },
  payOptionDimmed: { opacity: 0.5 },
  payIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: Colors.surfaceHighlight, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 },
  payIconActive: { backgroundColor: Colors.accent },
  payInfo: { flex: 1, gap: 4 },
  payLabel: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  payLabelActive: { color: Colors.accent },
  payDesc: { color: Colors.textMuted, fontSize: 12, lineHeight: 17 },
  payBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, backgroundColor: Colors.greenDim, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
  payBadgeText: { color: Colors.green, fontSize: 10, fontWeight: '600' },
  payCheck: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: Colors.accent, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  confirmTitle: { color: Colors.text, fontSize: 16, fontWeight: '700', marginBottom: 14 },
  summaryCard: { backgroundColor: Colors.surfaceHighlight, borderRadius: 12, padding: 14, marginBottom: 14 },
  payInfoBox: { flexDirection: 'row', gap: 10, backgroundColor: Colors.surface, borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 20, alignItems: 'flex-start' },
  payInfoTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  payInfoText: { color: Colors.textMuted, fontSize: 12, lineHeight: 18 },
  confirmBtn: { flex: 1, backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  confirmBtnDisabled: { opacity: 0.5 },
  confirmBtnText: { color: Colors.background, fontSize: 15, fontWeight: '700' },
  zoneRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, marginBottom: 6, backgroundColor: Colors.surfaceHighlight },
  zoneRowActive: { borderColor: Colors.accent, backgroundColor: Colors.accentGlow },
  zoneLabel: { color: Colors.text, fontSize: 13, fontWeight: '600' },
  zoneCost: { color: Colors.textMuted, fontSize: 13, fontFamily: 'monospace' },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 12 },
  label: { color: Colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  input: { backgroundColor: Colors.surfaceHighlight, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: 14, paddingHorizontal: 12, paddingVertical: 10 },
  inputMulti: { height: 80, textAlignVertical: 'top', paddingTop: 10 },
});

const summaryStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  label: { color: Colors.textMuted, fontSize: 13 },
  value: { color: Colors.text, fontSize: 13, fontWeight: '600', maxWidth: '60%', textAlign: 'right' },
  highlight: { color: Colors.accent, fontSize: 15, fontWeight: '800' },
});
