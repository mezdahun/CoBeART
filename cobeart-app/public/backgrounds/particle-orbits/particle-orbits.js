// Particle Orbits Background Shader
// Based on vertex shader art concept
// Particle system with orbital motion and audio reactivity
// https://www.vertexshaderart.com/src/#s=XQAAAQDbBgAAAAAAAAA9iIpmlGmcB7Xtn81bJpWuqJzDtpj%2BZWveh%2F9IJNk0Ya0oGq2w3719ybFPi56XcqP1faEBxzHHBWRyMVK7YMcrX7aWZzOMRA%2BH3yGkWJfVqo6gFTRk5zrIBm3rY2w3hipG%2FpxjgsXk9FSUZ6%2F7eNLCho5aDtfSH9wAqEoxAyyPMSlS8n1awJtnW0YzLkw8q4yY2v%2B53icRI%2B6bDLjj02DLZD1DWn%2Bvwpe6pBLdYFx3SyD5i%2Bs96WBfBL69UBDKcNVRm%2FMd6HNxD5zCmHehzJ7fL2VmdI4e06Q7Yg2ISXHRa7kpiMFm%2BElaKlwMHV5LjT1W1fJTKIoUUT239Y1JzEr1aHmvIdg7y0Ggkr%2BuY4C2GMjh%2Blp%2FGUuRmQsVVrcJRV8FNXCTDSieiXU%2B8G6c09Q76eb3paL2hjk%2BGPZgjl2wPNHy4WfMufY6PKlayi43DURQfA2rWbxjije3i9uBoiP1QNpTpLxgdYM9BisWi3s5ZXWlXoz0GXmLTDyi8HHtMhF07xswvduPiYfp0JZaEQC5WIeWrNZVzsDQCziTjat6MsldgMKvww1c291mzJppWBLWD%2F84vptK2HNJoTT64%2B%2FXdFN%2FvfKK0CrjwIpNuWkm0hyYboxkt0%2BfP6JskNFEradjJ5%2FdpXPYRDP2GGt%2FIXVzA2LFXQcDW1iTMpUmQmVNbnhW762CpIwAH9UM%2BZwucOCIFRe96ur6y8oJoNj6IMoXi40TSiVWABDcM1JNYt9%2F05aANvofPSNQNSoqpRUSQ%2FeTQgMkDnoyl3bjBR8STsYSNL4BQeosrH7GP6Kg7tEQ3ROLROGaxjAAsz8QPtzk%2FSCl8sZ%2FsrJpDfQD3sR0JHXaKnu8wuCSEYpqhpuXg6swkX8MJO2yQgtHrkbNHiARb5NV9KZibMGv7bLnAWlpIFLZuoM4XlCqGDcMaYWzFI4I1lNaLdabitaiRqAXkI%2B9RjrGAxS9h%2FcrpmKcNyGK9qlXmP5wsOhjMILUOG4PJzTqTUEUubVxbQy6KXksUF3Jik0a%2BgA03CI1pX8p5Q2GeT%2B1w0MA7%2BgIho0moEvE3vXpPFUbnnVOitH87vAp

const MAX_BODIES = 10;
let trackedEntities = {};
let audioMetrics = { rms: 0, peak: 0, zcr: 0, dominant_frequency: 0 };

// Connect to Socket.IO for data
window.viewerSocket = io("/viewer", { transports: ["websocket"] });
window.viewerSocket.on('frame', (payload) => {
    if (!payload) return;

    // Update audio metrics
    if (payload.audio) {
        audioMetrics = {
            rms: payload.audio.rms || 0,
            peak: payload.audio.peak || 0,
            zcr: payload.audio.zcr || 0,
            dominant_frequency: payload.audio.dominant_frequency || 0
        };
    }

    // Update tracked entities
    if (payload.rigidbodies) {
        const seenIds = new Set();
        for (const rb of payload.rigidbodies) {
            seenIds.add(rb.ID);
            if (!trackedEntities[rb.ID]) {
                trackedEntities[rb.ID] = {
                    id: rb.ID,
                    x: rb.x || 0,
                    y: rb.y || 0,
                    z: rb.z || 0,
                    vx: rb.vx || 0,
                    vy: rb.vy || 0,
                    abs_vel: rb.abs_vel || 0,
                    lastSeen: Date.now()
                };
            } else {
                trackedEntities[rb.ID].x = rb.x || 0;
                trackedEntities[rb.ID].y = rb.y || 0;
                trackedEntities[rb.ID].z = rb.z || 0;
                trackedEntities[rb.ID].vx = rb.vx || 0;
                trackedEntities[rb.ID].vy = rb.vy || 0;
                trackedEntities[rb.ID].abs_vel = rb.abs_vel || 0;
                trackedEntities[rb.ID].lastSeen = Date.now();
            }
        }

        // Cleanup old entities
        const now = Date.now();
        for (const id in trackedEntities) {
            if (!seenIds.has(parseInt(id, 10)) && now - trackedEntities[id].lastSeen > 2000) {
                delete trackedEntities[id];
            }
        }
    }
});

// THREE.js setup
let camera, scene, renderer;
let particleSystem;
let startTime = Date.now();

// Particle configuration
const NUM_SEGMENTS = 21.0;
const NUM_POINTS = NUM_SEGMENTS * 2.0;
const STEP = 5.0;
const NUM_PARTICLE_GROUPS = 60; // Number of orbital rings
const TOTAL_PARTICLES = NUM_PARTICLE_GROUPS * NUM_POINTS;

