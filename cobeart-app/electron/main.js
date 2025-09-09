// This file serves as the main entry point for the Electron application.
// It is responsible for two primary tasks:
// 1. Running a local web and WebSocket server to handle data from the OptiTrack system.
// 2. Creating a native desktop window (renderer process) that displays the front-end visualization.

const { app, BrowserWindow } = require('electron');
const path = require('path');

// The server is run directly within the main process (self-contained)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let server, io, PORT = 3000;

// Sets up and starts the integrated web server.
function startHttpServer() {
  const appx = express();
  server = http.createServer(appx);
  io = new Server(server, { cors: { origin: "*" } });

  // This line is the key that connects the server to the front-end.
  // It tells Express to serve all files from the 'public' directory statically.
  // When the BrowserWindow loads the server's URL, this allows 'index.html' to be found and served.
  appx.use(express.static(path.join(__dirname, '..', 'public')));

  let lastFrame = null;

  // STEP 2: The '/viewer' namespace, for sending data to the front-end.
  // On connection, immediately send the last known data frame to the new client.
  const viewer = io.of('/viewer');
  viewer.on('connection', (socket) => {
    if (lastFrame) socket.emit('frame', lastFrame);
  });

  // STEP 1: The '/ingest' namespace, for receiving data from the Python (OptiTrack) client.
  // Once a client connects, listen for 'frame' events on that connection, store the last frame,
  // and broadcast it to all current viewers for live updates.
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

// Creates and configures the main application window.
function createWindow() {
  const win = new BrowserWindow({
    width: 1050,
    height: 1050,
    useContentSize: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      // The preload script is a bridge between Electron's Node.js environment
      // and the sandboxed browser environment of the window, allowing for
      // secure, controlled communication.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // The window loads its content from the local server, just like a web browser.
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.__SOCKET_PORT__=${PORT}`);
  });
}

// Electron's initialization is asynchronous. This block executes once the app is ready.
app.whenReady().then(() => {
  startHttpServer();
  createWindow();

  // Handle macOS-specific behavior for re-creating a window.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Defines the application's behavior when all windows are closed.
app.on('window-all-closed', () => {
  // On Windows and Linux, quit the app. On macOS, apps typically stay running.
  if (process.platform !== 'darwin') {
    server?.close?.();
    app.quit();
  }
});