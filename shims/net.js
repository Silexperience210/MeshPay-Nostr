/**
 * ⚠️ AVERTISSEMENT - Shim incomplet
 * 
 * Ce fichier fournit un shim minimal pour le module Node.js 'net' qui n'existe
 * pas dans React Native. Seules les API les plus courantes sont implémentées.
 * 
 * Si vous rencontrez des erreurs du type "net.<something> is not a function",
 * c'est que le shim est incomplet et doit être étendu.
 * 
 * Pour l'étendre, ajoutez la fonction manquante ici en suivant le même pattern :
 *   <nomFonction>: function() {
 *     throw new Error('net.<nomFonction> is not available in React Native');
 *   },
 * 
 * OU si vous avez besoin d'une implémentation fonctionnelle, utilisez une
 * librairie comme 'react-native-tcp' (attention : peu de maintenance).
 */
module.exports = {
  Socket: function() {
    throw new Error('net.Socket is not available in React Native');
  },
  createConnection: function() {
    throw new Error('net.createConnection is not available in React Native');
  },
  createServer: function() {
    throw new Error('net.createServer is not available in React Native');
  },
};
