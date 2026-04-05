/**
 * Setup Jest pour les tests MeshPay-Nostr
 * Ce fichier configure les mocks globaux pour les modules natifs
 */

// Mock expo-secure-store avec stockage en mémoire global
global.__SECURE_STORE_MOCK__ = new Map();
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn((key, value) => {
    global.__SECURE_STORE_MOCK__.set(key, value);
    return Promise.resolve();
  }),
  getItemAsync: jest.fn((key) => {
    const val = global.__SECURE_STORE_MOCK__.get(key);
    return Promise.resolve(val !== undefined ? val : null);
  }),
  deleteItemAsync: jest.fn((key) => {
    global.__SECURE_STORE_MOCK__.delete(key);
    return Promise.resolve();
  }),
}));

// Reset le mock entre les tests
beforeEach(() => {
  global.__SECURE_STORE_MOCK__.clear();
});

// Mock expo-sqlite
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(() => Promise.resolve({
    execAsync: jest.fn(() => Promise.resolve()),
    runAsync: jest.fn(() => Promise.resolve()),
    getAllAsync: jest.fn(() => Promise.resolve([])),
    getFirstAsync: jest.fn(() => Promise.resolve(null)),
    withTransactionAsync: jest.fn((fn) => fn()),
    closeAsync: jest.fn(() => Promise.resolve()),
  })),
  openDatabaseSync: jest.fn(() => ({
    execAsync: jest.fn(() => Promise.resolve()),
    runAsync: jest.fn(() => Promise.resolve()),
    getAllAsync: jest.fn(() => Promise.resolve([])),
    getFirstAsync: jest.fn(() => Promise.resolve(null)),
    withTransactionAsync: jest.fn((fn) => fn()),
    closeAsync: jest.fn(() => Promise.resolve()),
  })),
}));

// Mock expo-crypto
jest.mock('expo-crypto', () => ({
  getRandomValues: jest.fn((array) => {
    const crypto = require('crypto');
    const randomBytes = crypto.randomBytes(array.length);
    for (let i = 0; i < array.length; i++) {
      array[i] = randomBytes[i];
    }
    return array;
  }),
  digestStringAsync: jest.fn(() => Promise.resolve('mock-digest')),
  CryptoDigestAlgorithm: {
    SHA256: 'SHA-256',
  },
}));

// Mock expo-modules-core
jest.mock('expo-modules-core', () => ({
  EventEmitter: jest.fn(),
  NativeModulesProxy: {},
  requireNativeModule: jest.fn(() => ({})),
  requireOptionalNativeModule: jest.fn(() => null),
}));

// Silence console en tests sauf erreurs
const originalConsoleLog = console.log;
const originalConsoleDebug = console.debug;
const originalConsoleInfo = console.info;

global.console = {
  ...console,
  log: jest.fn((...args) => {
    if (process.env.DEBUG_TESTS) originalConsoleLog(...args);
  }),
  debug: jest.fn((...args) => {
    if (process.env.DEBUG_TESTS) originalConsoleDebug(...args);
  }),
  info: jest.fn((...args) => {
    if (process.env.DEBUG_TESTS) originalConsoleInfo(...args);
  }),
};

// Mock crypto.randomUUID pour les tests
global.crypto = {
  ...global.crypto,
  randomUUID: jest.fn(() => `mock-uuid-${Date.now()}-${Math.random()}`),
  getRandomValues: jest.fn((array) => {
    const nodeCrypto = require('crypto');
    const randomBytes = nodeCrypto.randomBytes(array.length);
    for (let i = 0; i < array.length; i++) {
      array[i] = randomBytes[i];
    }
    return array;
  }),
};

// Initialiser HermesEngine pour les tests
const { hermes } = require('./engine/HermesEngine');
hermes.start().catch(() => {}); // Démarrer silencieusement
