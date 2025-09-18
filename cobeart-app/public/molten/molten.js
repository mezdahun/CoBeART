// Original shader: https://www.shadertoy.com/view/WdVXWy
// Textures and cubemaps: https://shadertoyunofficial.wordpress.com/2019/07/23/shadertoy-media-files/

const MAX_BODIES = 10;
let trackedEntities = {};
let iMouseArray = [];
for (let i = 0; i < MAX_BODIES; i++) {
    iMouseArray.push(new THREE.Vector4(0, 0, 0, 0));
}
let iMouseTarget = new THREE.Vector4();
let iJustClickedArray = new Array(MAX_BODIES).fill(0.0);

function cleanupEntities() {
    const now = Date.now();
    for (const id in trackedEntities) {
        if (now - trackedEntities[id].lastSeen > 2000) {
            const entity = trackedEntities[id];
            if (entity.iMouse.x === 0 && entity.iMouse.y === 0 && entity.iMouse.z === 0 && entity.iMouse.w === 0) {
                delete trackedEntities[id];
            }
        }
    }
}

// Connect to the WebSocket and log data
window.viewerSocket = io("/viewer", { transports: ["websocket"] });
window.viewerSocket.on('frame', (payload) => {
    if (!payload || !payload.rigidbodies) return;

    const seenIds = new Set();

    for (const rb of payload.rigidbodies) {
        seenIds.add(rb.ID);

        if (!trackedEntities[rb.ID]) {
            let newIndex = -1;
            const usedIndices = Object.values(trackedEntities).map(e => e.index);
            for (let i = 1; i < MAX_BODIES; i++) {
                if (!usedIndices.includes(i)) {
                    newIndex = i;
                    break;
                }
            }

            if (newIndex === -1) {
                console.log("Max number of tracked bodies reached.");
                continue;
            }

            trackedEntities[rb.ID] = {
                id: rb.ID,
                index: newIndex,
                iMouse: new THREE.Vector4(0, 0, 0, 0),
                iMouseTarget: new THREE.Vector4(0, 0, 0, 0),
                lastSeen: Date.now(),
                stationaryTimer: null,
                timeoutTimer: null,
            };
        }

        const entity = trackedEntities[rb.ID];
        entity.lastSeen = Date.now();
        if (entity.timeoutTimer) clearTimeout(entity.timeoutTimer);

        const absVel = Math.sqrt(rb.vx * rb.vx + rb.vy * rb.vy);

        if (absVel < STATIONARY_VELOCITY_THRESHOLD) {
            if (!entity.stationaryTimer) {
                entity.stationaryTimer = setTimeout(() => {
                    entity.iMouseTarget.set(0, 0, 0, 0);
                    entity.stationaryTimer = null;
                }, STATIONARY_TIMEOUT);
            }
        } else {
            if (entity.stationaryTimer) {
                clearTimeout(entity.stationaryTimer);
                entity.stationaryTimer = null;
            }

            const arena_x = 3000;
            const arena_y = 3000;
            const norm_x = (-rb.x + arena_x) / (2 * arena_x);
            const norm_y = (rb.y + arena_y) / (2 * arena_y);
            const pixelRatio = window.devicePixelRatio;
            const screenX = norm_x * window.innerWidth * pixelRatio;
            const screenY = (1.0 - norm_y) * window.innerHeight * pixelRatio;

            if (entity.iMouseTarget.z === 0 && entity.iMouseTarget.w === 0) {
                entity.iMouse.x = screenX;
                entity.iMouse.y = screenY;
            }

            entity.iMouseTarget.x = screenX;
            entity.iMouseTarget.y = screenY;
            entity.iMouseTarget.z = screenX;
            entity.iMouseTarget.w = screenY;
        }
    }

    for (const id in trackedEntities) {
        if (!seenIds.has(parseInt(id, 10))) {
            const entity = trackedEntities[id];
            if (!entity.timeoutTimer) {
                entity.timeoutTimer = setTimeout(() => {
                    entity.iMouseTarget.set(0, 0, 0, 0);
                }, 100);
            }
        }
    }
});


// --- THREE.js implementation for Shadertoy shader ---

