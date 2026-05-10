/**
 * Shop — Browse marketplace
 * Deux sources : Nostr (relais) + LoRa local (mesh)
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ShoppingBag, Search, Radio, Globe, SlidersHorizontal, ClipboardList } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { useShop } from '@/providers/ShopProvider';
import ProductCard from '@/components/ProductCard';
import CheckoutModal from '@/components/CheckoutModal';
import { type ShopProduct } from '@/utils/shop';
import { router } from 'expo-router';

type SourceFilter = 'all' | 'nostr' | 'lora';

export default function ShopBrowseScreen() {
  const { browseProducts, loraProducts, isLoadingBrowse, refreshBrowse } = useShop();
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [selectedProduct, setSelectedProduct] = useState<ShopProduct | null>(null);
  const [showCheckout, setShowCheckout] = useState(false);

  const allProducts = [
    ...(sourceFilter !== 'lora' ? browseProducts : []),
    ...(sourceFilter !== 'nostr' ? loraProducts : []),
  ];

  const filtered = allProducts.filter((p) =>
    search.length === 0 ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.description.toLowerCase().includes(search.toLowerCase()),
  );

  const handleProductPress = useCallback((product: ShopProduct) => {
    setSelectedProduct(product);
    setShowCheckout(true);
  }, []);

  const handleOrderPlaced = useCallback((_orderId: string) => {
    Alert.alert(
      '✅ Commande envoyée',
      'Votre commande a été transmise de façon chiffrée au vendeur via Nostr.',
      [{ text: 'Voir mes commandes', onPress: () => router.push('/(tabs)/shop/orders') }, { text: 'OK' }],
    );
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <ShoppingBag size={22} color={Colors.accent} />
        <Text style={styles.headerTitle}>Marketplace</Text>
        <TouchableOpacity
          style={styles.headerIconBtn}
          onPress={() => router.push('/(tabs)/shop/orders')}
        >
          <ClipboardList size={20} color={Colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.myShopBtn}
          onPress={() => router.push('/(tabs)/shop/my-shop')}
        >
          <Text style={styles.myShopText}>Ma boutique</Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Search size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Rechercher un produit..."
            placeholderTextColor={Colors.textMuted}
          />
        </View>
      </View>

      {/* Source filter */}
      <View style={styles.filterRow}>
        {([
          { key: 'all', label: 'Tout', icon: SlidersHorizontal },
          { key: 'nostr', label: 'Nostr', icon: Globe },
          { key: 'lora', label: 'LoRa Local', icon: Radio },
        ] as const).map(({ key, label, icon: Icon }) => (
          <TouchableOpacity
            key={key}
            style={[styles.filterBtn, sourceFilter === key && styles.filterBtnActive]}
            onPress={() => setSourceFilter(key)}
          >
            <Icon size={13} color={sourceFilter === key ? Colors.accent : Colors.textMuted} />
            <Text style={[styles.filterLabel, sourceFilter === key && styles.filterLabelActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}

        {loraProducts.length > 0 && (
          <View style={styles.loraBadge}>
            <Radio size={11} color={Colors.green} />
            <Text style={styles.loraBadgeText}>{loraProducts.length} local</Text>
          </View>
        )}
      </View>

      {/* LoRa info banner */}
      {(sourceFilter === 'lora' || sourceFilter === 'all') && loraProducts.length > 0 && (
        <View style={styles.loraBanner}>
          <Radio size={14} color={Colors.green} />
          <Text style={styles.loraBannerText}>
            {loraProducts.length} produit(s) reçu(s) par LoRa dans votre zone
          </Text>
        </View>
      )}

      {/* Products */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isLoadingBrowse}
            onRefresh={refreshBrowse}
            tintColor={Colors.accent}
          />
        }
      >
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <ShoppingBag size={48} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>
              {isLoadingBrowse ? 'Chargement...' : 'Aucun produit trouvé'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {sourceFilter === 'lora'
                ? 'Aucun produit local reçu via LoRa. Activez votre gateway BLE et rapprochez-vous des vendeurs.'
                : 'Tirez vers le bas pour actualiser les produits depuis les relais Nostr.'}
            </Text>
          </View>
        ) : (
          filtered.map((product) => (
            <ProductCard key={product.id} product={product} onPress={handleProductPress} />
          ))
        )}
      </ScrollView>

      <CheckoutModal
        visible={showCheckout}
        product={selectedProduct}
        onClose={() => setShowCheckout(false)}
        onOrderPlaced={handleOrderPlaced}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { flex: 1, color: Colors.text, fontSize: 18, fontWeight: '800' },
  headerIconBtn: { padding: 6 },
  myShopBtn: { backgroundColor: Colors.accentGlow, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: Colors.accent },
  myShopText: { color: Colors.accent, fontSize: 12, fontWeight: '700' },
  searchRow: { paddingHorizontal: 16, paddingVertical: 10 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.surface, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, paddingVertical: 9 },
  searchInput: { flex: 1, color: Colors.text, fontSize: 14 },
  filterRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface },
  filterBtnActive: { borderColor: Colors.accent, backgroundColor: Colors.accentGlow },
  filterLabel: { color: Colors.textMuted, fontSize: 12, fontWeight: '600' },
  filterLabelActive: { color: Colors.accent },
  loraBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto', backgroundColor: Colors.greenDim, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  loraBadgeText: { color: Colors.green, fontSize: 11, fontWeight: '700' },
  loraBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, padding: 10, backgroundColor: Colors.greenDim, borderRadius: 8, borderWidth: 1, borderColor: Colors.green },
  loraBannerText: { color: Colors.green, fontSize: 12, fontWeight: '600' },
  list: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 40 },
  empty: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 24, gap: 12 },
  emptyTitle: { color: Colors.text, fontSize: 16, fontWeight: '700' },
  emptySubtitle: { color: Colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
});
