/**
 * Exports des mocks pour les tests d'intégration Hermès Engine
 */

export { 
  createMockNostrClient, 
  createMockNostrClientWithConfig,
  type MockNostrClient 
} from './mockNostrClient';

export { 
  createMockBleClient, 
  createMockContact, 
  createMockContacts,
  createMockIncomingMessage,
  type MockBleClient 
} from './mockBleClient';
