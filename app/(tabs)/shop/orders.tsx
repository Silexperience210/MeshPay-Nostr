/**
 * Orders — Mes achats et ventes
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  TextInput,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ClipboardList, Package, ChevronLeft, X, Truck, Send, Star } from 'lucide-react-native';
import * as ExpoClipboard from 'expo-clipboard';
import ReviewModal from '@/components/ReviewModal';
import Colors from '@/constants/colors';
import { useShop } from '@/providers/ShopProvider';
import { router } from 'expo-router';
import {
  type ShopOrder,
  type OrderStatus,
  formatSats,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_COLOR,
} from '@/utils/shop';

type Tab = 'purchases' | 'sales';

const SELLER_ACTIONS: Array<{ status: OrderStatus; label: string; color: string }> = [
  { status: 'processing', label: 'Préparer', color: Colors.purple },
  { status: 'shipped', label: 'Expédié', color: Colors.cyan },
  { status: 'delivered', label: 'Livré ✓', color: Colors.green },
  { status: 'cancelled', label: 'Annuler', color: Colors.red },
];

export default function OrdersScreen() {
  const { myPurchases, mySales, updateOrderStatus, cancelOrder, confirmOrder } = useShop();
  const [tab, setTab] = useState<Tab>('purchases');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [invoiceOrder, setInvoiceOrder] = useState<ShopOrder | null>(null);
  const [invoiceText, setInvoiceText] = useState('');
  const [reviewOrder, setReviewOrder] = useState<ShopOrder | null>(null);

  const orders = tab === 'purchases' ? myPurchases : mySales;

  const handleSendInvoice = useCallback(async () => {
    if (!invoiceOrder || !invoiceText.trim()) return;
    setLoadingId(invoiceOrder.id);
    try {
      await confirmOrder(invoiceOrder.id, invoiceText.trim());
      setInvoiceOrder(null);
      setInvoiceText('');
      Alert.alert('✅ Envoyé', 'Les informations de paiement ont été envoyées à l\'acheteur via DM chiffré.');
    } catch (e: any) {
      Alert.alert('Erreur', e.message);
    } finally {
      setLoadingId(null);
    }
  }, [invoiceOrder, invoiceText, confirmOrder]);

  const handleStatusUpdate = useCallback(async (order: ShopOrder, status: OrderStatus) => {
    if (status === 'cancelled') {
      Alert.alert('Annuler', 'Confirmer l\'annulation ?', [
        { text: 'Non', style: 'cancel' },
        {
          text: 'Annuler la commande', style: 'destructive',
          onPress: async () => {
            setLoadingId(order.id);
            try { await cancelOrder(order.id); } catch (e: any) { Alert.alert('Erreur', e.message); }
            finally { setLoadingId(null); }
          },
        },
      ]);
      return;
    }
    setLoadingId(order.id);
    try { await updateOrderStatus(order.id, status); } catch (e: any) { Alert.alert('Erreur', e.message); }
    finally { setLoadingId(null); }
  }, [cancelOrder, updateOrderStatus]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ChevronLeft size={24} color={Colors.text} />
        </TouchableOpacity>
        <ClipboardList size={20} color={Colors.accent} />
        <Text style={styles.headerTitle}>Commandes</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'purchases' && styles.tabBtnActive]}
          onPress={() => setTab('purchases')}
        >
          <Text style={[styles.tabLabel, tab === 'purchases' && styles.tabLabelActive]}>
            Mes achats ({myPurchases.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'sales' && styles.tabBtnActive]}
          onPress={() => setTab('sales')}
        >
          <Text style={[styles.tabLabel, tab === 'sales' && styles.tabLabelActive]}>
            Mes ventes ({mySales.length})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Modale envoi invoice */}
      <Modal visible={!!invoiceOrder} transparent animationType="fade" onRequestClose={() => setInvoiceOrder(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Envoyer info de paiement</Text>
            <Text style={styles.modalSubtitle}>
              Entrez l'invoice Lightning (BOLT11), l'adresse Bitcoin, ou le token Cashu pour {invoiceOrder?.productName}
            </Text>
            <TextInput
              style={styles.invoiceInput}
              value={invoiceText}
              onChangeText={setInvoiceText}
              placeholder="lnbc... ou bc1... ou cashuA..."
              placeholderTextColor={Colors.textMuted}
              multiline
              autoCorrect={false}
              autoCapitalize="none"
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => { setInvoiceOrder(null); setInvoiceText(''); }}>
                <Text style={styles.modalCancelText}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSendBtn, (!invoiceText.trim() || loadingId === invoiceOrder?.id) && { opacity: 0.5 }]}
                onPress={handleSendInvoice}
                disabled={!invoiceText.trim() || loadingId === invoiceOrder?.id}
              >
                {loadingId === invoiceOrder?.id
                  ? <ActivityIndicator size="small" color={Colors.background} />
                  : <><Send size={14} color={Colors.background} /><Text style={styles.modalSendText}>Envoyer</Text></>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <ReviewModal
        visible={!!reviewOrder}
        order={reviewOrder}
        onClose={() => setReviewOrder(null)}
      />

      <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
        {orders.length === 0 ? (
          <View style={styles.empty}>
            <Package size={48} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>
              {tab === 'purchases' ? 'Aucun achat' : 'Aucune vente'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {tab === 'purchases'
                ? 'Vos commandes passées apparaîtront ici'
                : 'Vos ventes reçues apparaîtront ici. Publiez des produits pour commencer.'}
            </Text>
          </View>
        ) : (
          orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              isSale={tab === 'sales'}
              loading={loadingId === order.id}
              onStatusUpdate={handleStatusUpdate}
              onSendInvoice={() => { setInvoiceOrder(order); setInvoiceText(''); }}
              onReview={() => setReviewOrder(order)}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OrderCard({
  order,
  isSale,
  loading,
  onStatusUpdate,
  onSendInvoice,
  onReview,
}: {
  order: ShopOrder;
  isSale: boolean;
  loading: boolean;
  onStatusUpdate: (order: ShopOrder, status: OrderStatus) => void;
  onSendInvoice: () => void;
  onReview: () => void;
}) {
  const statusColor = ORDER_STATUS_COLOR[order.status];
  const statusLabel = ORDER_STATUS_LABEL[order.status];
  const date = new Date(order.createdAt * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });

  return (
    <View style={styles.card}>
      {/* Status badge */}
      <View style={styles.cardHeader}>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + '22', borderColor: statusColor }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
        <Text style={styles.orderDate}>#{order.id.slice(0, 8)} · {date}</Text>
      </View>

      {/* Product */}
      <Text style={styles.productName}>{order.productName}</Text>
      <View style={styles.amountRow}>
        <Text style={styles.amount}>{formatSats(order.totalSats)}</Text>
        <Text style={styles.payMethod}>{order.paymentMethod}</Text>
      </View>

      {/* Delivery info (vendeur) */}
      {isSale && order.delivery && (
        <View style={styles.deliveryBox}>
          <Truck size={13} color={Colors.blue} />
          <Text style={styles.deliveryText}>
            {order.delivery.name} — {order.delivery.address}, {order.delivery.postalCode} {order.delivery.city}, {order.delivery.country}
          </Text>
        </View>
      )}

      {/* Notes */}
      {order.notes && (
        <Text style={styles.notes}>💬 {order.notes}</Text>
      )}

      {/* Bouton envoyer invoice — vendeur, commande en attente de paiement */}
      {isSale && order.status === 'pending_payment' && (
        <TouchableOpacity style={styles.invoiceBtn} onPress={onSendInvoice}>
          <Send size={14} color={Colors.accent} />
          <Text style={styles.invoiceBtnText}>Envoyer info paiement à l'acheteur</Text>
        </TouchableOpacity>
      )}

      {/* Affichage paymentRef si existant (acheteur voit l'invoice reçue) */}
      {!isSale && order.paymentRef && order.status === 'paid' && (
        <TouchableOpacity
          style={styles.paymentRefBox}
          onPress={() => ExpoClipboard.setStringAsync(order.paymentRef!).then(() => Alert.alert('Copié', 'Info de paiement copiée'))}
        >
          <Text style={styles.paymentRefLabel}>Info paiement reçue (appuyez pour copier) :</Text>
          <Text style={styles.paymentRefText} numberOfLines={2}>{order.paymentRef}</Text>
        </TouchableOpacity>
      )}

      {/* Actions vendeur */}
      {isSale && order.status !== 'delivered' && order.status !== 'cancelled' && (
        <View style={styles.actionsRow}>
          {loading ? (
            <ActivityIndicator size="small" color={Colors.accent} />
          ) : (
            SELLER_ACTIONS.filter((a) => {
              // Ne montrer que les transitions logiques
              if (order.status === 'pending_payment') return a.status === 'cancelled';
              if (order.status === 'paid') return ['processing', 'cancelled'].includes(a.status);
              if (order.status === 'processing') return ['shipped', 'cancelled'].includes(a.status);
              if (order.status === 'shipped') return ['delivered', 'cancelled'].includes(a.status);
              return false;
            }).map(({ status, label, color }) => (
              <TouchableOpacity
                key={status}
                style={[styles.actionBtn, { backgroundColor: color + '22', borderColor: color }]}
                onPress={() => onStatusUpdate(order, status)}
              >
                <Text style={[styles.actionBtnText, { color }]}>{label}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

      {/* Action acheteur — laisser un avis si livré */}
      {!isSale && order.status === 'delivered' && (
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: Colors.yellow, backgroundColor: Colors.yellowDim, marginTop: 10 }]}
          onPress={onReview}
        >
          <Star size={13} color={Colors.yellow} />
          <Text style={[styles.actionBtnText, { color: Colors.yellow }]}>Laisser un avis</Text>
        </TouchableOpacity>
      )}

      {/* Action acheteur — annuler si en attente */}
      {!isSale && order.status === 'pending_payment' && !loading && (
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: Colors.red, backgroundColor: Colors.redDim, marginTop: 10 }]}
          onPress={() => onStatusUpdate(order, 'cancelled')}
        >
          <X size={13} color={Colors.red} />
          <Text style={[styles.actionBtnText, { color: Colors.red }]}>Annuler la commande</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { flex: 1, color: Colors.text, fontSize: 18, fontWeight: '800' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: Colors.accent },
  tabLabel: { color: Colors.textMuted, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: Colors.accent },
  body: { flex: 1, padding: 16 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyTitle: { color: Colors.text, fontSize: 16, fontWeight: '700' },
  emptySubtitle: { color: Colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20, paddingHorizontal: 20 },
  card: { backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 14, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  statusText: { fontSize: 11, fontWeight: '700' },
  orderDate: { color: Colors.textMuted, fontSize: 11, fontFamily: 'monospace' },
  productName: { color: Colors.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  amount: { color: Colors.accent, fontSize: 16, fontWeight: '800', fontFamily: 'monospace' },
  payMethod: { color: Colors.textMuted, fontSize: 11, backgroundColor: Colors.surfaceHighlight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  deliveryBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: Colors.blueDim, borderRadius: 8, padding: 8, marginBottom: 8 },
  deliveryText: { flex: 1, color: Colors.blue, fontSize: 12, lineHeight: 17 },
  notes: { color: Colors.textMuted, fontSize: 12, marginBottom: 8, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  actionBtnText: { fontSize: 12, fontWeight: '700' },
  invoiceBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.accentGlow, borderWidth: 1, borderColor: Colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, marginTop: 10 },
  invoiceBtnText: { color: Colors.accent, fontSize: 13, fontWeight: '700' },
  paymentRefBox: { backgroundColor: Colors.greenDim, borderRadius: 8, padding: 10, marginTop: 8, borderWidth: 1, borderColor: Colors.green },
  paymentRefLabel: { color: Colors.green, fontSize: 11, marginBottom: 4 },
  paymentRefText: { color: Colors.text, fontSize: 12, fontFamily: 'monospace' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', padding: 24 },
  modalBox: { backgroundColor: Colors.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: Colors.border },
  modalTitle: { color: Colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  modalSubtitle: { color: Colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 14 },
  invoiceInput: { backgroundColor: Colors.surfaceHighlight, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: 12, fontFamily: 'monospace', paddingHorizontal: 12, paddingVertical: 10, height: 80, textAlignVertical: 'top' },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 14 },
  modalCancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, alignItems: 'center' },
  modalCancelText: { color: Colors.textMuted, fontWeight: '600' },
  modalSendBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 12 },
  modalSendText: { color: Colors.background, fontWeight: '700', fontSize: 14 },
});
