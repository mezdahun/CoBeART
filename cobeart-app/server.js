// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // fine for local dev
});

// Serve the demo page
app.use(express.static(path.join(__dirname, "public")));

let lastFrame = null;

// Namespace for Python → Node ingest
const ingest = io.of("/ingest");
ingest.on("connection", (socket) => {
  console.log("[ingest] client connected:", socket.id);

  socket.on("frame", (payload) => {
    // Optional: basic validation
    if (!payload || typeof payload !== "object") return;
    lastFrame = payload;

    // Fan-out to all viewers
    viewer.emit("frame", payload);
  });

  socket.on("disconnect", () =>
    console.log("[ingest] client disconnected:", socket.id)
  );
});

// Namespace for browser viewers
const viewer = io.of("/viewer");
viewer.on("connection", (socket) => {
  console.log("[viewer] client connected:", socket.id);
  if (lastFrame) socket.emit("frame", lastFrame);

  socket.on("disconnect", () =>
    console.log("[viewer] client disconnected:", socket.id)
  );
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
  console.log(`Viewer page → http://localhost:${PORT}/`);
});