init();
animate();

function init() {
    // Camera and scene setup
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 2;
    scene = new THREE.Scene();

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Create particle geometry
    const particleGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(TOTAL_PARTICLES * 3);
    const vertexIds = new Float32Array(TOTAL_PARTICLES);

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
        positions[i * 3] = 0;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = 0;
        vertexIds[i] = i;
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeometry.setAttribute('vertexId', new THREE.BufferAttribute(vertexIds, 1));

    // Create particle shader material
    const particleMaterial = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
            mouse: { value: new THREE.Vector2(0, 0) },
            audioRMS: { value: 0 },
            audioPeak: { value: 0 },
            audioFreq: { value: 0 },
            numBodies: { value: 0 },
            bodyPositions: { value: new Array(MAX_BODIES).fill(new THREE.Vector3(0, 0, 0)) }
        },
        vertexShader: `
            #define PI 3.14159265359
            #define NUM_SEGMENTS 21.0
            #define NUM_POINTS (NUM_SEGMENTS * 2.0)
            #define STEP 5.0

            attribute float vertexId;
            uniform float time;
            uniform vec2 resolution;
            uniform vec2 mouse;
            uniform float audioRMS;
            uniform float audioPeak;
            uniform float audioFreq;
            uniform int numBodies;
            uniform vec3 bodyPositions[${MAX_BODIES}];

            varying vec4 vColor;

            vec3 hsv2rgb(vec3 c) {
                c = vec3(c.x, clamp(c.yz, 0.0, 1.0));
                vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
                vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
                return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
            }

            void main() {
                float pointSize = resolution.x / 40.0;
                gl_PointSize = pointSize + audioPeak * pointSize * 2.0;

                float point = mod(floor(vertexId / 2.0) + mod(vertexId, 2.0) * STEP, NUM_SEGMENTS);
                float count = floor(vertexId / NUM_POINTS);
                float offset = count * 0.02;
                float angle = point * PI * 2.0 / NUM_SEGMENTS + offset;
                float radius = 0.2 + audioRMS * 0.3;
                float c = cos(angle + time) * radius;
                float s = sin(angle + time) * radius;
                float orbitAngle = count * 0.01;
                float r2 = sin(orbitAngle);
                float oC = cos(orbitAngle + time * count * 0.01) * r2;
                float oS = sin(orbitAngle + time * count * 0.01) * r2;

                vec2 aspect = vec2(1.0, resolution.x / resolution.y);

                vec2 xy = vec2(oC + c, oS + s);

                float dd = length(xy);

                // Audio-reactive displacement
                float snd = pow(audioRMS, 2.0) + audioPeak * 0.5;
                xy = xy + xy * snd;

                // Add mouse interaction (modulated by tracked bodies)
                vec2 mouseOffset = mouse * 0.1;
                if (numBodies > 0) {
                    // Use first tracked body for mouse offset
                    vec2 bodyPos2D = bodyPositions[0].xy / 3000.0; // Normalize from mm to [-1, 1]
                    mouseOffset = bodyPos2D * 0.2;
                }

                gl_Position = vec4(xy * aspect + mouseOffset, -fract(count * 0.01), 1.0);

                float hue = (time * 0.01 + count * 1.001);
                vColor = vec4(mix(hsv2rgb(vec3(hue + snd, 1.0, 1.0)), vec3(1.0, 1.0, 1.0), snd), 0.1 + snd * 0.5);
                vColor = vec4(vColor.rgb * vColor.a, vColor.a);
            }
        `,
        fragmentShader: `
            varying vec4 vColor;

            void main() {
                // Circular point shape
                vec2 coord = gl_PointCoord - vec2(0.5);
                float dist = length(coord);
                if (dist > 0.5) discard;

                // Soft edge
                float alpha = 1.0 - smoothstep(0.3, 0.5, dist);
                gl_FragColor = vec4(vColor.rgb, vColor.a * alpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    // Create particle system
    particleSystem = new THREE.Points(particleGeometry, particleMaterial);
    scene.add(particleSystem);

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    particleSystem.material.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    const elapsedTime = (Date.now() - startTime) / 1000.0;

    // Update uniforms
    particleSystem.material.uniforms.time.value = elapsedTime;
    particleSystem.material.uniforms.audioRMS.value = audioMetrics.rms;
    particleSystem.material.uniforms.audioPeak.value = audioMetrics.peak;
    particleSystem.material.uniforms.audioFreq.value = audioMetrics.dominant_frequency / 1000.0; // Normalize frequency

    // Update tracked body positions
    const bodyPosArray = [];
    let numBodies = 0;
    for (const id in trackedEntities) {
        if (numBodies < MAX_BODIES) {
            const entity = trackedEntities[id];
            bodyPosArray.push(new THREE.Vector3(entity.x, entity.y, entity.z));
            numBodies++;
        }
    }
    // Fill remaining slots with zeros
    while (bodyPosArray.length < MAX_BODIES) {
        bodyPosArray.push(new THREE.Vector3(0, 0, 0));
    }
    particleSystem.material.uniforms.bodyPositions.value = bodyPosArray;
    particleSystem.material.uniforms.numBodies.value = numBodies;

    // Render
    renderer.render(scene, camera);
}
