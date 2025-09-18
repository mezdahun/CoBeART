(function () {
  function init() {
    // Finds the id=fluidFrame iframe element that was created in the index.html file,
    // and that holds the embedded fluid simulation.
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

    // Create the overlay element for logging
    let overlay = document.getElementById('textOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'textOverlay';
      overlay.style.position = 'absolute';
      overlay.style.top = `${frameEl.offsetTop}px`;
      overlay.style.left = `${frameEl.offsetLeft}px`;
      overlay.style.width = `${frameEl.offsetWidth}px`;
      overlay.style.height = `${frameEl.offsetHeight}px`;
      overlay.style.pointerEvents = 'none';
      overlay.style.color = 'white';
      overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.0)';
      overlay.style.fontFamily = 'monospace';
      overlay.style.fontSize = '12px';
      overlay.style.overflowY = 'auto';
      overlay.style.padding = '10px';
      document.body.appendChild(overlay);
    }

    // Connects to the /viewer namespace on the server hosted in electron/main.js
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
    let latestAudio = null; // Store the latest audio metrics
    const bridgeFramerate = 240; // Target bridge framerate in Hz

    // Receive frames emitted by the electron/main.js server and store the latest one
    socket.on('frame', (payload) => {
      if (payload) {
        console.log('[fluid-bridge] received frame', payload);
        latestFrame = payload; // Overwrite with the latest frame
        if (payload.audio && typeof payload.audio === 'object') {
          latestAudio = payload.audio;
        }
        showOverlay();
      }
    });


    // Update the overlay with the latest frame data
    function showOverlay() {
      if (latestFrame) {
        const list = Array.isArray(latestFrame.rigidbodies) ? latestFrame.rigidbodies : [];
        let overlayText = '';

        if (latestAudio) {
          const rms = Number(latestAudio.rms) || 0;
          const peak = Number(latestAudio.peak) || 0;
          const zcr = Number(latestAudio.zcr) || 0;
          const f0 = Number(latestAudio.dominant_frequency) || 0;
          overlayText += `Audio — RMS: ${rms.toFixed(4)} | Peak: ${peak.toFixed(4)} | ZCR: ${zcr.toFixed(4)} | f0: ${f0.toFixed(1)} Hz<br><br>`;
        }
        for (const rb of list) {
          const id = Number(rb.ID ?? rb.id ?? 0);
          const x = rb.x || 0;
          const y = rb.y || 0;
          const z = rb.z || 0;
          const vx = rb.vx || 0;
          const vy = rb.vy || 0;
          const vz = rb.vz || 0;
          const roll = rb.roll || 0;
          const pitch = rb.pitch || 0;
          const yaw = rb.yaw || 0;
          const vroll = rb.vroll || 0;
          const vpitch = rb.vpitch || 0;
          const vyaw = rb.vyaw || 0;
          const absVel = rb.abs_vel || 0;
          const normVel = rb.norm_abs_vel || 0;

          overlayText += `Splat ID: ${id}<br>
Position: (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})<br>
Velocity: (${vx.toFixed(2)}, ${vy.toFixed(2)}, ${vz.toFixed(2)})<br>
|V|: ${absVel.toFixed(2)} (norm: ${normVel.toFixed(2)})<br>
Rotation: (roll: ${roll.toFixed(2)}, pitch: ${pitch.toFixed(2)}, yaw: ${yaw.toFixed(2)})<br>
Angular Velocity: (vroll: ${vroll.toFixed(2)}, vpitch: ${vpitch.toFixed(2)}, vyaw: ${vyaw.toFixed(2)})<br><br>`;
        }
        console.log('[fluid-bridge] updating overlay', overlayText);
        overlay.innerHTML = overlayText; // Update the overlay text
      }
    };


    // Timer to send the latest frame at the bridge framerate
    // setInterval is a function that calls a function repeatedly at a fixed interval.
    setInterval(() => {
      if (latestFrame) {
        const list = Array.isArray(latestFrame.rigidbodies) ? latestFrame.rigidbodies : [];
        console.log('DEBUG: preparing to send splats', list);
        for (const rb of list) {
          const id = Number(rb.ID ?? rb.id ?? 0);
          const x = rb.x || 0;
          const y = rb.y || 0;
          const z = rb.z || 0;
          const vx = rb.vx || 0;
          const vy = rb.vy || 0;
          const vz = rb.vz || 0;
          const roll = rb.roll || 0;
          const pitch = rb.pitch || 0;
          const yaw = rb.yaw || 0;
          const vroll = rb.vroll || 0;
          const vpitch = rb.vpitch || 0;
          const vyaw = rb.vyaw || 0;
          const color = [1, 0.6, 0.2];
          const absVel = rb.abs_vel;
          const normVel = rb.norm_abs_vel;
          postToFluid({ type: 'splat', id, x, y, z, vx, vy, vz, roll, pitch, yaw, vroll, vpitch, vyaw, absVel, normVel, color });
          console.log('DEBUG: sent splat', absVel, normVel);
          //          const consoleMessage = `[fluid-bridge] sent splat id:${id} pos:(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) vel:(${vx.toFixed(2)}, ${vy.toFixed(2)}, ${vz.toFixed(2)})`;
          //          console.log('[fluid-bridge] sent splat', { id, x, y , z, vx, vy, vz, roll, pitch, yaw, vroll, vpitch, vyaw });
        }
        latestFrame = null; // Clear the frame after sending
      }
    }, 1000 / bridgeFramerate);
  }

  // This block instructs the browser to call the init function only once the DOM is fully loaded, 
  // such that the script does not reference elements that don't exist.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();









