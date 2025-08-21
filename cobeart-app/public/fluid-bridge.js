(function () {
  function init() {
    // 1) Ensure the iframe exists
    let frameEl = document.getElementById('fluidFrame');
    console.warn('[fluid-bridge] init: looking for iframe', frameEl);
    if (!frameEl) {
    //  raising error
        console.error('[fluid-bridge] ERROR: no iframe found with id="fluidFrame"');
        return;
    }

    // 2) Use the same viewer socket if already created one (attach it to window!).
    // In index.html make sure to do:  window.viewerSocket = io('/viewer', { transports: ['websocket'] });
    const socket = window.viewerSocket || io('/viewer', { transports: ['websocket'] });

    socket.on('connect', () => console.log('[fluid-bridge] socket connected', socket.id));
    socket.on('disconnect', () => console.log('[fluid-bridge] socket disconnected'));

    // 6) Receive frames from server and forward as splats
    socket.on('frame', (payload) => {
      // Optional: basic validation
      console.debug('[fluid-bridge] received frame:', payload);

      // fetching raw data of rigid bodies
      const list = Array.isArray(payload.rigidbodies) ? payload.rigidbodies : [];
      for (const rb of list) {
        const id = Number(rb.ID ?? rb.id ?? 1);

        // extract position
        const x = rb.x || 0;
        const y = rb.y || 0;

        // Todo: calculate all derived metrics here and forward to visualizer
        // add splash color
        const color = [1, 0.6, 0.2];

        // post to fluid visualizer
        postToFluid({ type: 'splat', id, x: x, y: y, color });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();