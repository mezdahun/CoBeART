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

        uniform sampler2D uFluid;
        uniform sampler2D uMolten;

        uniform vec2  uResolution;   // pixels
        uniform float uTime;          // seconds
        uniform vec2  uCursor;        // [0,1] with (0,0)=bottom-left in render space
        uniform float uAutoCycle;     // 1: internal 10s cycle, 0: use uDominant directly
        uniform int   uDominant;      // 0: fluid dominant (molten expands), 1: molten dominant (fluid expands)
        uniform float uEdgeSoftness;  // pixels
        uniform float uNoiseAmount;   // 0..1
        uniform float uCycleSeconds;  // seconds, default 10

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

            // Time within cycle [0,1)
            float cycle = mod(uTime, max(0.001, uCycleSeconds)) / max(0.001, uCycleSeconds);
            int dominant = uDominant;
            if (uAutoCycle > 0.5) {
                // Swap dominant every half cycle so it toggles every uCycleSeconds
                dominant = (cycle < 0.5) ? 0 : 1;
            }

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
            float t = (uAutoCycle > 0.5) ? fract(cycle * 2.0) : cycle; // 0..1
            float e = smoothstep(0.0, 1.0, t);
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

            // front ~ 0 inside (near cursor early), 1 outside; decide which layer expands
            float moltenWeight = (dominant == 0) ? (1.0 - unionFront) : unionFront;

            vec4 fluidCol = texture2D(uFluid, uv);
            vec4 moltenCol = texture2D(uMolten, uv);
            vec3 color = mix(fluidCol.rgb, moltenCol.rgb, clamp(moltenWeight, 0.0, 1.0));
            float alpha = mix(fluidCol.a, moltenCol.a, clamp(moltenWeight, 0.0, 1.0));
            gl_FragColor = vec4(color, alpha);
        }
    `;

    function createMaterial(options) {
        const opts = options || {};
        const MAX_SEEDS = 64;
        const seedArray = new Array(MAX_SEEDS).fill(0).map(() => new THREE.Vector3(-1, -1, -1));

        const uniforms = {
            uFluid:        { value: opts.fluidTexture || null },
            uMolten:       { value: opts.moltenTexture || null },
            uResolution:   { value: opts.resolution || new THREE.Vector2(1920, 1080) },
            uTime:         { value: 0.0 },
            uCursor:       { value: new THREE.Vector2(0.5, 0.5) },
            uAutoCycle:    { value: 1.0 },
            uDominant:     { value: 0 },
            uEdgeSoftness: { value: 30.0 },
            uNoiseAmount:  { value: 0.6 },
            uCycleSeconds: { value: 10.0 },
            uSeedCount:    { value: 0 },
            uSeeds:        { value: seedArray },
            uSeedSpeed:    { value: 0.9 },
            uCellScale:       { value: 7.0 },
            uWarpStrength:    { value: 0.0 },
            uOrganicStrength: { value: 80.0 },
            uBranchAmp:       { value: 0.0 },
            uBranchScale:     { value: 0.0 },
            uFrictionStrength:{ value: 0.6 },
            uAnisoStrength:   { value: 0.0 }
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
})(window);


