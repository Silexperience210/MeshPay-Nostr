/**
 * My Shop — Gérer sa boutique et ses produits
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Store, Plus, Radio, Globe, Edit2, Trash2, Package, ChevronLeft, RefreshCw } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { useShop } from '@/providers/ShopProvider';
import { useBle } from '@/providers/BleProvider';
import ProductFormModal from '@/components/ProductFormModal';
import { type ShopProduct, formatSats, generateId } from '@/utils/shop';
import { router } from 'expo-router';

type ShopView = 'setup' | 'products';

export default function MyShopScreen() {
  const { myStall, myProducts, saveStall, removeProduct, publishToNostr, broadcastAllLoRa, broadcastLoRa } = useShop();
  const ble = useBle();

  const [view, setView] = useState<ShopView>(myStall ? 'products' : 'setup');
  const [stallName, setStallName] = useState(myStall?.name ?? '');
  const [stallDesc, setStallDesc] = useState(myStall?.description ?? '');
  const [stallLnAddress, setStallLnAddress] = useState(myStall?.lightningAddress ?? '');
  const [stallBtcAddress, setStallBtcAddress] = useState(myStall?.bitcoinAddress ?? '');
  const [savingStall, setSavingStall] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [editProduct, setEditProduct] = useState<ShopProduct | null>(null);
  const [showProductForm, setShowProductForm] = useState(false);

  const handleSaveStall = useCallback(async () => {
    if (!stallName.trim()) { Alert.alert('Champ manquant', 'Entrez un nom pour votre boutique'); return; }
    setSavingStall(true);
    try {
      await saveStall({
        id: myStall?.id ?? generateId(),
        name: stallName.trim(),
        description: stallDesc.trim(),
        currency: 'sat',
        shipping: [
          { id: 'fr', name: 'France', costSats: 0, regions: ['FR'] },
          { id: 'eu', name: 'Europe', costSats: 500, regions: ['EU'] },
          { id: 'world', name: 'Monde', costSats: 2000, regions: ['*'] },
        ],
        lightningAddress: stallLnAddress.trim() || undefined,
        bitcoinAddress: stallBtcAddress.trim() || undefined,
      });
      setView('products');
    } catch (e: any) {
      Alert.alert('Erreur', e.message);
    } finally {
      setSavingStall(false);
    }
  }, [stallName, stallDesc, myStall, saveStall]);

  const handlePublishNostr = useCallback(async () => {
    setPublishing(true);
    try {
      await publishToNostr();
      Alert.alert('✅ Publié', 'Votre boutique et vos produits sont maintenant visibles sur les relais Nostr.');
    } catch (e: any) {
      Alert.alert('Erreur', e.message);
    } finally {
      setPublishing(false);
    }
  }, [publishToNostr]);

  const handleBroadcastLoRa = useCallback(async () => {
    if (!ble.connected) { Alert.alert('Gateway requis', 'Connectez un gateway LoRa BLE pour diffuser en local.'); return; }
    setBroadcasting(true);
    try {
      await broadcastAllLoRa();
      Alert.alert('✅ Diffusé', `${myProducts.length} produit(s) diffusé(s) sur le mesh LoRa local.`);
    } catch (e: any) {
      Alert.alert('Erreur', e.message);
    } finally {
      setBroadcasting(false);
    }
  }, [ble.connected, broadcastAllLoRa, myProducts.length]);

  const handleDeleteProduct = useCallback((product: ShopProduct) => {
    Alert.alert(
      'Supprimer',
      `Supprimer "${product.name}" ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => removeProduct(product.id) },
      ],
    );
  }, [removeProduct]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ChevronLeft size={24} color={Colors.text} />
        </TouchableOpacity>
        <Store size={20} color={Colors.accent} />
        <Text style={styles.headerTitle}>Ma boutique</Text>
        {myStall && (
          <TouchableOpacity onPress={() => setView(view === 'setup' ? 'products' : 'setup')}>
            <Edit2 size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>

        {/* ── Setup boutique ── */}
        {view === 'setup' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Informations de la boutique</Text>

            <Field label="Nom de la boutique *" value={stallName} onChangeText={setStallName} placeholder="Alice Electronics" />
            <Field label="Description" value={stallDesc} onChangeText={setStallDesc} placeholder="Matériel électronique, composants, montages DIY..." multiline />

            <Field label="⚡ Lightning Address (optionnel)" value={stallLnAddress} onChangeText={setStallLnAddress} placeholder="alice@minibits.cash" keyboardType="email-address" />
            <Field label="₿ Adresse Bitcoin on-chain (optionnel)" value={stallBtcAddress} onChangeText={setStallBtcAddress} placeholder="bc1q..." />

            <View style={styles.shippingNote}>
              <Text style={styles.shippingNoteText}>
                📦 Des zones de livraison par défaut seront créées (France, Europe, Monde). Vous pourrez les personnaliser ultérieurement.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, savingStall && styles.btnDisabled]}
              onPress={handleSaveStall}
              disabled={savingStall}
            >
              {savingStall
                ? <ActivityIndicator size="small" color={Colors.background} />
                : <Text style={styles.primaryBtnText}>{myStall ? 'Enregistrer' : 'Créer ma boutique'}</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* ── Produits ── */}
        {view === 'products' && myStall && (
          <View>
            {/* Stall info */}
            <View style={styles.stallCard}>
              <View style={styles.stallIcon}>
                <Store size={24} color={Colors.accent} />
              </View>
              <View style={styles.stallInfo}>
                <Text style={styles.stallName}>{myStall.name}</Text>
                <Text style={styles.stallDesc} numberOfLines={2}>{myStall.description || 'Aucune description'}</Text>
              </View>
            </View>

            {/* Actions publish */}
            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.nostrBtn, publishing && styles.btnDisabled]}
                onPress={handlePublishNostr}
                disabled={publishing}
              >
                {publishing
                  ? <ActivityIndicator size="small" color={Colors.white} />
                  : <><Globe size={15} color={Colors.white} /><Text style={styles.actionBtnText}>Nostr</Text></>
                }
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.loraBtn, broadcasting && styles.btnDisabled, !ble.connected && styles.btnMuted]}
                onPress={handleBroadcastLoRa}
                disabled={broadcasting}
              >
                {broadcasting
                  ? <ActivityIndicator size="small" color={Colors.white} />
                  : <><Radio size={15} color={Colors.white} /><Text style={styles.actionBtnText}>LoRa</Text></>
                }
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.addBtn]}
                onPress={() => { setEditProduct(null); setShowProductForm(true); }}
              >
                <Plus size={15} color={Colors.background} />
                <Text style={[styles.actionBtnText, { color: Colors.background }]}>Produit</Text>
              </TouchableOpacity>
            </View>

            {!ble.connected && (
              <Text style={styles.loraHint}>⚠️ Connectez un gateway BLE pour diffuser en LoRa local</Text>
            )}

            {/* Liste produits */}
            {myProducts.length === 0 ? (
              <View style={styles.empty}>
                <Package size={48} color={Colors.textMuted} />
                <Text style={styles.emptyTitle}>Aucun produit</Text>
                <Text style={styles.emptySubtitle}>Ajoutez votre premier produit à vendre</Text>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => { setEditProduct(null); setShowProductForm(true); }}
                >
                  <Plus size={16} color={Colors.background} />
                  <Text style={styles.primaryBtnText}>Ajouter un produit</Text>
                </TouchableOpacity>
              </View>
            ) : (
              myProducts.map((product) => (
                <View key={product.id} style={styles.productRow}>
                  <View style={styles.productIcon}>
                    <Package size={20} color={Colors.accent} />
                  </View>
                  <View style={styles.productInfo}>
                    <Text style={styles.productName}>{product.name}</Text>
                    <Text style={styles.productPrice}>{formatSats(product.priceSats)}</Text>
                    {product.stock !== null && (
                      <Text style={[styles.productStock, product.stock === 0 && styles.outOfStock]}>
                        {product.stock === 0 ? 'Rupture' : `Stock: ${product.stock}`}
                      </Text>
                    )}
                  </View>
                  <View style={styles.productActions}>
                    <TouchableOpacity
                      style={styles.iconBtn}
                      onPress={async () => {
                        if (!ble.connected) { Alert.alert('Gateway requis', 'Connectez un gateway BLE pour diffuser en LoRa.'); return; }
                        try { await broadcastLoRa(product); } catch (e: any) { Alert.alert('Erreur', e.message); }
                      }}
                    >
                      <Radio size={15} color={Colors.green} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.iconBtn} onPress={() => { setEditProduct(product); setShowProductForm(true); }}>
                      <Edit2 size={15} color={Colors.blue} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.iconBtn} onPress={() => handleDeleteProduct(product)}>
                      <Trash2 size={15} color={Colors.red} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

      </ScrollView>

      <ProductFormModal
        visible={showProductForm}
        product={editProduct}
        onClose={() => setShowProductForm(false)}
      />
    </SafeAreaView>
  );
}

