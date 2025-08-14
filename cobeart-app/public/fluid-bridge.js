(function () {
  function init() {
    // 1) Ensure the iframe exists
    let frameEl = document.getElementById('fluidFrame');
    if (!frameEl) {
      console.warn('[fluid-bridge] No #fluidFrame found; creating one…');
      frameEl = document.createElement('iframe');
      frameEl.id = 'fluidFrame';
      frameEl.src = '/fluid/index.html';  // adjust if needed
      frameEl.width = 960;
      frameEl.height = 540;
      frameEl.style.border = '0';
      frameEl.style.maxWidth = '100%';
      const host = document.getElementById('out')?.parentElement || document.body;
      host.appendChild(document.createElement('h2')).textContent = 'Fluid Simulation';
      host.appendChild(frameEl);
    }

    // 2) Use the same viewer socket if your page already created one (attach it to window!).
    // In index.html make sure to do:  window.viewerSocket = io('/viewer', { transports: ['websocket'] });
    const socket = window.viewerSocket || io('/viewer', { transports: ['websocket'] });

    socket.on('connect', () => console.log('[fluid-bridge] socket connected', socket.id));
    socket.on('disconnect', () => console.log('[fluid-bridge] socket disconnected'));

    // 3) Handshake state + queue
    let fluidReady = true;
    const outbox = [];
    function flush() {
      console.log('[fluid-bridge] flushing', outbox.length, 'queued message(s)');
      while (outbox.length) frameEl.contentWindow.postMessage(outbox.shift(), '*');
    }
    function postToFluid(msg) {
      if (fluidReady) frameEl.contentWindow.postMessage(msg, '*');
      else outbox.push(msg);
    }

//    // 4) Listen for fluid_ready
//    window.addEventListener('message', (ev) => {
//      if (ev.source !== frameEl.contentWindow) return;
//      const msg = ev.data;
//      if (msg && msg.type === 'fluid_ready') {
//        console.log('[fluid-bridge] iframe says fluid_ready');
//        fluidReady = true;
//        flush();
//      }
//    });

//    // 5) Ask iframe if it's ready; add a fallback if it never replies
//    frameEl.addEventListener('load', () => {
//      try {
//        frameEl.contentWindow.postMessage({ type: 'are_you_ready' }, '*');
//        console.log('[fluid-bridge] Sent are_you_ready to iframe');
//      } catch (e) {
//        console.warn('[fluid-bridge] could not post are_you_ready:', e);
//      }
//      // Fallback: if no reply in 500ms, assume ready and flush
//      setTimeout(() => {
//        if (!fluidReady) {
//          console.warn('[fluid-bridge] no fluid_ready reply; using fallback');
//          fluidReady = true;
//          flush();
//        }
//      }, 500);
//    });

    // 6) Receive frames from server and forward as splats
    socket.on('frame', (payload) => {
      // DEBUG: see if we get frames at all
      console.log('[fluid-bridge] frame rx:', payload);

      // If your payload doesn't contain type:'optitrack', drop this check.
      if (!payload /*|| payload.type !== 'optitrack'*/) return;

      const list = Array.isArray(payload.rigidbodies) ? payload.rigidbodies : [];
      for (const rb of list) {
        const id = Number(rb.ID ?? rb.id ?? 0);

        // If you don't have normalized coords yet, center it for now:
        const x = rb.x || 0;
        const y = rb.y || 0;
        const color = [1, 0.6, 0.2];


        postToFluid({ type: 'splat', id, x: x, y: y, color });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();