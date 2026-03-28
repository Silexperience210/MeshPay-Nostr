/**
 * ReviewModal — Laisser un avis 1-5 étoiles après livraison
 */
import React, { useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { X, Star } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import { type ShopOrder } from '@/utils/shop';
import { useShop } from '@/providers/ShopProvider';

interface ReviewModalProps {
  visible: boolean;
  order: ShopOrder | null;
  onClose: () => void;
}

export default function ReviewModal({ visible, order, onClose }: ReviewModalProps) {
  const { submitReview } = useShop();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);

  const handleStarPress = useCallback((star: number) => {
    setRating(star);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleClose = useCallback(() => {
    setRating(0);
    setComment('');
    setLoading(false);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (!order) return;
    if (rating === 0) {
      Alert.alert('Note manquante', 'Sélectionnez au moins 1 étoile');
      return;
    }
    setLoading(true);
    try {
      await submitReview(order, rating, comment);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      handleClose();
      Alert.alert('✅ Avis publié', 'Merci pour votre retour ! Votre avis est visible sur Nostr.');
    } catch (e: any) {
      Alert.alert('Erreur', e.message ?? 'Impossible de publier l\'avis');
    } finally {
      setLoading(false);
    }
  }, [order, rating, comment, submitReview, handleClose]);

  if (!order) return null;

  const LABELS = ['Très mauvais', 'Mauvais', 'Correct', 'Bien', 'Excellent !'];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Laisser un avis</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={styles.productName}>{order.productName}</Text>

          {/* Étoiles */}
          <View style={styles.starsRow}>
            {[1, 2, 3, 4, 5].map((star) => (
              <TouchableOpacity
                key={star}
                onPress={() => handleStarPress(star)}
                style={styles.starBtn}
                activeOpacity={0.7}
              >
                <Star
                  size={36}
                  color={star <= rating ? Colors.yellow : Colors.textMuted}
                  fill={star <= rating ? Colors.yellow : 'transparent'}
                />
              </TouchableOpacity>
            ))}
          </View>

          {rating > 0 && (
            <Text style={styles.ratingLabel}>{LABELS[rating - 1]}</Text>
          )}

          {/* Commentaire */}
          <Text style={styles.commentLabel}>Commentaire (optionnel)</Text>
          <TextInput
            style={styles.commentInput}
            value={comment}
            onChangeText={setComment}
            placeholder="Décrivez votre expérience avec ce vendeur..."
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={4}
            maxLength={500}
          />
          <Text style={styles.charCount}>{comment.length}/500</Text>

          {/* Boutons */}
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
              <Text style={styles.cancelText}>Annuler</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.submitBtn, (rating === 0 || loading) && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={rating === 0 || loading}
            >
              {loading
                ? <ActivityIndicator size="small" color={Colors.background} />
                : <Text style={styles.submitText}>Publier l'avis</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    padding: 24,
  },
  container: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  productName: {
    color: Colors.textMuted,
    fontSize: 13,
    marginBottom: 20,
  },
  starsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 10,
  },
  starBtn: {
    padding: 4,
  },
  ratingLabel: {
    color: Colors.yellow,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
  },
  commentLabel: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  commentInput: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    height: 100,
    textAlignVertical: 'top',
  },
  charCount: {
    color: Colors.textMuted,
    fontSize: 11,
    textAlign: 'right',
    marginTop: 4,
    marginBottom: 16,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  cancelText: {
    color: Colors.textMuted,
    fontWeight: '600',
  },
  submitBtn: {
    flex: 2,
    backgroundColor: Colors.yellow,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.4,
  },
  submitText: {
    color: Colors.background,
    fontWeight: '700',
    fontSize: 14,
  },
});
