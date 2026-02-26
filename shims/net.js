// Shim for Node.js 'net' module - not available in React Native
// TCPConnection from meshcore.js is not used in mobile builds
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
