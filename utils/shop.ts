/**
 * utils/shop.ts — Marketplace MeshPay
 *
 * - Types: ShopProduct, ShopStall, ShopOrder, DeliveryForm
 * - NIP-15 event builders (kind 30017 stall, kind 30018 product)
 * - LoRa compact format (SHOP: prefix, ~60 bytes)
 * - Encrypted order DM format (NIP-44)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProductCategory = 'physical';

export interface DeliveryZone {
  id: string;
  name: string;          // ex: "France", "Europe", "Monde"
  costSats: number;
  regions: string[];     // codes pays ISO-3166
}

export interface ShopStall {
  id: string;                  // UUID unique
  ownerPubkey: string;         // Nostr pubkey hex
  name: string;
  description: string;
  currency: 'sat';
  shipping: DeliveryZone[];
  createdAt: number;
  isLoraLocal?: boolean;       // vu via LoRa mesh
}

export interface ShopProduct {
  id: string;                  // UUID unique
  stallId: string;
  sellerPubkey: string;
  name: string;
  description: string;
  priceSats: number;
  images: string[];            // URLs HTTPS
  category: ProductCategory;
  stock: number | null;        // null = stock illimité
  createdAt: number;
  isLoraLocal: boolean;        // vu via LoRa mesh (pas sur relais Nostr)
  eventId?: string;            // Nostr event id si publié
}

export interface DeliveryForm {
  name: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  phone?: string;
  notes?: string;
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type PaymentMethod = 'cashu' | 'lightning' | 'onchain';

export interface ShopOrder {
  id: string;
  productId: string;
  productName: string;
  stallId: string;
  sellerPubkey: string;
  buyerPubkey: string;
  priceSats: number;
  shippingSats: number;
  totalSats: number;
  delivery: DeliveryForm;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentRef: string | null;   // invoice BOLT11, txid, ou token Cashu
  isSale: boolean;             // true = je suis le vendeur
  createdAt: number;
  updatedAt: number;
  notes?: string;
}

// ─── NIP-15 Stall (kind 30017) ───────────────────────────────────────────────

export interface NIP15StallContent {
  id: string;
  name: string;
  description: string;
  currency: string;
  shipping: Array<{
    id: string;
    name: string;
    cost: number;
    regions: string[];
  }>;
}

export function buildStallEvent(stall: ShopStall): { kind: number; content: string; tags: string[][] } {
  const content: NIP15StallContent = {
    id: stall.id,
    name: stall.name,
    description: stall.description,
    currency: 'sat',
    shipping: stall.shipping.map((z) => ({
      id: z.id,
      name: z.name,
      cost: z.costSats,
      regions: z.regions,
    })),
  };

  return {
    kind: 30017,
    content: JSON.stringify(content),
    tags: [
      ['d', stall.id],
      ['name', stall.name],
    ],
  };
}

// ─── NIP-15 Product (kind 30018) ─────────────────────────────────────────────

export interface NIP15ProductContent {
  id: string;
  stall_id: string;
  name: string;
  description: string;
  images: string[];
  currency: string;
  price: number;
  quantity: number | null;
  shipping: Array<{ id: string; cost: number }>;
  categories: string[];
}

export function buildProductEvent(
  product: ShopProduct,
  stall: ShopStall,
): { kind: number; content: string; tags: string[][] } {
  const shipping = stall.shipping.map((z) => ({ id: z.id, cost: z.costSats }));

  const content: NIP15ProductContent = {
    id: product.id,
    stall_id: product.stallId,
    name: product.name,
    description: product.description,
    images: product.images,
    currency: 'sat',
    price: product.priceSats,
    quantity: product.stock,
    shipping,
    categories: [product.category],
  };

  return {
    kind: 30018,
    content: JSON.stringify(content),
    tags: [
      ['d', product.id],
      ['a', `30017:${product.sellerPubkey}:${product.stallId}`],
      ['name', product.name],
      ['price', String(product.priceSats), 'sat'],
    ],
  };
}

// ─── Order DM — chiffré NIP-44 ───────────────────────────────────────────────

export interface OrderDMPayload {
  type: 'order_request' | 'order_confirm' | 'order_status' | 'order_cancel';
  orderId: string;
  productId: string;
  productName: string;
  stallId: string;
  priceSats: number;
  shippingSats: number;
  totalSats: number;
  paymentMethod: PaymentMethod;
  paymentRef?: string;      // invoice BOLT11 ou adresse BTC (rempli par vendeur)
  delivery?: DeliveryForm;  // présent dans order_request
  status?: OrderStatus;
  notes?: string;
}

export function encodeOrderDM(payload: OrderDMPayload): string {
  return JSON.stringify({ meshpay_shop: 1, ...payload });
}

export function decodeOrderDM(raw: string): OrderDMPayload | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj.meshpay_shop || !obj.type || !obj.orderId) return null;
    return obj as OrderDMPayload;
  } catch {
    return null;
  }
}

// ─── LoRa compact format ─────────────────────────────────────────────────────
// Format : "SHOP:{"i":"id6","n":"Nom","p":5000,"s":"Boutique"}"
// Taille ~60-100 bytes — adapté LoRa SF12

export interface LoRaProductBroadcast {
  i: string;    // product id (6 chars)
  n: string;    // name (max 30 chars)
  p: number;    // price sats
  s: string;    // stall name (max 20 chars)
  pk: string;   // seller pubkey prefix (12 chars)
}

export const LORA_SHOP_PREFIX = 'SHOP:';

export function encodeLoRaProduct(product: ShopProduct, stallName: string): string {
  const payload: LoRaProductBroadcast = {
    i: product.id.slice(0, 8),
    n: product.name.slice(0, 30),
    p: product.priceSats,
    s: stallName.slice(0, 20),
    pk: product.sellerPubkey.slice(0, 12),
  };
  return LORA_SHOP_PREFIX + JSON.stringify(payload);
}

export function decodeLoRaProduct(raw: string): LoRaProductBroadcast | null {
  if (!raw.startsWith(LORA_SHOP_PREFIX)) return null;
  try {
    const obj = JSON.parse(raw.slice(LORA_SHOP_PREFIX.length));
    if (!obj.i || !obj.n || !obj.p || !obj.s || !obj.pk) return null;
    return obj as LoRaProductBroadcast;
  } catch {
    return null;
  }
}

export function loRaBroadcastToProduct(b: LoRaProductBroadcast): ShopProduct {
  return {
    id: b.i,
    stallId: b.pk,
    sellerPubkey: b.pk,
    name: b.n,
    description: '(Produit local LoRa — demandez au vendeur les détails)',
    priceSats: b.p,
    images: [],
    category: 'physical',
    stock: null,
    createdAt: Math.floor(Date.now() / 1000),
    isLoraLocal: true,
  };
}

// ─── NIP-15 event parsers ─────────────────────────────────────────────────────

export function parseNIP15Product(
  eventContent: string,
  sellerPubkey: string,
  eventId?: string,
): ShopProduct | null {
  try {
    const c = JSON.parse(eventContent) as NIP15ProductContent;
    if (!c.id || !c.name || !c.stall_id) return null;
    return {
      id: c.id,
      stallId: c.stall_id,
      sellerPubkey,
      name: c.name,
      description: c.description ?? '',
      priceSats: Math.round(Number(c.price) || 0),
      images: Array.isArray(c.images) ? c.images : [],
      category: 'physical',
      stock: c.quantity ?? null,
      createdAt: Math.floor(Date.now() / 1000),
      isLoraLocal: false,
      eventId,
    };
  } catch {
    return null;
  }
}

export function parseNIP15Stall(
  eventContent: string,
  ownerPubkey: string,
): ShopStall | null {
  try {
    const c = JSON.parse(eventContent) as NIP15StallContent;
    if (!c.id || !c.name) return null;
    return {
      id: c.id,
      ownerPubkey,
      name: c.name,
      description: c.description ?? '',
      currency: 'sat',
      shipping: (c.shipping ?? []).map((z) => ({
        id: z.id,
        name: z.name,
        costSats: Math.round(Number(z.cost) || 0),
        regions: z.regions ?? [],
      })),
      createdAt: Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export function formatSats(sats: number): string {
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sat`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(0)}k sat`;
  return `${sats} sat`;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'En attente de paiement',
  paid: 'Payé',
  processing: 'En préparation',
  shipped: 'Expédié',
  delivered: 'Livré',
  cancelled: 'Annulé',
};

export const ORDER_STATUS_COLOR: Record<OrderStatus, string> = {
  pending_payment: '#FBBF24',
  paid: '#4DACFF',
  processing: '#A78BFA',
  shipped: '#22D3EE',
  delivered: '#00D68F',
  cancelled: '#FF4757',
};
