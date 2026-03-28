/**
 * ShopProvider — État global de la marketplace MeshPay
 *
 * - Ma boutique (stall + produits)
 * - Browse (produits Nostr + LoRa local)
 * - Commandes (achats + ventes)
 * - Broadcast LoRa + publication Nostr NIP-15
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNostr } from '@/providers/NostrProvider';
import { useBle } from '@/providers/BleProvider';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import { nostrClient } from '@/utils/nostr-client';
import {
  isChunkedMessage,
  decodeChunkHeader,
  createAssemblyState,
  addChunkToAssembly,
  assembleMessage,
  type ChunkAssemblyState,
} from '@/utils/chunking';
import {
  configureNotificationChannels,
  notifyNewOrder,
  notifyOrderStatus,
  notifyPaymentInfoReceived,
  notifyNewReview,
} from '@/utils/notifications';
import {
  type ShopReview,
  type SellerReputation,
  type ProductReputation,
  buildReviewEvent,
  parseReviewEvent,
  computeSellerReputation,
  computeProductReputation,
  loadCachedReviews,
  saveCachedReviews,
} from '@/utils/shop-reviews';
import {
  type ShopStall,
  type ShopProduct,
  type ShopOrder,
  type DeliveryForm,
  type DeliveryZone,
  type PaymentMethod,
  type OrderDMPayload,
  buildStallEvent,
  buildProductEvent,
  encodeOrderDM,
  decodeOrderDM,
  encodeLoRaProduct,
  decodeLoRaProduct,
  loRaBroadcastToProduct,
  decodeLoRaPayment,
  parseNIP15Product,
  parseNIP15Stall,
  generateId,
  LORA_SHOP_PREFIX,
  LORA_PAY_PREFIX,
} from '@/utils/shop';

// ─── Storage keys ─────────────────────────────────────────────────────────────

const STALL_KEY = 'meshpay_shop_stall';
const PRODUCTS_KEY = 'meshpay_shop_products';
const ORDERS_KEY = 'meshpay_shop_orders';
const BROWSE_CACHE_KEY = 'meshpay_browse_cache';

// ─── Context type ─────────────────────────────────────────────────────────────

interface ShopContextType {
  // Réputation & avis
  reviews: ShopReview[];
  getSellerReputation: (pubkey: string) => SellerReputation;
  getProductReputation: (productId: string) => ProductReputation;
  submitReview: (order: ShopOrder, rating: number, comment: string) => Promise<void>;
  fetchReviews: (sellerPubkey: string) => void;

  // Ma boutique
  myStall: ShopStall | null;
  myProducts: ShopProduct[];
  saveStall: (stall: Omit<ShopStall, 'ownerPubkey' | 'createdAt'>) => Promise<void>;
  saveProduct: (product: Omit<ShopProduct, 'sellerPubkey' | 'stallId' | 'createdAt' | 'isLoraLocal'>) => Promise<void>;
  removeProduct: (productId: string) => Promise<void>;
  publishToNostr: () => Promise<void>;
  broadcastLoRa: (product: ShopProduct) => Promise<void>;
  broadcastAllLoRa: () => Promise<void>;

  // Browse
  browseProducts: ShopProduct[];   // Nostr
  loraProducts: ShopProduct[];     // LoRa local
  isLoadingBrowse: boolean;
  refreshBrowse: () => void;
  /** Appelé par Mesh screen quand un message LoRa commence par SHOP: */
  receiveLoRaMessage: (text: string) => void;

  // Commandes
  orders: ShopOrder[];
  mySales: ShopOrder[];
  myPurchases: ShopOrder[];
  placeOrder: (
    product: ShopProduct,
    delivery: DeliveryForm,
    paymentMethod: PaymentMethod,
    shippingSats: number,
    directPayment?: { cashuToken?: string; txid?: string }, // paiement direct joint à la commande
  ) => Promise<ShopOrder>;
  confirmOrder: (orderId: string, paymentRef: string) => Promise<void>;
  updateOrderStatus: (orderId: string, status: ShopOrder['status'], notes?: string) => Promise<void>;
  cancelOrder: (orderId: string) => Promise<void>;
}

