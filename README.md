# CoBeART
Audio-visual Art Project Using Spatial Augmented Reality

# Installation (Windows)
## Installing js application related dependencies
1.) Download and install Node.js with npm from https://nodejs.org/en/download/
2.) cd to the project application directory (CobeART/cobeart-app/)
3.) Run `npm install` to install the required packages

## Installing Python/OptiTrack related dependencies
1.) Download and install Python 3.8 or higher from https://www.python.org/downloads/
2.) Download and install OptiTrack SDK from https://v22.optitrack.com/downloads/
3.) Install the required Python packages by running `pip install -e .` in the python bridge directory (CobeART/cobeart)

# Running the Application
1.) Start the OptiTrack Motive software and ensure that the cameras are streaming data.
2.) Start the Python bridge by running `start-optitrack-client` 
3.) Start the js application by running `npm start` in the cobeart-app directory.

# How It Works

### Initialization and Data Flow Sequence

This project uses a Node.js-based Electron application to receive and visualize motion capture data from the OptiTrack system. Here is a high-level overview of the data flow:

1.  **Electron Main Process (`cobeart-app/electron/main.js`)**:
    *   The `npm start` command executes this script.
    *   An `express` server is created.
    *   Two Socket.IO namespaces are created: `/ingest` (for data input) and `/viewer` (for data output).
    *   A `BrowserWindow` is created, which loads its content from the local server's root URL (`/`).

2.  **Host Page (`cobeart-app/public/index.html`)**:
    *   The server serves this file in response to the `BrowserWindow`'s request.
    *   The HTML creates the basic page structure, including a debug display and an `<iframe>` element with the ID `fluidFrame`.
    *   It loads two key scripts: `/socket.io/socket.io.js` (the client library) and `/fluid-bridge.js`.

3.  **Simulation Iframe (`cobeart-app/public/fluid/index.html`)**:
    *   The `<iframe>` in the host page loads this file.
    *   This file, in turn, loads `/public/fluid/script.js`, which contains all the WebGL logic for the fluid simulation. The simulation starts running in its isolated environment.

4.  **Bridge Script (`cobeart-app/public/fluid-bridge.js`)**:
    *   After `index.html` has loaded, this script initializes.
    *   It connects to the `/viewer` Socket.IO namespace and starts listening for `frame` events from the server.
    *   It starts a high-frequency `setInterval` loop to check for new data and forward it.

5.  **Python Client (`cobeart/optitrackclient/start_client.py`)**:
    *   When the Python client is run, it connects to the `/ingest` Socket.IO namespace.
    *   It begins capturing data from the OptiTrack system and sending it as `frame` events to the server.

6.  **Live Data Flow**:
    *   `main.js` receives a `frame` on `/ingest`.
    *   It immediately broadcasts that `frame` to all clients on `/viewer`.
    *   `fluid-bridge.js` receives the `frame`, stores it, and its `setInterval` loop sends the data as a `splat` message to the `fluidFrame` `<iframe>`.
    *   `script.js` inside the iframe receives the `splat` message and updates the WebGL visualization.