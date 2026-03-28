/**
 * CheckoutModal — Processus d'achat complet
 *
 * Étapes :
 *  1. Formulaire de livraison (chiffré NIP-44 côté vendeur)
 *  2. Choix du mode de paiement
 *  3. Confirmation et envoi de la commande
 */
import React, { useState, useCallback } from 'react';
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
  ChevronRight,
  Check,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { type ShopProduct, type DeliveryForm, type PaymentMethod, type DeliveryZone, formatSats } from '@/utils/shop';
import { useShop } from '@/providers/ShopProvider';

interface CheckoutModalProps {
  visible: boolean;
  product: ShopProduct | null;
  shippingZones?: DeliveryZone[];
  onClose: () => void;
  onOrderPlaced: (orderId: string) => void;
}

type Step = 'delivery' | 'payment' | 'confirm';

const PAYMENT_OPTIONS: Array<{ method: PaymentMethod; label: string; desc: string; icon: any }> = [
  { method: 'cashu', label: 'Cashu eCash', desc: 'Instant, privé, depuis votre wallet', icon: Zap },
  { method: 'lightning', label: 'Lightning', desc: 'Invoice BOLT11 générée par le vendeur', icon: Zap },
  { method: 'onchain', label: 'Bitcoin on-chain', desc: 'Adresse Bitcoin dédiée à cette commande', icon: Bitcoin },
];

export default function CheckoutModal({ visible, product, shippingZones = [], onClose, onOrderPlaced }: CheckoutModalProps) {
  const { placeOrder } = useShop();
  const [step, setStep] = useState<Step>('delivery');
  const [loading, setLoading] = useState(false);

  const [delivery, setDelivery] = useState<DeliveryForm>({
    name: '',
    address: '',
    city: '',
    postalCode: '',
    country: 'France',
    phone: '',
    notes: '',
  });
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cashu');
  const [selectedZone, setSelectedZone] = useState<DeliveryZone | null>(
    shippingZones.length > 0 ? shippingZones[0] : null,
  );
  const shippingSats = selectedZone?.costSats ?? 0;

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
    if (!delivery.country.trim()) { Alert.alert('Champ manquant', 'Entrez votre pays'); return false; }
    return true;
  }, [delivery]);

  const handleConfirm = useCallback(async () => {
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
            <Text style={styles.priceValue}>{formatSats(product.priceSats + shippingSats)}</Text>
          </View>

          {/* Étapes */}
          <View style={styles.steps}>
            {(['delivery', 'payment', 'confirm'] as Step[]).map((s, i) => (
              <View key={s} style={styles.stepItem}>
                <View style={[styles.stepDot, step === s && styles.stepDotActive, i < ['delivery', 'payment', 'confirm'].indexOf(step) && styles.stepDotDone]}>
                  {i < ['delivery', 'payment', 'confirm'].indexOf(step)
                    ? <Check size={10} color={Colors.background} />
                    : <Text style={styles.stepNum}>{i + 1}</Text>
                  }
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
                  🔒 Ces informations sont chiffrées et envoyées directement au vendeur. Elles ne transitent par aucun serveur.
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
                  <View>
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

                <TouchableOpacity
                  style={styles.nextBtn}
                  onPress={() => { if (validateDelivery()) setStep('payment'); }}
                >
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

                {PAYMENT_OPTIONS.map(({ method, label, desc, icon: Icon }) => (
                  <TouchableOpacity
                    key={method}
                    style={[styles.payOption, paymentMethod === method && styles.payOptionActive]}
                    onPress={() => setPaymentMethod(method)}
                  >
                    <View style={[styles.payIcon, paymentMethod === method && styles.payIconActive]}>
                      <Icon size={20} color={paymentMethod === method ? Colors.background : Colors.textMuted} />
                    </View>
                    <View style={styles.payInfo}>
                      <Text style={[styles.payLabel, paymentMethod === method && styles.payLabelActive]}>{label}</Text>
                      <Text style={styles.payDesc}>{desc}</Text>
                    </View>
                    {paymentMethod === method && (
                      <View style={styles.payCheck}>
                        <Check size={14} color={Colors.accent} />
                      </View>
                    )}
                  </TouchableOpacity>
                ))}

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
                <Text style={styles.confirmTitle}>Récapitulatif de la commande</Text>

                <View style={styles.summaryCard}>
                  <SummaryRow label="Produit" value={product.name} />
                  <SummaryRow label="Prix" value={formatSats(product.priceSats)} />
                  <SummaryRow label="Livraison" value={shippingSats === 0 ? 'À confirmer' : formatSats(shippingSats)} />
                  <SummaryRow label="Total estimé" value={formatSats(product.priceSats + shippingSats)} highlight />
                  <SummaryRow label="Paiement" value={PAYMENT_OPTIONS.find((o) => o.method === paymentMethod)?.label ?? ''} />
                  <SummaryRow label="Livraison à" value={`${delivery.name}, ${delivery.city}`} />
                </View>

                <Text style={styles.confirmNote}>
                  📬 Votre commande sera envoyée chiffrée au vendeur. Il vous enverra les instructions de paiement en message privé.
                </Text>

                <View style={styles.btnRow}>
                  <TouchableOpacity style={styles.backBtn} onPress={() => setStep('payment')}>
                    <Text style={styles.backBtnText}>Retour</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmBtn, loading && styles.confirmBtnDisabled]}
                    onPress={handleConfirm}
                    disabled={loading}
                  >
                    {loading
                      ? <ActivityIndicator size="small" color={Colors.background} />
                      : <Text style={styles.confirmBtnText}>Passer la commande</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            )}

          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({
  label, value, onChangeText, placeholder, multiline, keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: any;
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
  payOption: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 14, marginBottom: 10, gap: 12 },
  payOptionActive: { borderColor: Colors.accent, backgroundColor: Colors.accentGlow },
  payIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: Colors.surfaceHighlight, alignItems: 'center', justifyContent: 'center' },
  payIconActive: { backgroundColor: Colors.accent },
  payInfo: { flex: 1 },
  payLabel: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  payLabelActive: { color: Colors.accent },
  payDesc: { color: Colors.textMuted, fontSize: 12, marginTop: 2 },
  payCheck: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  confirmTitle: { color: Colors.text, fontSize: 16, fontWeight: '700', marginBottom: 14 },
  summaryCard: { backgroundColor: Colors.surfaceHighlight, borderRadius: 12, padding: 14, marginBottom: 14 },
  confirmNote: { backgroundColor: Colors.accentGlow, borderRadius: 8, padding: 12, color: Colors.accent, fontSize: 12, lineHeight: 18, marginBottom: 20 },
  confirmBtn: { flex: 1, backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  confirmBtnDisabled: { opacity: 0.6 },
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
