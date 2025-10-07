// Composite shader for spatial, cursor-driven transitions between two inputs (fluid and molten)
// Usage:
//   const material = CompositeShader.createMaterial({
//       fluidTexture, moltenTexture, resolution: new THREE.Vector2(w, h)
//   });
//   // Update per frame:
//   material.uniforms.uTime.value = elapsedSeconds;
//   material.uniforms.uResolution.value.set(w, h);
//   material.uniforms.uCursor.value.set(cursorX, cursorY); // in [0,1]
//   // Optional: toggle dominant mode every 10s externally or let shader handle via uAutoCycle
//   material.uniforms.uAutoCycle.value = 1.0; // enable internal 10s cycle

/* global THREE */
(function (global) {
    const CompositeShader = {};

    const vertexShader = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    // Simple hash-based noise helpers for organic edge
    const fragmentShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uFluid;  // 0
        uniform sampler2D uMolten;  // 1
        uniform sampler2D uInk;  // 2

        uniform int uFrom;          // index: 0=Fluid, 1=Molten, 2=Ink
        uniform int uTo;            // index: 0=Fluid, 1=Molten, 2=Ink

        uniform vec2  uResolution;   // pixels
        uniform float uTime;          // seconds
        uniform vec2  uCursor;        // [0,1] with (0,0)=bottom-left in render space
        uniform int   uDominant;      // 0: fluid dominant (molten expands), 1: molten dominant (fluid expands)
        uniform float uEdgeSoftness;  // pixels
        uniform float uNoiseAmount;   // 0..1

        // Cursor path seeding
        #define MAX_SEEDS 64
        uniform int   uSeedCount;
        uniform vec3  uSeeds[MAX_SEEDS]; // xy in [0,1], z = birth time (seconds), z < 0 => inactive
        uniform float uSeedSpeed;   // growth speed as fraction of screen diagonal per second (e.g., 0.7)
        // Organic edge controls
        uniform float uCellScale;       // base cellular scale (e.g., 2.5)
        uniform float uWarpStrength;    // domain warp strength (e.g., 0.012)
        uniform float uOrganicStrength; // px amplitude added to edge (e.g., 40.0)
        // Asymmetric branching controls
        uniform float uBranchAmp;    // 0..1 amplitude of directional growth bias
        uniform float uBranchScale;  // scale for angular noise
        // Time-of-arrival friction controls
        uniform float uFrictionStrength; // 0..1 how much cellular field slows growth
        uniform float uAnisoStrength;    // 0..1 bias growth along cell gradients

        uniform float uAnimSeconds;  // how long the visual expansion lasts (e.g., 3.0)
        uniform float uFlipTime;     // absolute time (seconds) when the last flip started

        // Hash noise utilities
        float hash(vec2 p){
            float h = sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123;
            return -1.0 + 2.0 * fract(h);
        }
        // Avoid reserved/built-in name collisions in GLSL by using noise2d
        float noise2d(in vec2 p){
            vec2 i = floor(p);
            vec2 f = fract(p);
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        vec4 texByIndex(int idx, vec2 uv) {
            if (idx == 0) return texture2D(uFluid,  uv);
            if (idx == 1) return texture2D(uMolten, uv);
            if (idx == 2) return texture2D(uInk,    uv);
            return            texture2D(uInk,    uv);
        }

        float fbm(vec2 p){
            float v = 0.0;
            float a = 0.5;
            for(int i = 0; i < 4; i++){
                v += a * noise2d(p);
                p *= 2.0;
                a *= 0.5;
            }
            return v;
        }

        // Cellular noise (Worley-style, F1) for organic edges
        vec2 rand2(vec2 p){
            // Return random 0..1 vec2
            float n = sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123;
            return fract(vec2(n, n*1.2154));
        }
        float worley(vec2 p){
            vec2 ip = floor(p);
            vec2 fp = fract(p);
            float d = 1.0;
            for(int y=-1; y<=1; y++){
                for(int x=-1; x<=1; x++){
                    vec2 o = vec2(float(x), float(y));
                    vec2 r = rand2(ip + o);
                    vec2 diff = o + r - fp;
                    d = min(d, dot(diff, diff));
                }
            }
            return d; // squared distance (0..~2)
        }
        float cellular(vec2 p){
            // Normalize and invert to get cell ridges: higher near cell borders
            float f = worley(p);
            f = sqrt(f);
            f = 1.0 - clamp(f, 0.0, 1.0);
            return f;
        }

        void main() {
            vec2 uv = vUv;

            // Convert cursor from [0,1] to pixels in same space as uResolution
            vec2 cursorPx = vec2(uCursor.x * uResolution.x, uCursor.y * uResolution.y);
            vec2 fragPx   = vec2(uv.x * uResolution.x, uv.y * uResolution.y);

            // Use the JS-controlled uniform directly; no auto-cycling.
            int dominant = uDominant;

            float maxR = length(uResolution);

            // Domain-warped cellular pattern for organic frontier
            vec2 uvw = fragPx / uResolution.x; // roughly aspect-invariant
            vec2 warp = vec2(
                fbm(uvw * (uCellScale * 1.3) + vec2(0.0, uTime * 0.05)),
                fbm(uvw * (uCellScale * 1.1) + vec2(0.0, -uTime * 0.04))
            );
            uvw += (warp - 0.5) * uWarpStrength * uResolution.x;
            // Multi-scale cellular field
            float cellsCoarse = cellular(uvw * uCellScale + vec2(uTime * 0.02, -uTime * 0.015));
            float cellsFine   = cellular(uvw * (uCellScale * 3.0) + vec2(-uTime * 0.018, uTime * 0.021));
            float cells = mix(cellsCoarse, cellsFine, 0.4);
            float noisePx = (cells - 0.5) * uOrganicStrength;

            float softness = max(1.0, uEdgeSoftness);

            // Global cycle envelope to cap how far any seed can grow this cycle
            float tAnim = clamp((uTime - uFlipTime) / max(0.001, uAnimSeconds), 0.0, 1.0);
            float e = smoothstep(0.0, 1.0, tAnim);
            float capRadius = e * maxR;

            // Multi-seed union front: 1 outside, 0 inside any grown seed
            float unionFront = 1.0;
            if (uSeedCount > 0) {
                for (int i = 0; i < MAX_SEEDS; i++) {
                    if (i >= uSeedCount) break;
                    vec3 s = uSeeds[i];
                    if (s.z < 0.0) continue;
                    vec2 seedPx = vec2(s.x * uResolution.x, s.y * uResolution.y);
                    float age = max(0.0, uTime - s.z);
                    float radius = min(age * (uSeedSpeed * maxR), capRadius);
                    vec2 df = fragPx - seedPx;
                    float d = length(df);
                    // Directional branching: modulate effective radius by an angular noise field
                    vec2 dir = d > 0.0 ? df / d : vec2(1.0, 0.0);
                    float ang = atan(dir.y, dir.x); // [-pi, pi]
                    float a01 = ang * (0.15915494309) + 0.5; // map to [0,1]
                    float dirNoise = fbm(vec2(a01 * uBranchScale, 0.0) + uvw * 0.6 + vec2(uTime * 0.05, -uTime * 0.03));
                    float branchBias = (dirNoise - 0.5) * 2.0; // -1..1
                    float localRadius = radius * (1.0 + uBranchAmp * branchBias);
                    // Time-of-arrival friction: slow growth through high-cell areas and against gradients
                    float eps = 1.5 / uResolution.x;
                    float c0 = cells;
                    float cx = cellular((uvw + vec2(eps, 0.0)) * uCellScale);
                    float cy = cellular((uvw + vec2(0.0, eps)) * uCellScale);
                    vec2 grad = normalize(vec2(cx - c0, cy - c0) + 1e-6);
                    float along = dot(dir, grad); // -1..1
                    float friction = 1.0 + uFrictionStrength * (c0 - 0.5) * 2.0 - uAnisoStrength * along;
                    friction = max(0.2, friction);
                    float dEff = d * friction;
                    // Compare effective distance to local radius with organic edge offset
                    float edge = localRadius + noisePx;
                    float fi = smoothstep(edge - softness, edge + softness, dEff);
                    unionFront = min(unionFront, fi);
                }
            } else {
                // Fallback to single expanding front from current cursor (keeps previous UX if no seeds yet)
                float radius = capRadius;
                float d = length(fragPx - cursorPx);
                float edge = radius + noisePx;
                unionFront = smoothstep(edge - softness, edge + softness, d);
            }

            vec4 fromCol = texByIndex(uFrom, uv);
            vec4 toCol   = texByIndex(uTo,   uv);

            // Inside the front we reveal "to"; outside we keep "from".
            float w = 1.0 - unionFront;         // 0 outside, 1 inside
            w = clamp(w, 0.0, 1.0);

            gl_FragColor = mix(fromCol, toCol, w);
        }
    `;

    function createMaterial(options) {
        const opts = options || {};
        const MAX_SEEDS = 64;
        const seedArray = new Array(MAX_SEEDS).fill(0).map(() => new THREE.Vector3(-1, -1, -1));

        // Main parameters of the transition animation
        const uniforms = {
            uFluid:        { value: opts.fluidTexture || null }, // Texture for fluid layer
            uMolten:       { value: opts.moltenTexture || null }, // Texture for molten layer
            uInk:          { value: opts.inkTexture || null },    // Texture for ink layer
            uFrom:         { value: 0 }, // Which texture index is "from" (0=fluid,1=molten,2=ink)
            uTo:           { value: 0 }, // Which texture index is "to"   (0=fluid,1=molten,2=ink)
            uResolution:   { value: opts.resolution || new THREE.Vector2(1920, 1080) }, // Render resolution
            uTime:         { value: 0.0 }, // Animation time in seconds
            uCursor:       { value: new THREE.Vector2(0.5, 0.5) }, // Cursor position (normalized)
            uDominant:     { value: 0 }, // Which layer is currently dominant
            uEdgeSoftness: { value: 30.0 }, // Softness of the transition edge in pixels
            uNoiseAmount:  { value: 0.6 }, // Amount of noise in the edge
            uSeedCount:    { value: 0 }, // Number of active seeds for transition
            uSeeds:        { value: seedArray }, // Array of seed positions and birth times
            uSeedSpeed:    { value: 0.9 }, // Speed at which seeds expand
            uCellScale:       { value: 6.0 }, // Scale of cellular noise for organic edge
            uWarpStrength:    { value: 0.0 }, // Strength of domain warping
            uOrganicStrength: { value: 80.0 }, // Amplitude of organic edge distortion
            uBranchAmp:       { value: 0.0 }, // Amplitude of directional branching
            uBranchScale:     { value: 0.0 }, // Scale of angular noise for branching
            uFrictionStrength:{ value: 0.8 }, // Friction strength for seed growth
            uAnisoStrength:   { value: 0.0 }, // Anisotropy strength for growth direction
            uAnimSeconds:   { value: 3.0 }, // Duration of the visual expansion animation
            uFlipTime:     { value:  0.0}  // Time when the last flip started
        };

        return new THREE.ShaderMaterial({
            uniforms,
            vertexShader,
            fragmentShader,
            transparent: true
        });
    }

    CompositeShader.createMaterial = createMaterial;

    // Expose to global namespace
    global.CompositeShader = CompositeShader;

    // Helper to set iframe visibility if debug and interactive elements are desired
    function setFrameVisibility(frame, visible) {
        if (visible) {
          frame.style.opacity = '1';
          frame.style.pointerEvents = 'auto';
        } else {
          frame.style.opacity = '0';
          frame.style.pointerEvents = 'none';
        }
      }

      // Running on load
      window.addEventListener('load', function(){
        // Getting Elements
        const fluidFrame = document.getElementById('fluidFrame');
        const moltenFrame = document.getElementById('moltenFrame');
        const inkFrame = document.getElementById('inkFrame');

        // Sources and textures
        let fluidCanvas = null;
        let moltenCanvas = null;
        let inkCanvas = null;

        let fluidTex = null;
        let moltenTex = null;
        let inkTex = null;

        // Three.js state
        let renderer, scene, camera, mesh, material;
        let initialized = false;
        let start = performance.now();
        let cursor = { x: 0.5, y: 0.5 };

        // Transition gating state
        // If true, we not only use the canvas visualizations, but
        // we place in the whole index.html of the active one after the animation
        // SET TO FALSE FOR PRODUCTION, ONLY DEBUG, makes slight jump before transition
        let showInteractiveElements = true;

        // Seed mgmt and transition parameters
        let gateDominant = 0; // matches shader logic: 0 first half, 1 second half
        const frames = [fluidFrame, moltenFrame, inkFrame];
        let gateLastFlipTime = 0.0; // seconds
        let seedGateActive = false;
        let seedEndTime = 0.0; // absolute time when current transition seeding ends
        // Idle seed: we keep one seed position updated but marked inactive (z<0)
        let idleSeed = { x: 0.5, y: 0.5 };

        // Functional code upon packages on socket
        // Listening on viewer namespace
        const socket = window.viewerSocket || (window.io ? io('/viewer', { transports: ['websocket'] }) : null);

        // Arena size
        const arena = { x: 3000, y: 3000 };

        // Next seed position
        var nx = 0;
        var ny = 0;

        if (socket) {
            socket.on('frame', (payload) => {
            if (!payload || !payload.rigidbodies) return;

            // If you want the composite shader’s edge to grow from bodies,
            // keep seeding while the gate is active:
            const wantSeeds = seedGateActive;

            // Use the first body (if any) to drive the parent “cursor”
            // so molten reacts immediately; fluid receives splats for ALL bodies.
            let leftHandIndex = 0
            let rightHandIndex = 1
            // calculate euclidian distance between left hand and right hand
            if (payload.rigidbodies.length >= 2) {
                const lh = payload.rigidbodies[leftHandIndex];
                const rh = payload.rigidbodies[rightHandIndex];
                const dx = lh.x - rh.x;
                const dy = lh.y - rh.y;
                const dist = Math.sqrt(dx*dx + dy*dy);

                // If hands are close together, use their midpoint as cursor and always switch to fluid
                if (dist < 200 && lh.z < 2700 && rh.z < 2700) {
                    console.log('Clapping hands detected, using midpoint for cursor');
                    // Initiating transition to molten
                    if (gateDominant !== 0) {
                        triggerTransition(0);
                    }

                    nx = (- (lh.x + rh.x) / 2 + arena.x) / (2 * arena.x);
                    ny = ( (lh.y + rh.y) / 2 + arena.y) / (2 * arena.y);

                    if (wantSeeds) {
                        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1){
                            if (seedGateActive) addSeed(nx, 1-ny);
                        };
                    }
                }

                // if left hand above 2500 in z, switch to molten and keep cursor on left hand
                else if (lh.z > 2700) {
                    // Initiating transition to molten
                    if (gateDominant !== 1) {
                        triggerTransition(1);
                    }

                    nx = (-lh.x + arena.x) / (2 * arena.x);
                    ny = ( lh.y + arena.y) / (2 * arena.y);

                    if (wantSeeds) {
                        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1){
                            if (seedGateActive) addSeed(nx, 1-ny);
                        };
                    }
                }

                // if right hand above 2500 in z, switch to ink and keep cursor on right hand
                else if (rh.z > 2700) {
                    // Initiating transition to ink
                    if (gateDominant !== 2) {
                        triggerTransition(2);
                    }

                    nx = (-rh.x + arena.x) / (2 * arena.x);
                    ny = ( rh.y + arena.y) / (2 * arena.y);

                    if (wantSeeds) {
                        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1){
                            if (seedGateActive) addSeed(nx, 1-ny);
                        };
                    }
                }

            }

//            for (const rb of payload.rigidbodies) {
//
//                // TODO: divide on which rigid body to track for the transition animation and when to trigger
//                nx = (-rb.x + arena.x) / (2 * arena.x);
//                ny = ( rb.y + arena.y) / (2 * arena.y);
//                console.log(`rb ${rb.ID} pos ${rb.x.toFixed(1)},${rb.y.toFixed(1)} => norm ${nx.toFixed(2)},${ny.toFixed(2)}`);
//
//                // For the transition animation we add seeds at the body position so that the
//                // transition keeps following the tracked object
//                if (wantSeeds) {
//                    if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1){
//                        if (seedGateActive) addSeed(nx, 1-ny);
//                    };
//                }
//            }
            });
        }

        function makeFallbackTexture(hex) {
            const c = new THREE.Color(hex);
            const data = new Uint8Array([
            Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255
            ]);
            const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
            tex.needsUpdate = true;
            tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
            return tex;
        }

        function initThree() {
            renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(window.innerWidth, window.innerHeight);
            document.body.appendChild(renderer.domElement);

            camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            scene = new THREE.Scene();
            const plane = new THREE.PlaneBufferGeometry(2, 2);

            const res = new THREE.Vector2();
            renderer.getDrawingBufferSize(res);

            material = CompositeShader.createMaterial({
            fluidTexture: makeFallbackTexture(0x2244ff),
            moltenTexture: makeFallbackTexture(0xff6600),
            inkTexture: makeFallbackTexture(0x000000),
            resolution: res
            });

            mesh = new THREE.Mesh(plane, material);
            scene.add(mesh);
            initialized = true;

            window.addEventListener('resize', onResize);
            sizeIframes();

            // Initialize dominant shader
            gateDominant = material.uniforms.uDominant.value;
        }

        function onResize() {
            if (!initialized) return;
            renderer.setSize(window.innerWidth, window.innerHeight);
            const size = new THREE.Vector2();
            renderer.getDrawingBufferSize(size);
            material.uniforms.uResolution.value.copy(size);
            sizeIframes();
        }

        function sizeIframes() {
            const w = window.innerWidth;
            const h = window.innerHeight;
            // Set both element attributes and CSS to ensure contentWindow size
            [fluidFrame, moltenFrame, inkFrame].forEach(f => {
            if (!f) return;
            f.width = w;
            f.height = h;
            f.style.width = w + 'px';
            f.style.height = h + 'px';
            });
        }

        function tryBindSources() {
            try {
            if (!fluidCanvas && fluidFrame.contentWindow && fluidFrame.contentDocument) {
                const canvases = fluidFrame.contentDocument.getElementsByTagName('canvas');
                if (canvases && canvases.length) fluidCanvas = canvases[0];
            }
            } catch (e) {}

            try {
            if (!moltenCanvas && moltenFrame.contentWindow && moltenFrame.contentDocument) {
                const canvases = moltenFrame.contentDocument.getElementsByTagName('canvas');
                if (canvases && canvases.length) moltenCanvas = canvases[0];
            }
            } catch (e) {}

            try {
              if (!inkCanvas && inkFrame.contentWindow && inkFrame.contentDocument) {
                const canvases = inkFrame.contentDocument.getElementsByTagName('canvas');
                if (canvases && canvases.length) inkCanvas = canvases[0];   // ink/index.html uses <canvas id="gl-canvas">. :contentReference[oaicite:1]{index=1}
              }
            } catch (e) {}

            if (fluidCanvas && !fluidTex) {
            fluidTex = new THREE.CanvasTexture(fluidCanvas);
            fluidTex.minFilter = THREE.LinearFilter;
            fluidTex.magFilter = THREE.LinearFilter;
            material.uniforms.uFluid.value = fluidTex;
            }
            if (moltenCanvas && !moltenTex) {
            moltenTex = new THREE.CanvasTexture(moltenCanvas);
            moltenTex.minFilter = THREE.LinearFilter;
            moltenTex.magFilter = THREE.LinearFilter;
            material.uniforms.uMolten.value = moltenTex;
            }
            if (inkCanvas && !inkTex) {
              inkTex = new THREE.CanvasTexture(inkCanvas);
              inkTex.minFilter = THREE.LinearFilter;
              inkTex.magFilter = THREE.LinearFilter;
              material.uniforms.uInk.value = inkTex; // see shader/uniforms below
            }

            attachKeysToIframe(fluidFrame);
            attachKeysToIframe(moltenFrame);
            attachKeysToIframe(inkFrame);
        }


        function triggerTransition(toIndex) {
          if (!initialized) return;
          if (toIndex === gateDominant) return;

          // Hide the currently visible iframe so the shader transition is visible
          setFrameVisibility(frames[gateDominant], false);
//          setFrameVisibility(frames[gateDominant], true);
//          setFrameVisibility(frames[toIndex], true);

          // Configure shader for a from→to transition
          const t = material.uniforms.uTime.value;
          material.uniforms.uFrom.value = gateDominant; // previous
          material.uniforms.uTo.value   = toIndex;      // target
          material.uniforms.uFlipTime.value = t;

          gateDominant = toIndex;

          // Seed window + schedule end
          startTransitionSeeds(t);
          seedEndTime = t + material.uniforms.uAnimSeconds.value;
        }

        // One handler function we can attach everywhere (parent + iframes)
        function onKeyAnyDoc(event) {
          const k = event.key;
          if (k === '0' || k === '1' || k === '2') {
            event.preventDefault();
            triggerTransition(parseInt(k, 10)); // 0=fluid, 1=molten, 2=ink
          }
        }

        // Attach to parent window, parent document, and the WebGL canvas
        function installParentKeyHandlers() {
          window.addEventListener('keydown', onKeyAnyDoc, true);
          document.addEventListener('keydown', onKeyAnyDoc, true);
          if (renderer && renderer.domElement) {
            renderer.domElement.setAttribute('tabindex', '0'); // ensure it can hold focus
            renderer.domElement.addEventListener('keydown', onKeyAnyDoc, true);
          }
        }

        // Attach to an iframe's inner window & document (same-origin)
        function attachKeysToIframe(frame) {
          try {
            const cw = frame && frame.contentWindow;
            const cd = frame && frame.contentDocument;
            if (!cw || !cd) return;
            if (cw.__keysAttached) return;      // avoid duplicates
            cw.addEventListener('keydown', onKeyAnyDoc, true);
            cd.addEventListener('keydown', onKeyAnyDoc, true);
            cw.__keysAttached = true;
            // Optional: also forward focus back to parent on Escape
            cd.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.focus(); }, true);
          } catch (e) {
            // Cross-origin fallback: you'd need a tiny script inside the iframe that posts messages up.
            // See note below.
          }
        }

        function animate() {
            requestAnimationFrame(animate);
            if (!initialized) { return; }
            const t = (performance.now() - start) / 1000.0;
            tryBindSources();
            if (fluidTex) fluidTex.needsUpdate = true;
            if (moltenTex) moltenTex.needsUpdate = true;
            if (inkTex)    inkTex.needsUpdate    = true;
            material.uniforms.uTime.value = t;
            material.uniforms.uCursor.value.set(cursor.x, cursor.y);

            if (seedGateActive && t >= seedEndTime) {
            endTransitionSeeds();
            frames.forEach((f, i) => setFrameVisibility(f, i === gateDominant));

            material.uniforms.uFrom.value = gateDominant;
            material.uniforms.uTo.value   = gateDominant;
            }

            renderer.render(scene, camera);
        }

        function addSeed(nx, ny) {
            if (!material) return;
            const count = material.uniforms.uSeedCount.value;
            const MAX = 300;
            const now = material.uniforms.uTime.value;
            if (count < MAX) {
            const arr = material.uniforms.uSeeds.value;
            arr[count].set(nx, ny, now);
            material.uniforms.uSeedCount.value = count + 1;
            } else {
            // Overwrite the oldest by shifting birth times forward (simple ring buffer)
            const arr = material.uniforms.uSeeds.value;
            for (let i = 1; i < MAX; i++) arr[i - 1].copy(arr[i]);
            arr[MAX - 1].set(nx, ny, now);
            }
            console.log(`addSeed ${nx.toFixed(2)},${ny.toFixed(2)} count=${material.uniforms.uSeedCount.value}`);
        }

        function clearSeeds() {
            if (!material) return;
            material.uniforms.uSeedCount.value = 0;
        }

        function setIdleSeed(nx, ny) {
            if (!material) return;
            const arr = material.uniforms.uSeeds.value;
            // Keep an inactive seed at index 0 with z<0 so shader ignores it
            arr[0].set(nx, ny, -1.0);
            idleSeed.x = nx; idleSeed.y = ny;
        }

        function startTransitionSeeds(now) {
            seedGateActive = true;
            clearSeeds();
        }

        function endTransitionSeeds() {
            seedGateActive = false;
            clearSeeds();
        }

        initThree();
        installParentKeyHandlers();
        // Assist binding by listening for iframe load as well
        fluidFrame.addEventListener('load', tryBindSources);
        moltenFrame.addEventListener('load', tryBindSources);
        inkFrame.addEventListener('load', tryBindSources);

        // Nudge fluid to start with a few splats (same as its GUI quickstart)
        try { fluidFrame.contentWindow && fluidFrame.contentWindow.postMessage({ type: 'splat', x: 0.5, y: 0.5, id: 0, color: [1, 0.5, 0.2] }, '*'); } catch(_){}
        try { fluidFrame.contentWindow && fluidFrame.contentWindow.postMessage({ type: 'splat', x: 0.25, y: 0.6, id: 1, color: [0.2, 0.6, 1.0] }, '*'); } catch(_){}
        animate();
      });

})(window);


