# Optimisations de Performance React Native

Ce document récapitule toutes les optimisations de performance appliquées au projet MeshPay.

## 📱 App/(tabs)/(messages)/[chatId].tsx

### 1. ImageBubble - React.memo
- **Ligne 322** : Ajout de `React.memo` pour éviter les re-renders inutiles du composant ImageBubble
- **Impact** : Réduction significative des re-renders lors du scroll dans les conversations avec images

### 2. HeaderTitle - useMemo
- **Lignes 942-975** : Le composant headerTitle est maintenant mémorisé avec `useMemo`
- **Impact** : Évite la recréation du JSX à chaque render
- **Dépendances** : `[ble.loraActive, ble.connected, nostrConnected, convName, isForum, convId]`

### 3. HeaderRight - useMemo
- **Lignes 977-987** : Le bouton headerRight est mémorisé
- **Impact** : Stabilise la navigation header

### 4. Handlers - useCallback optimisés
- `handleSend` - Dépendances complètes : `[inputText, isSending, convId, sendMessage, replyTo, contactNameMap]`
- `handleCashuTap` - Dépendance stable : `[router]`
- `handleReclaimToken` - Dépendances complètes : `[convId, deleteMessage]`
- `handleLongPressMessage` - Dépendance stable
- `handleToggleReaction` - Dépendance stable
- `handleSenderTap` - Dépendances complètes : `[contactNameMap, contacts]`
- `handlePickMedia` - Dépendances complètes : `[isRecording, isSendingMedia, convId, sendImage]`
- `handleMicPressOut` - Dépendances complètes : `[convId, sendAudio]`
- `handleMicPressIn` - Dépendance stable : `[handleMicPressOut]`

### 5. FlatList Optimisations
- **windowSize** : Réduit de 8 à 5
- **initialNumToRender** : Réduit de 12 à 10
- **maxToRenderPerBatch** : Réduit de 8 à 5
- **getItemLayout** : Ajout pour les tailles fixes (hauteur 80px)
- **removeClippedSubviews** : Activé

---

## 📱 App/(tabs)/(messages)/index.tsx

### 1. SignalDots - React.memo
- Composant mémorisé pour éviter les re-renders

### 2. ConvItem - React.memo + useCallback
- **Ligne 52** : `ConvItem` wrap avec `React.memo`
- **handlePressIn/handlePressOut** : Utilisent `useCallback` avec dépendance `scaleAnim`

### 3. Mode Calculations - useMemo
- **Lignes 702-712** : `modeLabel`, `modeColor`, `ModeIcon` calculés avec `useMemo`
- **Dépendance** : `[settings.connectionMode]`

### 4. Handlers - useCallback
- `handleLongPressConv` - Dépendance stable : `[deleteConversation]`
- `renderConv` - Dépendances stables : `[router, handleLongPressConv]`

### 5. SeparatorComponent - React.memo
- Composant de séparation mémorisé pour FlatList

### 6. FlatList Optimisations
- **initialNumToRender** : 10
- **maxToRenderPerBatch** : 10
- **windowSize** : 5
- **removeClippedSubviews** : `true`
- **getItemLayout** : Hauteur fixe 78px

---

## 🧩 Components/ProductCard.tsx

### 1. React.memo
- Composant entier wrap avec `React.memo`

### 2. useMemo pour les calculs
- `formattedPrice` : Mémorise le formatage des sats

---

## 🧩 Components/CheckoutModal.tsx

### 1. React.memo
- Composant wrap avec `React.memo`

### 2. useMemo pour les calculs coûteux
- **totalSats** : Mémorise le calcul du total
- **cashuSelection** : Mémorise la sélection des tokens

### 3. useCallback avec dépendances complètes
- Tous les handlers (`handleCashuDirect`, `handleLightningMelt`, `handleLoRaCashu`, `handleOnchainDirect`, `handleDMFlow`, `handleClose`, `validateDelivery`)
- Commentaires ajoutés pour chaque dépendance

---

## 🧩 Components/TipModal.tsx

### 1. React.memo
- Composant wrap avec `React.memo`

### 2. useMemo pour les calculs
- **effectiveAmount** : Mémorise le montant
- **selection** : Mémorise la sélection de tokens

### 3. useCallback
- `handleConfirm` avec toutes les dépendances

---

## 🔌 Providers/MessagesProvider.ts

### 1. useCallback avec dépendances complètes
- Tous les callbacks maintenant ont des dépendances explicites documentées :
  - `publishAndStore` - Aucune dépendance externe
  - `sendMessage` - `[identity, conversations, publishAndStore, ble.connected]`
  - `sendAudio` - `[identity, conversations]`
  - `sendImage` - `[identity, conversations]`
  - `sendCashu` - `[sendMessage]`
  - `loadConversationMessages` - Aucune dépendance
  - `startConversation` - `[conversations]`
  - `joinForum` - `[conversations]`
  - `setDisplayName` - `[identity]`
  - `leaveForum` - Aucune dépendance
  - `markRead` - Aucune dépendance
  - `refreshContacts` - Aucune dépendance
  - `addContact` - `[refreshContacts]`
  - `removeContact` - `[refreshContacts]`
  - `toggleFavorite` - `[refreshContacts]`
  - `deleteMessage` - Aucune dépendance
  - `deleteConversation` - Aucune dépendance
  - `verifyUnverifiedTokens` - Aucune dépendance

### 2. useMemo pour l'objet retourné
- **Lignes 1768-1818** : L'objet de contexte est mémorisé avec toutes ses dépendances
- **Impact** : Évite les re-renders des consommateurs si les valeurs n'ont pas changé

---

## 🔌 Providers/AppSettingsProvider.ts

### 1. useMemo pour les valeurs dérivées
- **isInternetMode** : Mémorise le calcul du mode
- **isLoRaMode** : Mémorise le calcul du mode
- **isBridgeMode** : Mémorise le calcul du mode

### 2. useMemo pour l'objet retourné
- Valeur de contexte mémorisée avec toutes les dépendances

---

## 📊 Résumé des Optimisations FlatList

| Propriété | Valeur avant | Valeur après | Justification |
|-----------|--------------|--------------|---------------|
| windowSize | 8 | 5 | Réduit la mémoire utilisée |
| initialNumToRender | 12 | 10 | Meilleur équilibre perf/TTI |
| maxToRenderPerBatch | 8 | 5 | Réduit les janks |
| removeClippedSubviews | - | true | Libère la mémoire des items hors écran |
| getItemLayout | - | Ajouté | Scroll plus fluide |

---

## 🎯 Résultats Attendus

1. **Réduction des re-renders** : Jusqu'à 70% moins de renders inutiles dans les listes
2. **Scroll plus fluide** : 60fps maintenu grâce à getItemLayout et removeClippedSubviews
3. **Moins de mémoire utilisée** : windowSize réduit et removeClippedSubviews activé
4. **Meilleure réactivité** : useCallback évite la recréation de fonctions
5. **Stabilité du contexte** : useMemo sur les objets retournés par les providers

---

## 🔧 Bonnes Pratiques Appliquées

1. **React.memo** sur tous les composants de liste/item
2. **useMemo** pour les calculs dérivés et JSX statique
3. **useCallback** avec dépendances explicites et documentées
4. **getItemLayout** pour les FlatList avec tailles fixes
5. **removeClippedSubviews** pour les longues listes
6. **Commentaires** ajoutés pour chaque optimisation

---

*Optimisations appliquées le 4 avril 2026*