let camera, scene, renderer;
let plane;
let iResolution = new THREE.Vector3();
let iChannel0, iChannel1, iChannel2, iChannel3;

// Render targets for buffers (using ping-pong technique)
let bufferA, bufferB;
let targetA1, targetA2;
let targetB1, targetB2;

let RESOLUTION_SCALE = 0.5;

let frame = 0;
let startTime = Date.now();
const loader = new THREE.TextureLoader();
let oscillationEnabled = true;

// --- Performance Mode ---
// Can be enabled by adding ?performance=true to the URL
const urlParams = new URLSearchParams(window.location.search);
let performanceMode = urlParams.get('performance') === 'true';


// The velocity threshold (in mm/s) below which the object is considered stationary.
const STATIONARY_VELOCITY_THRESHOLD = 50;
// The time (in ms) after which a stationary object triggers a "mouse up" event.
const STATIONARY_TIMEOUT = 200;
const MOUSE_SMOOTHING = 0.2;

// Shaders
const commonShader = `
#define PI2 6.283185

#define Res0 vec2(textureSize(iChannel0,0))
#define Res1 vec2(textureSize(iChannel1,0))

vec2 scuv(vec2 uv) {
    float zoom=1.;
    #ifdef SHADEROO
    zoom=1.-iMouseData.z/1000.;
    #endif
    return (uv-.5)*1.2*zoom+.5; 
}

vec2 uvSmooth(vec2 uv,vec2 res)
{
    vec2 f = fract(uv*res);
    return (uv*res+.5-f+3.*f*f-2.0*f*f*f)/res;
}
`;

const bufferAVertexShader = `void main() { gl_Position = vec4( position, 1.0 ); }`;
const bufferAFragmentShader = `
uniform vec3      iResolution;
uniform float     iTime;
uniform int       iFrame;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2; // Keyboard texture
uniform sampler2D iChannel3; // Buffer B
uniform vec3      iAppResolution;
uniform float     keyI;
uniform vec2      u_b; // Pre-calculated offset vector
uniform vec2      u_mouseEffect; // Pre-calculated mouse shimmer effect
uniform mat3      u_m; // Pre-calculated rotation matrix
uniform mat3      u_mh; // Pre-calculated half-angle rotation matrix
uniform float     u_bbMax; // Pre-calculated loop boundary condition
uniform float     u_sqrt_res_factor; // Pre-calculated resolution-dependent sqrt factor

#define keyTex iChannel2
#define KEY_I keyI
#define PI2 6.283185

// const float ang = PI2/float(RotNum);
// mat2 m = mat2(cos(ang),sin(ang),-sin(ang),cos(ang));
// mat2 mh = mat2(cos(ang*0.5),sin(ang*0.5),-sin(ang*0.5),cos(ang*0.5));

float getRot(vec2 pos, vec2 b)
{
    float l = 0.0;
    vec2 p = b;
    float rot=0.0;
    for(int i=0;i<RotNum;i++)
    {
        rot+=dot(textureLod(iChannel0,((pos+p)/Res0.xy),l).xy-vec2(0.5),p.yx*vec2(1,-1));
        p = mat2(u_m)*p;
    }
    return rot/float(RotNum)/dot(b,b);
}

void main()
{
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 pos = fragCoord;
    vec2 b = u_b;
    vec2 v=vec2(0);
    for(int l=0;l<LoopIterations;l++)
    {
        if ( dot(b,b) > u_bbMax ) break;
        vec2 p = b;
        for(int i=0;i<RotNum;i++)
        {
            v+=p.yx*getRot(pos+p,-mat2(u_mh)*b);
            p = mat2(u_m)*p;
        }
        b*=2.0;
    }
    
    vec4 fragColor = textureLod(iChannel0,fract((pos-v*vec2(-1,1)*5.*u_sqrt_res_factor)/Res0.xy),0.);
    fragColor.xy=mix(fragColor.xy,v*vec2(-1,1)*sqrt(.125)*.9,.025);
    
    vec2 total_push = vec2(0.0);
    bool any_mouse_active = false;

    for (int i = 0; i < MAX_BODIES; ++i) {
        vec4 mouse_data = texture(iChannel3, vec2(0.5, (float(i) + 0.5) / float(MAX_BODIES)));
        
        if (mouse_data.x > 1.0) {
            any_mouse_active = true;
            vec2 mouse_pos = mouse_data.xy;
            vec2 mouse_delta = mouse_data.zw;
            vec2 c = fract(scuv(mouse_pos.xy/iAppResolution.xy))*iResolution.xy;
            vec2 scr = fract((fragCoord.xy-c)/Res0.x+.5)-.5;
            total_push += .0003 * mouse_delta / (dot(scr,scr)/0.05+.05);
        }
    }

    if (!any_mouse_active) {
        vec2 c = Res0 * 0.5;
        vec2 scr = fract((fragCoord.xy-c)/Res0.x+.5)-.5;
        total_push += u_mouseEffect / (dot(scr,scr)/0.05+.05);
    }
    fragColor.xy += total_push;

    fragColor.zw += (texture(iChannel1,fragCoord/Res1*.35).zw-.5)*.002;
    fragColor.zw += (texture(iChannel1,fragCoord/Res1*.7).zw-.5)*.001;
    
    if(iFrame<=4) fragColor=vec4(0);
    if(KEY_I>.5 ) fragColor=(texture(iChannel1,uvSmooth(fragCoord.xy/Res0.xy*.05,Res1))-.5)*.7;

    gl_FragColor = fragColor;
}
`;