const ShopContext = createContext<ShopContextType | null>(null);

export function useShop(): ShopContextType {
  const ctx = useContext(ShopContext);
  if (!ctx) throw new Error('useShop must be used inside ShopProvider');
  return ctx;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function ShopProvider({ children }: { children: React.ReactNode }) {
  const { publish, publishDMSealed, publicKey } = useNostr();
  const ble = useBle();
  const { settings } = useAppSettings();
  const notificationsEnabled = settings.notifications;

  const [myStall, setMyStall] = useState<ShopStall | null>(null);
  const [myProducts, setMyProducts] = useState<ShopProduct[]>([]);
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [browseProducts, setBrowseProducts] = useState<ShopProduct[]>([]);
  const [loraProducts, setLoraProducts] = useState<ShopProduct[]>([]);
  const [isLoadingBrowse, setIsLoadingBrowse] = useState(false);
  const [reviews, setReviews] = useState<ShopReview[]>([]);
  const nostrSubRef = useRef<(() => void) | null>(null);
  const reviewSubRef = useRef<(() => void) | null>(null);
  // Assemblage des messages LoRa fragmentés (MCHK chunks)
  const chunkAssemblyRef = useRef<Map<string, ChunkAssemblyState>>(new Map());

  // publicKey = pubkey Nostr hex 64 chars (secp256k1) — requis pour DMs NIP-17 et tags Nostr
  // nodeId = identifiant MeshCore "MESH-XXXX" — NON utilisé ici car invalide comme pubkey Nostr
  const myPubkey = publicKey ?? '';

  // ─── Persistance ───────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const [stallRaw, productsRaw, ordersRaw, cachedReviews] = await Promise.all([
          AsyncStorage.getItem(STALL_KEY),
          AsyncStorage.getItem(PRODUCTS_KEY),
          AsyncStorage.getItem(ORDERS_KEY),
          loadCachedReviews(),
        ]);
        if (stallRaw) {
          const stall: ShopStall = JSON.parse(stallRaw);
          // Migration : corriger ownerPubkey si c'était le nodeId MeshCore (non-hex, < 64 chars)
          if (myPubkey && stall.ownerPubkey !== myPubkey && stall.ownerPubkey.length < 64) {
            stall.ownerPubkey = myPubkey;
            AsyncStorage.setItem(STALL_KEY, JSON.stringify(stall)).catch(() => {});
          }
          setMyStall(stall);
        }
        if (productsRaw) {
          let products: ShopProduct[] = JSON.parse(productsRaw);
          // Migration : corriger sellerPubkey si c'était le nodeId MeshCore (non-hex, < 64 chars)
          if (myPubkey) {
            const needsFix = products.some((p) => p.sellerPubkey.length < 64);
            if (needsFix) {
              products = products.map((p) =>
                p.sellerPubkey.length < 64 ? { ...p, sellerPubkey: myPubkey } : p,
              );
              AsyncStorage.setItem(PRODUCTS_KEY, JSON.stringify(products)).catch(() => {});
            }
          }
          setMyProducts(products);
        }
        if (ordersRaw) setOrders(JSON.parse(ordersRaw));
        if (cachedReviews.length > 0) setReviews(cachedReviews);
      } catch (e) {
        console.warn('[Shop] Erreur chargement:', e);
      }
      // Configurer les canaux Android
      configureNotificationChannels().catch(() => {});
    })();
  }, [myPubkey]);

  const persistOrders = useCallback(async (updated: ShopOrder[]) => {
    setOrders(updated);
    await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(updated));
  }, []);

  // ─── Réception d'un message LoRa avec préfixe SHOP: ─────────────────────
  // Appelé depuis Mesh screen ou tout composant qui reçoit des messages canal

  /** Traite un message LoRa complet (déjà assemblé ou court) */
  const processLoRaText = useCallback((text: string) => {
    // ── Produit broadcast SHOP: ───────────────────────────────────────────────
    if (text.startsWith(LORA_SHOP_PREFIX)) {
      const broadcast = decodeLoRaProduct(text);
      if (!broadcast) return;
      const product = loRaBroadcastToProduct(broadcast);
      setLoraProducts((prev) => {
        const filtered = prev.filter((p) => p.id !== product.id);
        return [product, ...filtered.slice(0, 49)];
      });
      return;
    }

    // ── Paiement LoRa Cashu PAY: (vendeur reçoit le token hors-ligne) ────────
    if (text.startsWith(LORA_PAY_PREFIX)) {
      const pay = decodeLoRaPayment(text);
      if (!pay) return;
      const newOrder: ShopOrder = {
        id: pay.o,
        productId: pay.p,
        productName: pay.n,
        stallId: myStall?.id ?? pay.p,
        sellerPubkey: myPubkey,
        buyerPubkey: 'lora-anonymous',
        priceSats: pay.s,
        shippingSats: 0,
        totalSats: pay.s,
        delivery: { name: 'LoRa (hors-ligne)', address: '', city: '', postalCode: '', country: '' },
        status: 'paid',
        paymentMethod: 'lora_cashu',
        paymentRef: pay.t,
        isSale: true,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        notes: 'Paiement Cashu reçu via LoRa mesh — à redempter quand réseau dispo',
      };
      setOrders((prev) => {
        if (prev.find((o) => o.id === newOrder.id)) return prev;
        const updated = [newOrder, ...prev];
        AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(updated)).catch(() => {});
        return updated;
      });
      notifyNewOrder(pay.n, 'LoRa (anonyme)', pay.s, notificationsEnabled).catch(() => {});
    }
  }, [myStall, myPubkey, notificationsEnabled]);

  /**
   * Point d'entrée pour les messages LoRa bruts.
   * Gère transparentement les messages fragmentés (MCHK) et directs (SHOP:, PAY:).
   */
  const receiveLoRaMessage = useCallback((text: string) => {
    // ── Messages fragmentés MCHK ─────────────────────────────────────────────
    if (isChunkedMessage(text)) {
      const header = decodeChunkHeader(text);
      if (!header) return;

      const assembly = chunkAssemblyRef.current;

      // Nettoyer les assemblages > 3 minutes (incomplets = perdus)
      const now = Date.now();
      for (const [id, state] of assembly.entries()) {
        if (now - state.timestamp > 3 * 60 * 1000) assembly.delete(id);
      }

      // Trouver ou créer l'état d'assemblage pour ce messageId
      let state = assembly.get(header.messageId);
      if (!state) {
        state = createAssemblyState(header);
        assembly.set(header.messageId, state);
      }

      // Format MCHK : "MCHK|version|msgId|idx/total|dataType|payload..."
      // → split par "|", les 5 premiers tokens sont le header, le reste est la payload
      const parts = text.split('|');
      const payload = parts.slice(5).join('|'); // rejoin avec | au cas où la payload en contiendrait
      const chunk = { header, payload, raw: text };
      state = addChunkToAssembly(state, chunk);
      assembly.set(header.messageId, state);

      // Si tous les chunks sont reçus → assembler et traiter
      if (state.isComplete) {
        const full = assembleMessage(state);
        assembly.delete(header.messageId);
        if (full) processLoRaText(full);
      }
      return;
    }

    // ── Message direct (court, pas fragmenté) ────────────────────────────────
    processLoRaText(text);
  }, [processLoRaText]);

  // Expiration des produits LoRa — supprimer ceux > 30 minutes sans update
  useEffect(() => {
    const interval = setInterval(() => {
      const threshold = Math.floor(Date.now() / 1000) - 30 * 60;
      setLoraProducts((prev) => prev.filter((p) => p.createdAt > threshold));
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // ─── Écoute DMs commandes entrants ───────────────────────────────────────

  useEffect(() => {
    if (!myPubkey) return;

    let unsub: (() => void) | undefined;
    try {
      unsub = nostrClient.subscribeDMsSealed((from, content) => {
        const payload = decodeOrderDM(content);
        if (!payload) return;
        handleIncomingOrderDM(from, payload);
      });
    } catch {
      // Keypair pas encore initialisée — sera re-tenté au prochain render
    }

    return () => unsub?.();
  }, [myPubkey]);

  const handleIncomingOrderDM = useCallback((fromPubkey: string, payload: OrderDMPayload) => {
    if (payload.type === 'order_request') {
      // Réception d'une commande (je suis vendeur)
      // Si le buyer a joint un paiement direct (token Cashu ou txid on-chain) →
      // la commande est déjà payée, on stocke la preuve de paiement.
      const directPaymentRef = payload.cashuToken ?? payload.paymentRef ?? null;
      const isPaidOnArrival = !!(payload.cashuToken || (payload.status === 'paid' && payload.paymentRef));

      const newOrder: ShopOrder = {
        id: payload.orderId,
        productId: payload.productId,
        productName: payload.productName,
        stallId: payload.stallId,
        sellerPubkey: myPubkey,
        buyerPubkey: fromPubkey,
        priceSats: payload.priceSats,
        shippingSats: payload.shippingSats,
        totalSats: payload.totalSats,
        delivery: payload.delivery!,
        status: isPaidOnArrival ? 'paid' : 'pending_payment',
        paymentMethod: payload.paymentMethod,
        paymentRef: directPaymentRef,
        isSale: true,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      setOrders((prev) => {
        if (prev.find((o) => o.id === newOrder.id)) return prev;
        const updated = [newOrder, ...prev];
        AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(updated)).catch(() => {});
        return updated;
      });
      // 🔔 Notifier le vendeur
      const buyerAlias = fromPubkey.slice(0, 8) + '...';
      notifyNewOrder(payload.productName, buyerAlias, payload.totalSats, notificationsEnabled).catch(() => {});

    } else if (payload.type === 'order_confirm' || payload.type === 'order_status') {
      // Mise à jour de statut (je suis acheteur)
      setOrders((prev) => {
        const updated = prev.map((o) =>
          o.id === payload.orderId
            ? {
                ...o,
                status: payload.status ?? o.status,
                paymentRef: payload.paymentRef ?? o.paymentRef,
                updatedAt: Math.floor(Date.now() / 1000),
                notes: payload.notes ?? o.notes,
              }
            : o,
        );
        AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(updated)).catch(() => {});
        return updated;
      });
      // 🔔 Notifier l'acheteur
      if (payload.type === 'order_confirm' && payload.paymentRef) {
        notifyPaymentInfoReceived(payload.productName, notificationsEnabled).catch(() => {});
      } else if (payload.status) {
        notifyOrderStatus(payload.productName, payload.status, notificationsEnabled).catch(() => {});
      }
    }
  }, [myPubkey, notificationsEnabled]);

  // ─── Gérer ma boutique ────────────────────────────────────────────────────

  const saveStall = useCallback(async (
    stallData: Omit<ShopStall, 'ownerPubkey' | 'createdAt'>,
  ) => {
    const stall: ShopStall = {
      ...stallData,
      ownerPubkey: myPubkey,
      createdAt: Math.floor(Date.now() / 1000),
    };
    setMyStall(stall);
    await AsyncStorage.setItem(STALL_KEY, JSON.stringify(stall));
  }, [myPubkey]);

  const saveProduct = useCallback(async (
    productData: Omit<ShopProduct, 'sellerPubkey' | 'stallId' | 'createdAt' | 'isLoraLocal'>,
  ) => {
    if (!myStall) throw new Error('Créez d\'abord votre boutique');
    const product: ShopProduct = {
      ...productData,
      stallId: myStall.id,
      sellerPubkey: myPubkey,
      createdAt: Math.floor(Date.now() / 1000),
      isLoraLocal: false,
    };
    setMyProducts((prev) => {
      const idx = prev.findIndex((p) => p.id === product.id);
      const updated = idx >= 0
        ? prev.map((p, i) => (i === idx ? product : p))
        : [product, ...prev];
      AsyncStorage.setItem(PRODUCTS_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  }, [myStall, myPubkey]);

  const removeProduct = useCallback(async (productId: string) => {
    setMyProducts((prev) => {
      const updated = prev.filter((p) => p.id !== productId);
      AsyncStorage.setItem(PRODUCTS_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  }, []);

  // ─── Publication Nostr NIP-15 ─────────────────────────────────────────────

  const publishToNostr = useCallback(async () => {
    if (!myStall) throw new Error('Boutique non configurée');
    await publish(buildStallEvent(myStall));
    for (const product of myProducts) {
      await publish(buildProductEvent(product, myStall));
    }
    // Mise à jour optimiste : ajoute immédiatement les propres produits dans le browse
    // avec les infos de paiement direct du stall
    setBrowseProducts((prev) => {
      const withoutOwn = prev.filter((p) => p.sellerPubkey !== myPubkey);
      const enriched = myProducts.map((p) => ({
        ...p,
        sellerLightningAddress: myStall?.lightningAddress,
        sellerBitcoinAddress: myStall?.bitcoinAddress,
      }));
      return [...enriched, ...withoutOwn];
    });
    // Rafraîchit depuis les relais après un court délai (laisse le temps au relay de traiter)
    setTimeout(() => refreshBrowse(), 1500);
  }, [myStall, myProducts, myPubkey, publish, refreshBrowse]);

  // ─── Broadcast LoRa ───────────────────────────────────────────────────────

  const broadcastLoRa = useCallback(async (product: ShopProduct) => {
    if (!ble.connected) throw new Error('Gateway LoRa non connecté');
    const stallName = myStall?.name ?? 'Ma boutique';
    const msg = encodeLoRaProduct(product, stallName);
    await ble.sendChannelMessage(msg);
  }, [ble, myStall]);

  const broadcastAllLoRa = useCallback(async () => {
    if (!ble.connected) throw new Error('Gateway LoRa non connecté');
    for (const product of myProducts) {
      await broadcastLoRa(product);
      // Petite pause entre broadcasts pour ne pas saturer LoRa
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, [myProducts, broadcastLoRa]);

  // ─── Browse Nostr ─────────────────────────────────────────────────────────

  // Chargement du cache browse au mount — affichage immédiat sans attendre Nostr
  useEffect(() => {
    AsyncStorage.getItem(BROWSE_CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        const cached: ShopProduct[] = JSON.parse(raw);
        if (cached.length > 0) setBrowseProducts(cached);
      })
      .catch(() => {});
  }, []);

  const refreshBrowse = useCallback(() => {
    setIsLoadingBrowse(true);
    nostrSubRef.current?.();

    const foundProducts = new Map<string, ShopProduct>();
    // stallId → stall — pour enrichir les produits avec les adresses de paiement du vendeur
    const foundStalls = new Map<string, { lightningAddress?: string; bitcoinAddress?: string }>();

    // Timeout de sécurité : si EOSE n'arrive jamais (relay mort, réseau lent),
    // on arrête le spinner après 15s pour ne pas bloquer le pull-to-refresh
    const safetyTimer = setTimeout(() => {
      setIsLoadingBrowse(false);
    }, 15_000);

    const flush = () => {
      // Enrichir les produits avec les infos de paiement du stall si disponibles
      const enriched = [...foundProducts.values()].map((p) => {
        const stall = foundStalls.get(p.stallId) ?? foundStalls.get(p.sellerPubkey);
        if (!stall) return p;
        return {
          ...p,
          sellerLightningAddress: p.sellerLightningAddress ?? stall.lightningAddress,
          sellerBitcoinAddress: p.sellerBitcoinAddress ?? stall.bitcoinAddress,
        };
      });
      setBrowseProducts(enriched);
      // Persister le cache pour affichage immédiat au prochain lancement
      AsyncStorage.setItem(BROWSE_CACHE_KEY, JSON.stringify(enriched)).catch(() => {});
    };

    const unsub = nostrClient.subscribe(
      [
        { kinds: [30018], limit: 100 },  // produits
        { kinds: [30017], limit: 100 },  // stalls (adresses paiement vendeurs)
      ],
      (event) => {
        if (event.kind === 30018) {
          const product = parseNIP15Product(event.content, event.pubkey, event.id);
          if (product) {
            foundProducts.set(product.id, product);
            flush();
          }
        } else if (event.kind === 30017) {
          const stall = parseNIP15Stall(event.content, event.pubkey);
          if (stall) {
            foundStalls.set(stall.id, {
              lightningAddress: stall.lightningAddress,
              bitcoinAddress: stall.bitcoinAddress,
            });
            // Re-enrichir les produits déjà trouvés
            flush();
          }
        }
      },
      () => {
        // EOSE reçu — relay a fini d'envoyer les events stockés
        clearTimeout(safetyTimer);
        flush();
        setIsLoadingBrowse(false);
      },
    );

    nostrSubRef.current = unsub;
  }, []);

  useEffect(() => {
    refreshBrowse();
    return () => nostrSubRef.current?.();
  }, []);

  // ─── Commandes ────────────────────────────────────────────────────────────

  const placeOrder = useCallback(async (
    product: ShopProduct,
    delivery: DeliveryForm,
    paymentMethod: PaymentMethod,
    shippingSats: number,
    directPayment?: { cashuToken?: string; txid?: string },
  ): Promise<ShopOrder> => {
    if (!myPubkey) throw new Error('Wallet requis pour passer une commande');

    const orderId = generateId();
    const totalSats = product.priceSats + shippingSats;

    // Paiement direct → statut 'paid' immédiatement
    // Paiement DM flow → 'pending_payment' (attente info vendeur)
    const isPaidNow = !!(directPayment?.cashuToken || directPayment?.txid);

    const order: ShopOrder = {
      id: orderId,
      productId: product.id,
      productName: product.name,
      stallId: product.stallId,
      sellerPubkey: product.sellerPubkey,
      buyerPubkey: myPubkey,
      priceSats: product.priceSats,
      shippingSats,
      totalSats,
      delivery,
      status: isPaidNow ? 'paid' : 'pending_payment',
      paymentMethod,
      paymentRef: directPayment?.txid ?? directPayment?.cashuToken ?? null,
      isSale: false,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };

    // Envoyer la commande chiffrée au vendeur en DM NIP-17
    const dmPayload: OrderDMPayload = {
      type: 'order_request',
      orderId,
      productId: product.id,
      productName: product.name,
      stallId: product.stallId,
      priceSats: product.priceSats,
      shippingSats,
      totalSats,
      paymentMethod,
      delivery,
      // Joindre le paiement direct si présent
      ...(directPayment?.cashuToken ? { cashuToken: directPayment.cashuToken } : {}),
      ...(directPayment?.txid ? { paymentRef: directPayment.txid, status: 'paid' } : {}),
    };

    await publishDMSealed(product.sellerPubkey, encodeOrderDM(dmPayload));

    const updated = [order, ...orders];
    await persistOrders(updated);
    return order;
  }, [myPubkey, orders, persistOrders, publishDMSealed]);

  const confirmOrder = useCallback(async (orderId: string, paymentRef: string) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Commande introuvable');

    const dmPayload: OrderDMPayload = {
      type: 'order_confirm',
      orderId,
      productId: order.productId,
      productName: order.productName,
      stallId: order.stallId,
      priceSats: order.priceSats,
      shippingSats: order.shippingSats,
      totalSats: order.totalSats,
      paymentMethod: order.paymentMethod,
      paymentRef,
      status: 'paid',
    };

    // Notifier l'autre partie
    const recipientPubkey = order.isSale ? order.buyerPubkey : order.sellerPubkey;
    await publishDMSealed(recipientPubkey, encodeOrderDM(dmPayload));

    const updated = orders.map((o) =>
      o.id === orderId
        ? { ...o, status: 'paid' as const, paymentRef, updatedAt: Math.floor(Date.now() / 1000) }
        : o,
    );
    await persistOrders(updated);
  }, [orders, persistOrders, publishDMSealed]);

  const updateOrderStatus = useCallback(async (
    orderId: string,
    status: ShopOrder['status'],
    notes?: string,
  ) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Commande introuvable');

    const dmPayload: OrderDMPayload = {
      type: 'order_status',
      orderId,
      productId: order.productId,
      productName: order.productName,
      stallId: order.stallId,
      priceSats: order.priceSats,
      shippingSats: order.shippingSats,
      totalSats: order.totalSats,
      paymentMethod: order.paymentMethod,
      status,
      notes,
    };

    const recipientPubkey = order.isSale ? order.buyerPubkey : order.sellerPubkey;
    await publishDMSealed(recipientPubkey, encodeOrderDM(dmPayload));

    const updated = orders.map((o) =>
      o.id === orderId
        ? { ...o, status, notes: notes ?? o.notes, updatedAt: Math.floor(Date.now() / 1000) }
        : o,
    );
    await persistOrders(updated);
  }, [orders, persistOrders, publishDMSealed]);

  const cancelOrder = useCallback(async (orderId: string) => {
    await updateOrderStatus(orderId, 'cancelled');
  }, [updateOrderStatus]);

  // ─── Réputation & Avis ─────────────────────────────────────────────────────

  const getSellerReputation = useCallback(
    (pubkey: string) => computeSellerReputation(reviews, pubkey),
    [reviews],
  );

  const getProductReputation = useCallback(
    (productId: string) => computeProductReputation(reviews, productId),
    [reviews],
  );

  const submitReview = useCallback(async (
    order: ShopOrder,
    rating: number,
    comment: string,
  ) => {
    const eventTemplate = buildReviewEvent(
      order.sellerPubkey,
      order.productId,
      rating,
      comment,
      order.id,
    );
    const event = await publish(eventTemplate);
    const review = parseReviewEvent(event);
    if (review) {
      setReviews((prev) => {
        const updated = [review, ...prev.filter((r) => r.id !== review.id)];
        saveCachedReviews(updated).catch(() => {});
        return updated;
      });
    }
  }, [publish]);

  /** Récupère les avis Nostr pour un vendeur donné et met à jour le cache */
  const fetchReviews = useCallback((sellerPubkey: string) => {
    reviewSubRef.current?.();
    const found: ShopReview[] = [];

    const unsub = nostrClient.subscribe(
      [{ kinds: [1985], '#p': [sellerPubkey], limit: 200 }],
      (event) => {
        const review = parseReviewEvent(event);
        if (review && !found.find((r) => r.id === review.id)) {
          found.push(review);
          setReviews((prev) => {
            const merged = [...prev.filter((r) => !found.find((f) => f.id === r.id)), ...found];
            saveCachedReviews(merged).catch(() => {});
            return merged;
          });
          // 🔔 Notifier si c'est un avis pour mes produits
          if (review.sellerPubkey === myPubkey) {
            notifyNewReview(review.productId, review.rating, notificationsEnabled).catch(() => {});
          }
        }
      },
    );
    reviewSubRef.current = unsub;
  }, [myPubkey, notificationsEnabled]);

  // Fetch des avis du vendeur connecté au démarrage
  useEffect(() => {
    if (myPubkey) fetchReviews(myPubkey);
    return () => reviewSubRef.current?.();
  }, [myPubkey]);

  const mySales = orders.filter((o) => o.isSale);
  const myPurchases = orders.filter((o) => !o.isSale);

  return (
    <ShopContext.Provider
      value={{
        reviews,
        getSellerReputation,
        getProductReputation,
        submitReview,
        fetchReviews,
        myStall,
        myProducts,
        saveStall,
        saveProduct,
        removeProduct,
        publishToNostr,
        broadcastLoRa,
        broadcastAllLoRa,
        browseProducts,
        loraProducts,
        isLoadingBrowse,
        refreshBrowse,
        receiveLoRaMessage,
        orders,
        mySales,
        myPurchases,
        placeOrder,
        confirmOrder,
        updateOrderStatus,
        cancelOrder,
      }}
    >
      {children}
    </ShopContext.Provider>
  );
}
