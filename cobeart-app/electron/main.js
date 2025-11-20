// This file serves as the main entry point for the Electron application.
// It is responsible for two primary tasks:
// 1. Running a local web and WebSocket server to handle data from the OptiTrack system.
// 2. Creating a native desktop window (renderer process) that displays the front-end visualization.

const { app, BrowserWindow, dialog } = require('electron');
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
  let lastAudioData = null;

  // Health check endpoint
  appx.get('/health', (req, res) => {
    const audioAge = lastAudioData ? Date.now() - lastAudioData.timestamp : null;
    const frameAge = lastFrame ? Date.now() - lastFrame.timestamp : null;
    res.json({
      server: 'ok',
      namespaces: {
        ingest: io.of('/ingest').sockets.size,
        audio: io.of('/audio').sockets.size,
        viewer: io.of('/viewer').sockets.size
      },
      lastAudioAge: audioAge,
      lastFrameAge: frameAge
    });
  });

  // STEP 1a: The '/audio' namespace - dedicated channel for audio metrics only
  const audio = io.of('/audio');
  audio.on('connection', (socket) => {
    console.log('[electron] Client connected to /audio');

    // Audio metrics data - updates background state, doesn't drive emissions
    socket.on('audio_metrics', (audioData) => {
      // Enhanced validation
      if (!audioData || typeof audioData !== 'object') return;

      // Validate expected fields
      const requiredFields = ['rms', 'peak', 'zcr', 'dominant_frequency'];
      const hasAllFields = requiredFields.every(field =>
        typeof audioData[field] === 'number' && !isNaN(audioData[field])
      );

      if (!hasAllFields) {
        console.warn('[electron] Invalid audio_metrics payload:', audioData);
        return;
      }

      try {
        // Store latest audio data with timestamp
        lastAudioData = {
          ...audioData,
          timestamp: Date.now()
        };
      } catch (err) {
        console.error('[electron] Error processing audio_metrics:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log('[electron] Client disconnected from /audio');
    });
  });

  // STEP 2: The '/viewer' namespace, for sending data to the front-end.
  // On connection, immediately send the last known data frame to the new client.
  const viewer = io.of('/viewer');
  viewer.on('connection', (socket) => {
    if (lastFrame) socket.emit('frame', lastFrame);
  });

  // STEP 1b: The '/ingest' namespace - unified ingestion for all data sources (back-compat)
  // OptiTrack drives the frame rate, audio data is additive
  const ingest = io.of('/ingest');
  ingest.on('connection', (socket) => {
    console.log('[electron] Client connected to /ingest');

    // OptiTrack frame data - drives the emission rate
    socket.on('frame', (payload) => {
      if (!payload || typeof payload !== 'object') return;

      // Create combined frame with OptiTrack data + latest audio
      const combinedFrame = {
        ...payload,
        timestamp: Date.now()
      };

      // Add latest audio data if available
      if (lastAudioData) {
        combinedFrame.audio = lastAudioData;
      }

      lastFrame = combinedFrame;
      viewer.emit('frame', combinedFrame);
    });

    socket.on('disconnect', () => {
      console.log('[electron] Client disconnected from /ingest');
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[electron] HTTP server on http://127.0.0.1:${PORT}`);
  });
}

// Creates and configures the main application window.
function createWindow(shader, usePerfMode) {
  const win = new BrowserWindow({
    width: 1050,
    height: 1050,
    useContentSize: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false, // Don't show window until it's ready
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
  let url = `http://127.0.0.1:${PORT}/`;
  if (shader === 'molten') {
    url = `http://127.0.0.1:${PORT}/molten/`;
    if (usePerfMode) {
      url += '?performance=true';
    }
  } else if (shader === 'ink') {
    url = `http://127.0.0.1:${PORT}/ink/`;
  } else if (shader === 'mixed') {
    url = `http://127.0.0.1:${PORT}/composite/`;
  }
  // Wait for the window to be ready before opening DevTools and injecting variables
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.__SOCKET_PORT__=${PORT}`);

    // Show window once content is loaded to prevent GPU errors
    win.show();

    // Opening devtools breaks ink visualization
    // Only open devtools if shader is not 'ink', and do it after page load
    if (shader !== 'ink') {
      // Small delay to ensure page is fully initialized
      setTimeout(() => {
        win.webContents.openDevTools();
      }, 100);
    }
  });

  // Handle the case where the window is ready before content loads
  win.once('ready-to-show', () => {
    // Window is ready to be shown, but we'll wait for did-finish-load
  });

  win.loadURL(url);
}

// Electron's initialization is asynchronous. This block executes once the app is ready.
app.whenReady().then(() => {
  startHttpServer();

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Splat', 'Molten', 'Ink', 'Mixed'],
    defaultId: 0,
    title: 'Choose Visualization',
    message: 'Which visualization would you like to use?',
    detail: 'Splat: fluid simulation. Molten: reflective shader. Ink: Dark fluid with washed contours. Mixed: spatial blend.',
    checkboxLabel: 'Performance Mode (Molten only)',
    checkboxChecked: false
  });

  const shader = ['splat', 'molten', 'ink', 'mixed'][choice];
  const usePerfMode = choice.checkboxChecked;

  createWindow(shader, usePerfMode);

  // Handle macOS-specific behavior for re-creating a window.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(shader, usePerfMode);
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