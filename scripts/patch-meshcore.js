#!/usr/bin/env node
/**
 * Patch meshcore.js pour React Native
 * Supprime les imports qui nécessitent des modules Node.js ('net', 'stream')
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '../node_modules/@liamcottle/meshcore.js/src/index.js');

if (!fs.existsSync(indexPath)) {
  console.log('[patch-meshcore] Fichier non trouvé, skip');
  process.exit(0);
}

let content = fs.readFileSync(indexPath, 'utf8');

// Vérifier si déjà patché
if (content.includes('// import NodeJSSerialConnection')) {
  console.log('[patch-meshcore] Déjà patché, skip');
  process.exit(0);
}

// Patcher NodeJSSerialConnection
content = content.replace(
  'import NodeJSSerialConnection from "./connection/nodejs_serial_connection.js";',
  '// import NodeJSSerialConnection from "./connection/nodejs_serial_connection.js"; // Commenté pour React Native (pas de module stream)\nconst NodeJSSerialConnection = null; // Fallback pour React Native'
);

content = content.replace(
  'NodeJSSerialConnection,',
  '// NodeJSSerialConnection, // Commenté pour React Native'
);

// Patcher TCPConnection (au cas où)
content = content.replace(
  'import TCPConnection from "./connection/tcp_connection.js";',
  '// import TCPConnection from "./connection/tcp_connection.js"; // Commenté pour React Native (pas de module net)\nconst TCPConnection = null; // Fallback pour React Native'
);

content = content.replace(
  /TCPConnection,(?!.*\/\/ Commenté)/,
  '// TCPConnection, // Commenté pour React Native'
);

fs.writeFileSync(indexPath, content);
console.log('[patch-meshcore] Patch index.js appliqué avec succès');

const tcpPath = path.join(__dirname, '../node_modules/@liamcottle/meshcore.js/src/connection/tcp_connection.js');
if (fs.existsSync(tcpPath)) {
  let tcpContent = fs.readFileSync(tcpPath, 'utf8');
  if (!tcpContent.includes('// PATCHED')) {
    tcpContent = '// PATCHED for React Native - net module not available\nexport default class TCPConnection { constructor() { throw new Error("TCPConnection is not supported in React Native"); } }\n';
    fs.writeFileSync(tcpPath, tcpContent);
    console.log('[patch-meshcore] Patch tcp_connection.js appliqué');
  }
}

const nodejsSerialPath = path.join(__dirname, '../node_modules/@liamcottle/meshcore.js/src/connection/nodejs_serial_connection.js');
if (fs.existsSync(nodejsSerialPath)) {
  let nsContent = fs.readFileSync(nodejsSerialPath, 'utf8');
  if (!nsContent.includes('// PATCHED')) {
    nsContent = '// PATCHED for React Native - stream module not available\nexport default class NodeJSSerialConnection { constructor() { throw new Error("NodeJSSerialConnection is not supported in React Native"); } }\n';
    fs.writeFileSync(nodejsSerialPath, nsContent);
    console.log('[patch-meshcore] Patch nodejs_serial_connection.js appliqué');
  }
}
