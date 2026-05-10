/**
 * Setup file for integration tests
 */

// Set __DEV__ for tests (already declared in react-native globals.d.ts)
(global as any).__DEV__ = true;

// Silence console during tests unless debug mode
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeAll(() => {
  // Optionally suppress console output during tests
  // console.log = jest.fn();
  // console.error = jest.fn();
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});
