// electron/preload.js
const { contextBridge } = require('electron');

// Placeholder Spout API. Wire these to a native sender in Phase 2.
contextBridge.exposeInMainWorld('spout', {
  init: async (name, width, height) => {
    console.log('[spout] init', { name, width, height });
    // TODO: call native addon here later
    return true;
  },
  sendBGRA: async (buffer, width, height) => {
    // buffer is a Uint8ClampedArray or Uint8Array with BGRA or RGBA data
    // TODO: forward to native addon
    return true;
  }
});