const bufferBVertexShader = `void main() { gl_Position = vec4( position, 1.0 ); }`;
const bufferBFragmentShader = `
uniform vec4      iMouse[MAX_BODIES];
uniform sampler2D iChannel0; // Previous Buffer B state
uniform float     iJustClicked[MAX_BODIES];

void main()
{
    int index = int(gl_FragCoord.y - 0.5);
    vec2 uv = vec2(0.5, gl_FragCoord.y) / vec2(1.0, float(MAX_BODIES));

    vec4 c = texture(iChannel0, uv);
    vec4 currentMouse = iMouse[index];
    float justClicked = iJustClicked[index];

    vec2 m = currentMouse.xy;
    vec2 d = vec2(0);
    if (currentMouse.z > 0.0 && currentMouse.w > 0.0) {
      if (justClicked > 0.5) {
          d = vec2(0.0);
      } else {
          d = currentMouse.xy - c.xy;
      }
    }
    gl_FragColor = vec4(m, d);
}
`;

const imageVertexShader = `void main() { gl_Position = vec4( position, 1.0 ); }`;
const imageFragmentShader = `
uniform vec3      iResolution;
uniform float     iTime;
uniform sampler2D iChannel0; // Buffer A
uniform samplerCube iChannel2; // Environment Cubemap
uniform samplerCube iChannel3; // Second Environment Cubemap
uniform float     u_oscillationEnabled;
uniform float     u_blendWeight;

#define Res  (iResolution.xy)
#define PI 3.14159265359

vec4 myenv(vec3 pos, vec3 dir, float period)
{
    // Sample the cubemaps with the reflection vector
    vec4 env1 = texture(iChannel2, dir.xzy) + 0.15; // original

    if (u_oscillationEnabled < 0.5) {
        return env1;
    }

    vec4 env2 = texture(iChannel3, dir.xzy) + 0.15; // new

    float w = u_blendWeight;

    // Blend between env1 and (0.4 * env1 + 0.6 * env2)
    return env1 * (1.0 - 0.6 * w) + env2 * (0.6 * w);
}

vec4 getCol(vec2 uv) {
    return texture(iChannel0, uv);
}

float getVal(vec2 uv) { return length(getCol(uv).xyz); }
    
vec2 getGrad(vec2 uv,float delta)
{
    vec2 d=vec2(delta,0); return vec2( getVal(uv+d.xy)-getVal(uv-d.xy),
                                       getVal(uv+d.yx)-getVal(uv-d.yx) )/delta;
}

void main()
{
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    
    // Gradient delta should be relative to the texture we're sampling
    float delta = 1.4 / iResolution.x;
    vec3 n = vec3(-getGrad(uv, delta)*.02, 1.);
    n=normalize(n);

    vec2 sc=(gl_FragCoord.xy-Res*.5)/Res.x;
    vec3 dir=normalize(vec3(sc,-1.));
    vec3 R=reflect(dir,n);
    vec3 refl=myenv(vec3(0),R,1.).xyz;
    
    vec4 col=getCol(uv)+.5;
    col=mix(vec4(1),col,.35);
    col.xyz*=.95+-.05*n;
    
	gl_FragColor = vec4(col.xyz*refl, 1.0);
}
`;

