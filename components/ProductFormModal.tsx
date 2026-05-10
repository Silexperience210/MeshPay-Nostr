/**
 * ProductFormModal — Créer ou éditer un produit
 */
import React, { useState, useEffect, useCallback } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, Plus, Trash2, Package } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { type ShopProduct, generateId } from '@/utils/shop';
import { useShop } from '@/providers/ShopProvider';

interface ProductFormModalProps {
  visible: boolean;
  product: ShopProduct | null; // null = création
  onClose: () => void;
}

export default function ProductFormModal({ visible, product, onClose }: ProductFormModalProps) {
  const { saveProduct } = useShop();
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [stockStr, setStockStr] = useState('');
  const [unlimitedStock, setUnlimitedStock] = useState(true);
  const [images, setImages] = useState<string[]>([]);

  useEffect(() => {
    if (product) {
      setName(product.name);
      setDescription(product.description);
      setPriceStr(String(product.priceSats));
      setImages(product.images);
      setUnlimitedStock(product.stock === null);
      setStockStr(product.stock !== null ? String(product.stock) : '');
    } else {
      setName('');
      setDescription('');
      setPriceStr('');
      setStockStr('');
      setUnlimitedStock(true);
      setImages([]);
    }
  }, [product, visible]);

  const pickImage = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission refusée', 'Autorisez l\'accès à la galerie pour ajouter des photos');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: false,
    });
    if (!result.canceled && result.assets[0]) {
      const uri = result.assets[0].uri;
      // Les URIs locales fonctionnent en LoRa local mais pas sur Nostr
      // Pour Nostr, l'utilisateur doit utiliser une URL HTTPS publique
      if (!uri.startsWith('https://')) {
        Alert.alert(
          '⚠️ Image locale',
          'Cette image n\'est visible que sur votre appareil (LoRa local). Pour la publier sur Nostr, hébergez-la sur un serveur (ex: nostr.build, imgprxy) et collez l\'URL HTTPS.',
          [
            { text: 'Utiliser quand même', onPress: () => setImages((prev) => [...prev, uri]) },
            { text: 'Annuler', style: 'cancel' },
          ],
        );
      } else {
        setImages((prev) => [...prev, uri]);
      }
    }
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSave = useCallback(async () => {
    const priceSats = parseInt(priceStr, 10);
    if (!name.trim()) { Alert.alert('Champ manquant', 'Entrez un nom de produit'); return; }
    if (!description.trim()) { Alert.alert('Champ manquant', 'Entrez une description'); return; }
    if (!priceStr || isNaN(priceSats) || priceSats <= 0) { Alert.alert('Prix invalide', 'Entrez un prix en satoshis'); return; }

    setLoading(true);
    try {
      await saveProduct({
        id: product?.id ?? generateId(),
        name: name.trim(),
        description: description.trim(),
        priceSats,
        images,
        category: 'physical',
        stock: unlimitedStock ? null : (parseInt(stockStr, 10) || 0),
      });
      onClose();
    } catch (e: any) {
      Alert.alert('Erreur', e.message);
    } finally {
      setLoading(false);
    }
  }, [name, description, priceStr, stockStr, unlimitedStock, images, product, saveProduct, onClose]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Package size={18} color={Colors.accent} />
            <Text style={styles.title}>{product ? 'Modifier le produit' : 'Nouveau produit'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {/* Images */}
            <Text style={styles.label}>Photos du produit</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.imagesRow}>
              {images.map((uri, idx) => (
                <View key={idx} style={styles.imageThumb}>
                  <TouchableOpacity style={styles.removeImg} onPress={() => removeImage(idx)}>
                    <X size={12} color={Colors.white} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={styles.addImageBtn} onPress={pickImage}>
                <Camera size={22} color={Colors.accent} />
                <Text style={styles.addImageText}>Ajouter</Text>
              </TouchableOpacity>
            </ScrollView>

            {/* Nom */}
            <Field label="Nom du produit *" value={name} onChangeText={setName} placeholder="Raspberry Pi 5 4GB" />

            {/* Description */}
            <Field label="Description *" value={description} onChangeText={setDescription} placeholder="Décrivez votre produit en détail..." multiline />

            {/* Prix */}
            <Field label="Prix (satoshis) *" value={priceStr} onChangeText={setPriceStr} placeholder="5000" keyboardType="numeric" />

            {/* Stock */}
            <View style={styles.stockSection}>
              <Text style={styles.label}>Stock</Text>
              <TouchableOpacity
                style={styles.toggleRow}
                onPress={() => setUnlimitedStock((v) => !v)}
              >
                <View style={[styles.toggle, unlimitedStock && styles.toggleActive]} />
                <Text style={styles.toggleLabel}>Stock illimité</Text>
              </TouchableOpacity>
              {!unlimitedStock && (
                <Field label="Quantité disponible" value={stockStr} onChangeText={setStockStr} placeholder="10" keyboardType="numeric" />
              )}
            </View>

            {/* Save */}
            <TouchableOpacity
              style={[styles.saveBtn, loading && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator size="small" color={Colors.background} />
                : <Text style={styles.saveBtnText}>{product ? 'Enregistrer les modifications' : 'Créer le produit'}</Text>
              }
            </TouchableOpacity>

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
        numberOfLines={multiline ? 4 : 1}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  container: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '95%' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border },
  title: { flex: 1, color: Colors.text, fontSize: 16, fontWeight: '700' },
  body: { padding: 16 },
  label: { color: Colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  imagesRow: { marginBottom: 16 },
  imageThumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: Colors.surfaceHighlight, borderWidth: 1, borderColor: Colors.border, marginRight: 8, position: 'relative' },
  removeImg: { position: 'absolute', top: 4, right: 4, backgroundColor: Colors.red, borderRadius: 8, padding: 2 },
  addImageBtn: { width: 72, height: 72, borderRadius: 10, backgroundColor: Colors.surfaceHighlight, borderWidth: 1, borderColor: Colors.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 4 },
  addImageText: { color: Colors.accent, fontSize: 10, fontWeight: '600' },
  stockSection: { marginBottom: 12 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  toggle: { width: 36, height: 20, borderRadius: 10, backgroundColor: Colors.surfaceHighlight, borderWidth: 1, borderColor: Colors.border },
  toggleActive: { backgroundColor: Colors.accent },
  toggleLabel: { color: Colors.text, fontSize: 14 },
  saveBtn: { backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8, marginBottom: 32 },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: Colors.background, fontSize: 15, fontWeight: '700' },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 14 },
  label: { color: Colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  input: { backgroundColor: Colors.surfaceHighlight, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: 14, paddingHorizontal: 12, paddingVertical: 10 },
  inputMulti: { height: 90, textAlignVertical: 'top', paddingTop: 10 },
});
