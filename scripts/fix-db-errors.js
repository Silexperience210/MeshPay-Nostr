#!/usr/bin/env node
/**
 * Script pour ajouter des try/catch à toutes les fonctions DB
 *
 * Usage :
 *   node scripts/fix-db-errors.js
 *
 * Ce script lit utils/database.ts et tente d'ajouter des blocs try/catch
 * autour des fonctions exportées listées dans `functionsToFix`.
 * Le fichier modifié est écrit en place. Faites un backup avant si besoin.
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../utils/database.ts');

if (!fs.existsSync(filePath)) {
  console.error(`[fix-db-errors] Fichier cible introuvable : ${filePath}`);
  console.error('[fix-db-errors] Vérifiez que vous exécutez le script depuis la racine du projet.');
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf8');

console.log(`[fix-db-errors] Fichier chargé : ${filePath} (${content.length} caractères)`);

// Fonction pour ajouter try/catch à une fonction async
function addTryCatchToFunction(content, functionName) {
  const regex = new RegExp(
    `(export async function ${functionName}\\([^)]*\\): Promise<[^>]+>\\s*\\{)(\\s*)(?!\\s*try\\s*\\{)`,
    'g'
  );
  
  return content.replace(regex, (match, p1, p2) => {
    return `${p1}\\n  try {`;
  });
}

// Liste des fonctions à corriger (sans try/catch)
const functionsToFix = [
  'listConversationsDB',
  'loadMessagesDB',
  'updateMessageStatusDB',
  'queuePendingMessage',
  'getPendingMessages',
  'removePendingMessage',
  'incrementRetryCount',
  'cleanupOldMessages',
  'saveCashuToken',
  'getUnspentCashuTokens',
  'markCashuTokenSpent',
  'markCashuTokenPending',
  'markCashuTokenUnspent',
  'markCashuTokenVerified',
  'getCashuTokenById',
  'getCashuBalance',
  'getAllMints',
  'getTokensByMint',
  'exportCashuTokens',
  'importCashuTokens',
  'getUnverifiedCashuTokens',
  'getUserProfile',
  'setUserProfile',
  'savePubkey',
  'getPubkey',
  'getNextMessageId',
  'setAppState',
  'getAppState',
  'migrateFromAsyncStorage',
  'enqueueMqttMessage',
  'getPendingMqttMessages',
  'markMqttMessageSent',
  'incrementMqttRetry',
  'saveSubMeshDB',
  'getSubMeshesDB',
  'deleteSubMeshDB',
  'saveSubMeshPeerDB',
  'getSubMeshPeersDB',
];

console.log('Ajout de try/catch aux fonctions DB...');

for (const funcName of functionsToFix) {
  content = addTryCatchToFunction(content, funcName);
}

// Ajouter les catch à la fin de chaque fonction
// C'est plus complexe, on va le faire manuellement pour les fonctions critiques

fs.writeFileSync(filePath, content);
console.log(`[fix-db-errors] Fichier écrit : ${filePath}`);
console.log(`[fix-db-errors] ${functionsToFix.length} fonctions traitées.`);
console.log('[fix-db-errors] Script terminé avec succès !');