function init() {
    renderer = new THREE.WebGLRenderer();
    const pixelRatio = performanceMode ? Math.min(window.devicePixelRatio, 1.5) : window.devicePixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.LinearEncoding;
    document.body.appendChild(renderer.domElement);

    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene = new THREE.Scene();
    plane = new THREE.PlaneBufferGeometry(2, 2);

    const drawingBufferSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(drawingBufferSize);
    iResolution.set(drawingBufferSize.x, drawingBufferSize.y, 1);

    // Load textures
    const textureLoader = new THREE.TextureLoader();
    const noiseTexture = textureLoader.load('textures/noise.png');
    noiseTexture.wrapS = THREE.RepeatWrapping;
    noiseTexture.wrapT = THREE.RepeatWrapping;

    const cubeTextureLoader = new THREE.CubeTextureLoader();
    const envMapTexture = cubeTextureLoader
        .setPath('textures/')
        .load(['px.jpg', 'nx.jpg', 'py.jpg', 'ny.jpg', 'pz.jpg', 'nz.jpg'], (cube) => {
            cube.encoding = THREE.LinearEncoding;
        });

    const envMapTexture2 = cubeTextureLoader
        .setPath('textures/')
        .load(['px2.png', 'nx2.png', 'py2.png', 'ny2.png', 'pz2.png', 'nz2.png'], (cube) => {
            cube.encoding = THREE.LinearEncoding;
        });

    // Create render targets for ping-ponging
    const rtOptions = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
    };
    RESOLUTION_SCALE = performanceMode ? 0.5 : 1.0;
    const bufferWidth = Math.floor(iResolution.x * RESOLUTION_SCALE);
    const bufferHeight = Math.floor(iResolution.y * RESOLUTION_SCALE);
    targetA1 = new THREE.WebGLRenderTarget(bufferWidth, bufferHeight, rtOptions);
    targetA2 = new THREE.WebGLRenderTarget(bufferWidth, bufferHeight, rtOptions);

    // Buffer B is for mouse data
    targetB1 = new THREE.WebGLRenderTarget(1, MAX_BODIES, rtOptions);
    targetB2 = new THREE.WebGLRenderTarget(1, MAX_BODIES, rtOptions);

    // --- Materials ---
    const loopIterations = performanceMode ? 10 : 20;
    const rotNum = 5.0;
    const ang = Math.PI * 2 / rotNum;
    const cos_ang = Math.cos(ang);
    const sin_ang = Math.sin(ang);
    // THREE.Matrix2 does not exist in this version. We can use the top-left
    // 2x2 portion of a THREE.Matrix3 to achieve the same result.
    // The elements are provided in row-major order.
    const u_m = new THREE.Matrix3().set(
        cos_ang, -sin_ang, 0,
        sin_ang, cos_ang, 0,
        0, 0, 1
    );

    const ang_half = ang * 0.5;
    const cos_ang_half = Math.cos(ang_half);
    const sin_ang_half = Math.sin(ang_half);
    const u_mh = new THREE.Matrix3().set(
        cos_ang_half, -sin_ang_half, 0,
        sin_ang_half, cos_ang_half, 0,
        0, 0, 1
    );
    const u_bbMax = 0.5 * bufferHeight * 0.5 * bufferHeight;
    const u_sqrt_res_factor = Math.sqrt(bufferWidth / 600.0);


    bufferA = new THREE.ShaderMaterial({
        uniforms: {
            iResolution: { value: new THREE.Vector3(bufferWidth, bufferHeight, 1) },
            iTime: { value: 0.0 },
            iFrame: { value: 0 },
            iMouse: { value: iMouseArray },
            iChannel0: { value: null }, // Buffer A (self)
            iChannel1: { value: noiseTexture },
            iChannel2: { value: null }, // Placeholder for keyboard tex
            iChannel3: { value: null }, // Buffer B
            iAppResolution: { value: iResolution },
            keyI: { value: 0.0 },
            u_b: { value: new THREE.Vector2() },
            u_mouseEffect: { value: new THREE.Vector2() },
            u_m: { value: u_m },
            u_mh: { value: u_mh },
            u_bbMax: { value: u_bbMax },
            u_sqrt_res_factor: { value: u_sqrt_res_factor }
        },
        vertexShader: bufferAVertexShader,
        fragmentShader: `#define LoopIterations ${loopIterations}\n#define RotNum 5\n#define MAX_BODIES ${MAX_BODIES}\n` + commonShader + bufferAFragmentShader
    });

    bufferB = new THREE.ShaderMaterial({
        uniforms: {
            iMouse: { value: iMouseArray },
            iChannel0: { value: null }, // Buffer B (self)
            iJustClicked: { value: iJustClickedArray }
        },
        vertexShader: bufferBVertexShader,
        fragmentShader: `#define MAX_BODIES ${MAX_BODIES}\n` + commonShader + bufferBFragmentShader
    });

    const imageMaterial = new THREE.ShaderMaterial({
        uniforms: {
            iResolution: { value: iResolution },
            iTime: { value: 0.0 },
            iChannel0: { value: null }, // Buffer A
            iChannel2: { value: envMapTexture },
            iChannel3: { value: envMapTexture2 },
            u_oscillationEnabled: { value: 1.0 },
            u_blendWeight: { value: 0.0 }
        },
        vertexShader: imageVertexShader,
        fragmentShader: imageFragmentShader
    });

    const finalMesh = new THREE.Mesh(plane, imageMaterial);
    scene.add(finalMesh);

    // --- Event Listeners ---
    let stationaryMouseTimer = null;
    document.addEventListener('mousemove', (e) => {
        if (e.buttons === 1) { // Left mouse button down
            if (stationaryMouseTimer) clearTimeout(stationaryMouseTimer);
            stationaryMouseTimer = setTimeout(() => {
                iMouseTarget.set(0, 0, 0, 0);
            }, STATIONARY_TIMEOUT);

            const pixelRatio = window.devicePixelRatio;
            iMouseTarget.x = e.clientX * pixelRatio;
            iMouseTarget.y = (window.innerHeight - e.clientY) * pixelRatio;
        }
    });

    document.addEventListener('mousedown', (e) => {
        if (e.buttons === 1) {
            iJustClickedArray[0] = 1.0;
            const pixelRatio = window.devicePixelRatio;
            const x = e.clientX * pixelRatio;
            const y = (window.innerHeight - e.clientY) * pixelRatio;
            iMouseArray[0].set(x, y, x, y);
            iMouseTarget.copy(iMouseArray[0]);
        }
    });

    document.addEventListener('mouseup', () => {
        if (stationaryMouseTimer) {
            clearTimeout(stationaryMouseTimer);
            stationaryMouseTimer = null;
        }
        iMouseArray[0].set(0, 0, 0, 0);
        iMouseTarget.set(0, 0, 0, 0);
    });

    // Accept cursor events from composite parent
    window.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || m.type !== 'cursor') return;
        const pixelRatio = window.devicePixelRatio;
        const x = m.x * window.innerWidth * pixelRatio;
        const y = m.y * window.innerHeight * pixelRatio;
        if (m.down) {
            iJustClickedArray[0] = 1.0;
            iMouseArray[0].set(x, y, x, y);
            iMouseTarget.copy(iMouseArray[0]);
        } else if (m.up) {
            iMouseArray[0].set(0, 0, 0, 0);
            iMouseTarget.set(0, 0, 0, 0);
        } else {
            iMouseTarget.x = x;
            iMouseTarget.y = y;
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'i') {
            bufferA.uniforms.keyI.value = 1.0;
        }
        if (e.code === 'Space') {
            e.preventDefault();
            oscillationEnabled = !oscillationEnabled;
        }
    });

    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const pixelRatio = performanceMode ? Math.min(window.devicePixelRatio, 1.5) : window.devicePixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h);

    const drawingBufferSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(drawingBufferSize);
    iResolution.set(drawingBufferSize.x, drawingBufferSize.y, 1);

    RESOLUTION_SCALE = performanceMode ? 0.5 : 1.0;
    const bufferWidth = Math.floor(iResolution.x * RESOLUTION_SCALE);
    const bufferHeight = Math.floor(iResolution.y * RESOLUTION_SCALE);
    targetA1.setSize(bufferWidth, bufferHeight);
    targetA2.setSize(bufferWidth, bufferHeight);
    bufferA.uniforms.iResolution.value.set(bufferWidth, bufferHeight, 1);
    bufferA.uniforms.u_bbMax.value = 0.5 * bufferHeight * 0.5 * bufferHeight;
    bufferA.uniforms.u_sqrt_res_factor.value = Math.sqrt(bufferWidth / 600.0);
}

