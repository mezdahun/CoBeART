// electron/main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

// Bring in your existing server in-process
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let server, io, PORT = 3000;

function startHttpServer() {
  const appx = express();
  server = http.createServer(appx);
  io = new Server(server, { cors: { origin: "*" } });

  // Serve your existing static site
  appx.use(express.static(path.join(__dirname, '..', 'public')));

  // Socket.IO namespaces as in your prototype
  let lastFrame = null;

  const viewer = io.of('/viewer');
  viewer.on('connection', (socket) => {
    if (lastFrame) socket.emit('frame', lastFrame);
  });

  const ingest = io.of('/ingest');
  ingest.on('connection', (socket) => {
    socket.on('frame', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      lastFrame = payload;
      viewer.emit('frame', payload);
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[electron] HTTP server on http://127.0.0.1:${PORT}`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1050,
    height: 1050,
    useContentSize: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.on('did-finish-load', () => {
    // pass port to the page if you need it
    win.webContents.executeJavaScript(`window.__SOCKET_PORT__=${PORT}`);
  });
}

app.whenReady().then(() => {
  startHttpServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    server?.close?.();
    app.quit();
  }
});