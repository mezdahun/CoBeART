(function () {
  function init() {
    let frameEl = document.getElementById('fluidFrame');
    if (!frameEl) {
      frameEl = document.createElement('iframe');
      frameEl.id = 'fluidFrame';
      frameEl.src = '/fluid/index.html';
      frameEl.width = 960;
      frameEl.height = 540;
      frameEl.style.border = '0';
      frameEl.style.maxWidth = '100%';
      const host = document.getElementById('out')?.parentElement || document.body;
      host.appendChild(document.createElement('h2')).textContent = 'Fluid Simulation';
      host.appendChild(frameEl);
    }

    const socket = window.viewerSocket || io('/viewer', { transports: ['websocket'] });

    socket.on('connect', () => console.log('[fluid-bridge] socket connected', socket.id));
    socket.on('disconnect', () => console.log('[fluid-bridge] socket disconnected'));

    let fluidReady = true;
    const outbox = [];
    function flush() {
      while (outbox.length) frameEl.contentWindow.postMessage(outbox.shift(), '*');
    }
    function postToFluid(msg) {
      if (fluidReady) frameEl.contentWindow.postMessage(msg, '*');
      else outbox.push(msg);
    }

    let latestFrame = null; // Store the latest frame
    const bridgeFramerate = 240; // Target bridge framerate in Hz

    // Timer to send the latest frame at the bridge framerate
    setInterval(() => {
      if (latestFrame) {
        const list = Array.isArray(latestFrame.rigidbodies) ? latestFrame.rigidbodies : [];
        for (const rb of list) {
          const id = Number(rb.ID ?? rb.id ?? 0);
          const x = rb.x || 0;
          const y = rb.y || 0;
          const color = [1, 0.6, 0.2];
          postToFluid({ type: 'splat', id, x, y, color });
          console.log('[fluid-bridge] sent splat', { id, x, y });
        }
        latestFrame = null; // Clear the frame after sending
      }
    }, 1000 / bridgeFramerate);

    // Receive frames from the server and store the latest one
    socket.on('frame', (payload) => {
      if (payload) {
        console.log('[fluid-bridge] received frame', payload);
        latestFrame = payload; // Overwrite with the latest frame
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();