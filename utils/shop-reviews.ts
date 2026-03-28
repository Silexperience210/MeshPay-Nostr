/**
 * utils/shop-reviews.ts — Système de réputation NIP-1985
 *
 * - Avis publiés comme events Nostr kind:1985 (label events)
 * - Rating 1-5 étoiles + commentaire
 * - Agrégation locale : score moyen par vendeur / produit
 * - Persistance AsyncStorage (cache local des avis)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NostrEvent } from 'nostr-tools';

const REVIEWS_CACHE_KEY = 'meshpay_shop_reviews';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShopReview {
  id: string;             // event id Nostr
  reviewerPubkey: string;
  sellerPubkey: string;
  productId: string;
  orderId?: string;
  rating: number;         // 1–5
  comment: string;
  createdAt: number;      // unix timestamp
}

export interface SellerReputation {
  pubkey: string;
  averageRating: number;   // 0–5
  totalReviews: number;
  distribution: number[];  // [1★, 2★, 3★, 4★, 5★]
}

export interface ProductReputation {
  productId: string;
  averageRating: number;
  totalReviews: number;
}

// ─── NIP-1985 event builder ───────────────────────────────────────────────────

/**
 * Construit un event NIP-1985 (kind:1985) pour un avis produit.
 *
 * Tags :
 *   ['L', 'meshpay/shop']              — namespace du label
 *   ['l', 'review', 'meshpay/shop']    — label
 *   ['p', sellerPubkey]                — vendeur évalué
 *   ['rating', '4', '5']              — note/max
 *   ['product', productId]             — produit concerné
 *   ['order', orderId]                 — commande liée (optionnel)
 */
export function buildReviewEvent(
  sellerPubkey: string,
  productId: string,
  rating: number,          // 1–5
  comment: string,
  orderId?: string,
): { kind: number; content: string; tags: string[][] } {
  const clampedRating = Math.max(1, Math.min(5, Math.round(rating)));
  const tags: string[][] = [
    ['L', 'meshpay/shop'],
    ['l', 'review', 'meshpay/shop'],
    ['p', sellerPubkey],
    ['rating', String(clampedRating), '5'],
    ['product', productId],
  ];
  if (orderId) tags.push(['order', orderId]);

  return {
    kind: 1985,
    content: comment.trim(),
    tags,
  };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseReviewEvent(event: NostrEvent): ShopReview | null {
  try {
    const tags = event.tags;
    const lTag = tags.find((t) => t[0] === 'l' && t[1] === 'review');
    if (!lTag) return null;

    const pTag = tags.find((t) => t[0] === 'p');
    const ratingTag = tags.find((t) => t[0] === 'rating');
    const productTag = tags.find((t) => t[0] === 'product');
    const orderTag = tags.find((t) => t[0] === 'order');

    if (!pTag || !ratingTag || !productTag) return null;

    const rating = parseInt(ratingTag[1], 10);
    if (isNaN(rating) || rating < 1 || rating > 5) return null;

    return {
      id: event.id,
      reviewerPubkey: event.pubkey,
      sellerPubkey: pTag[1],
      productId: productTag[1],
      orderId: orderTag?.[1],
      rating,
      comment: event.content,
      createdAt: event.created_at,
    };
  } catch {
    return null;
  }
}

// ─── Agrégation ───────────────────────────────────────────────────────────────

export function computeSellerReputation(
  reviews: ShopReview[],
  sellerPubkey: string,
): SellerReputation {
  const relevant = reviews.filter((r) => r.sellerPubkey === sellerPubkey);
  const distribution = [0, 0, 0, 0, 0]; // index 0 = 1★
  let total = 0;

  for (const r of relevant) {
    distribution[r.rating - 1]++;
    total += r.rating;
  }

  return {
    pubkey: sellerPubkey,
    averageRating: relevant.length > 0 ? total / relevant.length : 0,
    totalReviews: relevant.length,
    distribution,
  };
}

export function computeProductReputation(
  reviews: ShopReview[],
  productId: string,
): ProductReputation {
  const relevant = reviews.filter((r) => r.productId === productId);
  const total = relevant.reduce((sum, r) => sum + r.rating, 0);

  return {
    productId,
    averageRating: relevant.length > 0 ? total / relevant.length : 0,
    totalReviews: relevant.length,
  };
}

// ─── Persistance cache ────────────────────────────────────────────────────────

export async function loadCachedReviews(): Promise<ShopReview[]> {
  try {
    const raw = await AsyncStorage.getItem(REVIEWS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as ShopReview[]) : [];
  } catch {
    return [];
  }
}

export async function saveCachedReviews(reviews: ShopReview[]): Promise<void> {
  try {
    // Garder max 500 avis, les plus récents en premier
    const sorted = [...reviews].sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
    await AsyncStorage.setItem(REVIEWS_CACHE_KEY, JSON.stringify(sorted));
  } catch {}
}

// ─── Helpers affichage ────────────────────────────────────────────────────────

/** Retourne "⭐ 4.2 (18)" */
export function formatReputation(rep: SellerReputation | ProductReputation): string {
  if (rep.totalReviews === 0) return 'Aucun avis';
  return `⭐ ${rep.averageRating.toFixed(1)} (${rep.totalReviews})`;
}

/** Retourne les étoiles SVG-style en texte : "★★★★☆" */
export function starsDisplay(rating: number): string {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}
