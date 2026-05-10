/**
 * Shim vide pour modules Node.js non compatibles React Native
 * 
 * Ce fichier est utilisé par le resolver de Metro bundler lorsqu'un module
 * Node.js natif (comme 'net', 'stream', 'dgram', etc.) est requis par une
 * dépendance mais n'existe pas dans l'environnement React Native.
 * 
 * Configuration dans metro.config.js :
 *   extraNodeModules: {
 *     '<module_name>': path.resolve(__dirname, 'shims/empty.js'),
 *     ...
 *   }
 * 
 * Cela permet aux librairies qui importent ces modules (souvent pour des
 * fonctionnalités optionnelles côté serveur) de ne pas faire crasher le
 * bundler ou l'application au runtime.
 */
module.exports = {};
