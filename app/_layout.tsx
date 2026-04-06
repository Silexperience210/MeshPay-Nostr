// Polyfills pour React Native (doit être en premier)
import './polyfills';

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState, useRef } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, View, Text } from "react-native";
import Colors from "@/constants/colors";

// ─── Stores Zustand (nouveau) ────────────────────────────────────────────────
import { useWalletStore } from "@/stores/walletStore";
import { useSettingsStore } from "@/stores/settingsStore";

// ─── Providers compat Zustand ─────────────────────────────────────────────────
import { WalletSeedContext } from "@/providers/WalletSeedProvider";
import { AppSettingsContext } from "@/providers/AppSettingsProvider";

// ─── Providers restants ───────────────────────────────────────────────────────
import { BitcoinContext } from "@/providers/BitcoinProvider";
import { GatewayContext } from "@/providers/GatewayProvider";
import { MessagesContext } from "@/providers/MessagesProvider";
import { BleProvider } from "@/providers/BleProvider";
import { UsbSerialProvider } from "@/providers/UsbSerialProvider";
import { NostrContext } from "@/providers/NostrProvider";
import { MessagingBusContext } from "@/providers/MessagingBusProvider";
import { TxRelayContext } from "@/providers/TxRelayProvider";
import { RadarProvider } from "@/providers/RadarProvider";
import { ShopProvider } from "@/providers/ShopProvider";

// ─── Hermès Engine ────────────────────────────────────────────────────────────
// Hermès démarre uniquement après création d'identité (via UnifiedIdentityManager)
// pour éviter le double démarrage et les conflits

import { requestNotificationPermission, configureNotificationChannels, addNotificationResponseListener } from "@/utils/notifications";
import { router } from "expo-router";
import { WelcomeModal } from "@/components/WelcomeModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();
const ONBOARDING_KEY = 'BITMESH_ONBOARDING_DONE';

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerStyle: { backgroundColor: Colors.background },
        headerTintColor: Colors.text,
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
    </Stack>
  );
}

/**
 * Hook de synchronisation des stores
 */
function useStoreHydration() {
  const walletHydrated = useWalletStore((state) => state._hasHydrated);
  const settingsHydrated = useSettingsStore((state) => state._hasHydrated);
  
  return {
    isHydrated: walletHydrated && settingsHydrated,
    walletHydrated,
    settingsHydrated,
  };
}

function AppContent() {
  const { isHydrated } = useStoreHydration();
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    async function checkOnboarding() {
      try {
        const done = await AsyncStorage.getItem(ONBOARDING_KEY);
        const isDone = done === 'true';
        setOnboardingDone(isDone);
        if (!isDone) {
          setShowOnboarding(true);
        }
      } catch {
        setOnboardingDone(false);
        setShowOnboarding(true);
      }
    }
    checkOnboarding();
  }, []);

  useEffect(() => {
    if (isHydrated && onboardingDone !== null) {
      SplashScreen.hideAsync();
    }
  }, [isHydrated, onboardingDone]);

  useEffect(() => {
    requestNotificationPermission()
      .then(() => configureNotificationChannels())
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = addNotificationResponseListener((type, data) => {
      if (type === 'new_order' || type === 'order_status' || type === 'payment_info') {
        router.push('/(tabs)/shop/orders');
      } else if (type === 'forum_message' && data.channelName) {
        router.push(`/(tabs)/(messages)/${encodeURIComponent(`forum:${data.channelName}`)}`);
      }
    });
    return unsub;
  }, []);

  const handleOnboardingClose = async () => {
    setShowOnboarding(false);
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    setOnboardingDone(true);
  };

  // Écran de chargement pendant l'initialisation
  if (!isHydrated || onboardingDone === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background, padding: 20 }}>
        <ActivityIndicator size="large" color={Colors.tint} />
        <Text style={{ marginTop: 16, color: Colors.textMuted }}>
          Chargement...
        </Text>
      </View>
    );
  }

  return (
    <>
      <RootLayoutNav />
      <WelcomeModal visible={showOnboarding} onClose={handleOnboardingClose} />
    </>
  );
}

/**
 * Layout principal avec stores Zustand
 * 
 * Hermès Engine est démarré automatiquement par UnifiedIdentityManager
 * lors de la création/restauration d'une identité, pas au boot.
 */
export default function RootLayout() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <WalletSeedContext>
        <AppSettingsContext>
        <BitcoinContext>
          <NostrContext>
            <MessagingBusContext>
              <TxRelayContext>
                <BleProvider>
                  <UsbSerialProvider>
                    <GatewayContext>
                      <MessagesContext>
                        <RadarProvider>
                          <ShopProvider>
                            <GestureHandlerRootView style={{ flex: 1 }}>
                              <StatusBar style="light" />
                              <AppContent />
                            </GestureHandlerRootView>
                          </ShopProvider>
                        </RadarProvider>
                      </MessagesContext>
                    </GatewayContext>
                  </UsbSerialProvider>
                </BleProvider>
              </TxRelayContext>
            </MessagingBusContext>
          </NostrContext>
        </BitcoinContext>
        </AppSettingsContext>
        </WalletSeedContext>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
