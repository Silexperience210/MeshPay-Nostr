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

const originalIndexContent = content;

content = content
  .replace(
    /import NodeJSSerialConnection from "\.\/connection\/nodejs_serial_connection\.js";/g,
    'const NodeJSSerialConnection = null;'
  )
  .replace(
    /import TCPConnection from "\.\/connection\/tcp_connection\.js";/g,
    'const TCPConnection = null;'
  )
  .replace(/\n\s*NodeJSSerialConnection,\s*/g, '\n')
  .replace(/\n\s*TCPConnection,\s*/g, '\n');

if (content !== originalIndexContent) {
  fs.writeFileSync(indexPath, content);
  console.log('[patch-meshcore] Patch index.js appliqué avec succès');
} else {
  console.log('[patch-meshcore] index.js déjà patché, skip');
}

const tcpPath = path.join(__dirname, '../node_modules/@liamcottle/meshcore.js/src/connection/tcp_connection.js');
if (fs.existsSync(tcpPath)) {
  const tcpContent = fs.readFileSync(tcpPath, 'utf8');
  const patchedTcpContent = '// PATCHED for React Native - net module not available\nexport default class TCPConnection { constructor() { throw new Error("TCPConnection is not supported in React Native"); } }\n';
  if (tcpContent !== patchedTcpContent) {
    fs.writeFileSync(tcpPath, patchedTcpContent);
    console.log('[patch-meshcore] Patch tcp_connection.js appliqué');
  } else {
    console.log('[patch-meshcore] tcp_connection.js déjà patché, skip');
  }
}

const nodejsSerialPath = path.join(__dirname, '../node_modules/@liamcottle/meshcore.js/src/connection/nodejs_serial_connection.js');
if (fs.existsSync(nodejsSerialPath)) {
  const nsContent = fs.readFileSync(nodejsSerialPath, 'utf8');
  const patchedNodeJsSerialContent = '// PATCHED for React Native - stream module not available\nexport default class NodeJSSerialConnection { constructor() { throw new Error("NodeJSSerialConnection is not supported in React Native"); } }\n';
  if (nsContent !== patchedNodeJsSerialContent) {
    fs.writeFileSync(nodejsSerialPath, patchedNodeJsSerialContent);
    console.log('[patch-meshcore] Patch nodejs_serial_connection.js appliqué');
  } else {
    console.log('[patch-meshcore] nodejs_serial_connection.js déjà patché, skip');
  }
}
