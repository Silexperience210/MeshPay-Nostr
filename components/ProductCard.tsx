/**
 * ProductCard — Carte produit marketplace
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Package, Radio, ShoppingCart } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { type ShopProduct, formatSats } from '@/utils/shop';
import { useShop } from '@/providers/ShopProvider';
import { starsDisplay } from '@/utils/shop-reviews';

interface ProductCardProps {
  product: ShopProduct;
  onPress: (product: ShopProduct) => void;
}

export default function ProductCard({ product, onPress }: ProductCardProps) {
  const { getProductReputation } = useShop();
  const rep = getProductReputation(product.id);
  const hasImage = product.images.length > 0;

  return (
    <TouchableOpacity style={styles.card} onPress={() => onPress(product)} activeOpacity={0.75}>
      {/* Image ou placeholder */}
      <View style={styles.imageContainer}>
        {hasImage ? (
          <Image source={{ uri: product.images[0] }} style={styles.image} resizeMode="cover" />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Package size={28} color={Colors.textMuted} />
          </View>
        )}
        {product.isLoraLocal && (
          <View style={styles.loraBadge}>
            <Radio size={10} color={Colors.green} />
            <Text style={styles.loraBadgeText}>LoRa</Text>
          </View>
        )}
      </View>

      {/* Infos */}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        <Text style={styles.description} numberOfLines={2}>{product.description}</Text>

        {rep.totalReviews > 0 && (
          <View style={styles.repRow}>
            <Text style={styles.repStars}>{starsDisplay(rep.averageRating)}</Text>
            <Text style={styles.repCount}>{rep.averageRating.toFixed(1)} ({rep.totalReviews})</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text style={styles.price}>{formatSats(product.priceSats)}</Text>
          <View style={styles.buyBtn}>
            <ShoppingCart size={14} color={Colors.accent} />
          </View>
        </View>

        {product.stock !== null && product.stock <= 5 && (
          <Text style={styles.stock}>
            {product.stock === 0 ? '❌ Rupture' : `⚠️ ${product.stock} restant(s)`}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    marginBottom: 12,
  },
  imageContainer: {
    position: 'relative',
    height: 140,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    flex: 1,
    backgroundColor: Colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loraBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.greenDim,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: Colors.green,
  },
  loraBadgeText: {
    color: Colors.green,
    fontSize: 10,
    fontWeight: '700',
  },
  info: {
    padding: 12,
  },
  name: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  description: {
    color: Colors.textMuted,
    fontSize: 12,
    marginBottom: 10,
    lineHeight: 17,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  price: {
    color: Colors.accent,
    fontSize: 16,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  buyBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: Colors.accentGlow,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  stock: {
    color: Colors.yellow,
    fontSize: 11,
    marginTop: 6,
    fontWeight: '600',
  },
  repRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  repStars: {
    color: Colors.yellow,
    fontSize: 12,
  },
  repCount: {
    color: Colors.textMuted,
    fontSize: 11,
  },
});