function Field({ label, value, onChangeText, placeholder, multiline, keyboardType }: {
  label: string; value: string; onChangeText: (v: string) => void;
  placeholder?: string; multiline?: boolean; keyboardType?: any;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ color: Colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 6 }}>{label}</Text>
      <TextInput
        style={{
          backgroundColor: Colors.surfaceHighlight, borderRadius: 10, borderWidth: 1,
          borderColor: Colors.border, color: Colors.text, fontSize: 14, paddingHorizontal: 12,
          paddingVertical: 10, ...(multiline ? { height: 80, textAlignVertical: 'top', paddingTop: 10 } : {}),
        }}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textMuted}
        multiline={multiline}
        keyboardType={keyboardType}
        numberOfLines={multiline ? 3 : 1}
        autoCapitalize="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { flex: 1, color: Colors.text, fontSize: 18, fontWeight: '800' },
  body: { flex: 1, padding: 16 },
  section: {},
  sectionTitle: { color: Colors.text, fontSize: 16, fontWeight: '700', marginBottom: 16 },
  shippingNote: { backgroundColor: Colors.blueDim, borderRadius: 8, padding: 10, marginBottom: 16 },
  shippingNoteText: { color: Colors.blue, fontSize: 12, lineHeight: 18 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14, marginTop: 8 },
  primaryBtnText: { color: Colors.background, fontSize: 15, fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },
  btnMuted: { opacity: 0.4 },
  stallCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: Colors.border },
  stallIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: Colors.accentGlow, alignItems: 'center', justifyContent: 'center' },
  stallInfo: { flex: 1 },
  stallName: { color: Colors.text, fontSize: 15, fontWeight: '700' },
  stallDesc: { color: Colors.textMuted, fontSize: 12, marginTop: 2 },
  actionsRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 10 },
  nostrBtn: { backgroundColor: Colors.purple },
  loraBtn: { backgroundColor: Colors.green },
  addBtn: { backgroundColor: Colors.accent },
  actionBtnText: { color: Colors.white, fontSize: 13, fontWeight: '700' },
  loraHint: { color: Colors.yellow, fontSize: 12, marginBottom: 12 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyTitle: { color: Colors.text, fontSize: 16, fontWeight: '700' },
  emptySubtitle: { color: Colors.textMuted, fontSize: 13 },
  productRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  productIcon: { width: 36, height: 36, borderRadius: 8, backgroundColor: Colors.accentGlow, alignItems: 'center', justifyContent: 'center' },
  productInfo: { flex: 1 },
  productName: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  productPrice: { color: Colors.accent, fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  productStock: { color: Colors.textMuted, fontSize: 11 },
  outOfStock: { color: Colors.red },
  productActions: { flexDirection: 'row', gap: 4 },
  iconBtn: { padding: 7, borderRadius: 8, backgroundColor: Colors.surfaceHighlight },
});