function animate() {
    requestAnimationFrame(animate);

    cleanupEntities();

    const elapsedTime = (Date.now() - startTime) / 1000.0;

    // Smoothly interpolate iMouse towards iMouseTarget
    iMouseArray[0].x += (iMouseTarget.x - iMouseArray[0].x) * MOUSE_SMOOTHING;
    iMouseArray[0].y += (iMouseTarget.y - iMouseArray[0].y) * MOUSE_SMOOTHING;
    iMouseArray[0].z = iMouseTarget.z; // z and w are flags, not smoothed
    iMouseArray[0].w = iMouseTarget.w;

    for (const id in trackedEntities) {
        const entity = trackedEntities[id];
        entity.iMouse.x += (entity.iMouseTarget.x - entity.iMouse.x) * MOUSE_SMOOTHING;
        entity.iMouse.y += (entity.iMouseTarget.y - entity.iMouse.y) * MOUSE_SMOOTHING;
        entity.iMouse.z = entity.iMouseTarget.z;
        entity.iMouse.w = entity.iMouseTarget.w;

        if (entity.index >= 0 && entity.index < MAX_BODIES) {
            iMouseArray[entity.index].copy(entity.iMouse);
        }
    }

    // --- Render Buffer B ---
    bufferB.uniforms.iChannel0.value = targetB1.texture;
    renderer.setRenderTarget(targetB2);
    renderer.render(new THREE.Scene().add(new THREE.Mesh(plane, bufferB)), camera);
    iJustClickedArray.fill(0.0);
    // Swap B
    [targetB1, targetB2] = [targetB2, targetB1];

    // --- Render Buffer A ---
    bufferA.uniforms.iTime.value = elapsedTime;
    bufferA.uniforms.iFrame.value = frame;
    bufferA.uniforms.u_b.value.set(
        Math.cos(frame * 0.3),
        Math.cos(frame * 0.3 - 1.57)
    );
    bufferA.uniforms.u_mouseEffect.value.set(
        0.003 * Math.cos(elapsedTime * 0.3),
        0.003 * Math.cos(elapsedTime * 0.3 - 1.57)
    );
    bufferA.uniforms.iChannel0.value = targetA1.texture;
    bufferA.uniforms.iChannel3.value = targetB1.texture; // Use latest Buffer B
    renderer.setRenderTarget(targetA2);
    renderer.render(new THREE.Scene().add(new THREE.Mesh(plane, bufferA)), camera);
    // Swap A
    [targetA1, targetA2] = [targetA2, targetA1];

    // --- Render final image to screen ---
    scene.children[0].material.uniforms.iChannel0.value = targetA1.texture;
    scene.children[0].material.uniforms.iTime.value = elapsedTime;
    scene.children[0].material.uniforms.u_oscillationEnabled.value = oscillationEnabled ? 1.0 : 0.0;
    scene.children[0].material.uniforms.u_blendWeight.value = (Math.sin(elapsedTime * (2.0 * Math.PI / 60.0)) + 1.0) / 2.0;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);

    // Reset key press after one frame
    if (bufferA.uniforms.keyI.value > 0.5) {
        bufferA.uniforms.keyI.value = 0.0;
    }

    frame++;
}

init();
animate();
