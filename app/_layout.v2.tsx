/**
 * Layout v2 - Architecture Hermès Engine (Phase 4)
 * 
 * Ce layout utilise exclusivement Hermès Engine et les nouveaux hooks.
 * Remplace progressivement _layout.tsx legacy.
 * 
 * @version 2.0.0
 * @since v3.3.0
 */

import './polyfills';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, View, Text } from "react-native";
import Colors from "@/constants/colors";

// ─── Hermès Engine (nouveau) ──────────────────────────────────────────────────
import { 
  hermes, 
  EventType, 
  useHermes, 
  useNostrHermes, 
  useMessages, 
  useGateway,
  useUnifiedIdentity 
} from "@/engine";

// ─── Stores Zustand (conservés) ───────────────────────────────────────────────
import { useWalletStore } from "@/stores/walletStore";
import { useSettingsStore } from "@/stores/settingsStore";

// ─── Providers UI (sans logique métier) ───────────────────────────────────────
import { BleProvider } from "@/providers/BleProvider";
import { UsbSerialProvider } from "@/providers/UsbSerialProvider";
import { RadarProvider } from "@/providers/RadarProvider";
import { ShopProvider } from "@/providers/ShopProvider";

// ─── Composants ───────────────────────────────────────────────────────────────
import { WelcomeModal } from "@/components/WelcomeModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// ─── Notifications ────────────────────────────────────────────────────────────
import { 
  requestNotificationPermission, 
  configureNotificationChannels 
} from "@/utils/notifications";

SplashScreen.preventAutoHideAsync();
const queryClient = new QueryClient();
const ONBOARDING_KEY = 'BITMESH_ONBOARDING_DONE';

// ─── Hook d'initialisation Hermès ─────────────────────────────────────────────

function useHermesInitialization() {
  const [isReady, setIsReady] = useState(false);
  const { isHydrated: walletHydrated } = useWalletStore((s) => ({ isHydrated: s._hasHydrated }));
  const { isHydrated: settingsHydrated } = useSettingsStore((s) => ({ isHydrated: s._hasHydrated }));
  
  // Hooks Hermès
  const { isConnected: nostrConnected } = useNostrHermes();
  const { status: gatewayStatus } = useGateway();
  const { hasIdentity } = useUnifiedIdentity();

  useEffect(() => {
    async function init() {
      if (!walletHydrated || !settingsHydrated) return;
      
      // Démarrer Hermès Engine
      await hermes.start();
      
      setIsReady(true);
      
      if (__DEV__) {
        console.log('[Hermès] Engine initialized');
        console.log('[Hermès] Stats:', hermes.stats);
      }
    }
    
    init();
    
    return () => {
      hermes.stop().catch(console.error);
    };
  }, [walletHydrated, settingsHydrated]);

  return { 
    isReady, 
    nostrConnected, 
    gatewayRunning: gatewayStatus.isRunning,
    hasIdentity,
  };
}

// ─── Composant racine ─────────────────────────────────────────────────────────

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

// ─── Contenu principal ────────────────────────────────────────────────────────

function AppContent() {
  const { isReady, nostrConnected, gatewayRunning, hasIdentity } = useHermesInitialization();
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Check onboarding
  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((done) => {
        const isDone = done === 'true' || hasIdentity; // Skip si wallet existe
        setOnboardingDone(isDone);
        setShowOnboarding(!isDone);
      })
      .catch(() => {
        setOnboardingDone(false);
        setShowOnboarding(true);
      });
  }, [hasIdentity]);

  // Hide splash
  useEffect(() => {
    if (isReady && onboardingDone !== null) {
      SplashScreen.hideAsync();
    }
  }, [isReady, onboardingDone]);

  // Request notifications
  useEffect(() => {
    requestNotificationPermission()
      .then(() => configureNotificationChannels())
      .catch(() => {});
  }, []);

  const handleOnboardingClose = async () => {
    setShowOnboarding(false);
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    setOnboardingDone(true);
  };

  // Loading state
  if (!isReady || onboardingDone === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background }}>
        <ActivityIndicator size="large" color={Colors.tint} />
        <Text style={{ marginTop: 16, color: Colors.textMuted }}>
          Initialisation Hermès Engine...
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

// ─── Layout principal ─────────────────────────────────────────────────────────

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* Providers UI uniquement (pas de logique métier) */}
        <BleProvider>
          <UsbSerialProvider>
            <RadarProvider>
              <ShopProvider>
                <GestureHandlerRootView style={{ flex: 1 }}>
                  <StatusBar style="light" />
                  <AppContent />
                </GestureHandlerRootView>
              </ShopProvider>
            </RadarProvider>
          </UsbSerialProvider>
        </BleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
