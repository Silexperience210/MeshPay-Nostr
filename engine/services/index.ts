/**
 * Services - Couche métier de l'engine Hermès
 * 
 * Ces services fournissent une API de haut niveau pour les fonctionnalités
 * métier, utilisant Hermès Engine et EventStore comme infrastructure.
 */

export {
  MessageService,
  MessageServiceImpl,
  messageService,
  DirectMessage,
  ChannelMessage,
} from './MessageService';
