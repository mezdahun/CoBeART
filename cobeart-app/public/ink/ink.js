// ink.js — THREE.js rewrite (mirrors molten.js structure)

// ---- config / state (kept from original ink) --------------------------------
const MAX_BODIES = 10;
const STATIONARY_VELOCITY_THRESHOLD = 50;
const STATIONARY_TIMEOUT = 200;
const MOUSE_SMOOTHING = 0.2;

let trackedEntities = {};
let iMouseArray = Array.from({length: MAX_BODIES}, () => new THREE.Vector4(0,0,0,0));
let iMouseTarget = new THREE.Vector4();

function cleanupEntities() {
  const now = Date.now();
  for (const id in trackedEntities) {
    if (now - trackedEntities[id].lastSeen > 2000) {
      const e = trackedEntities[id];
      if (e.iMouse.x === 0 && e.iMouse.y === 0 && e.iMouse.z === 0 && e.iMouse.w === 0) {
        delete trackedEntities[id];
      }
    }
  }
}

// ---- THREE bootstrap (same structure as molten.js) ---------------------------
let camera, scene, renderer, plane;
let iResolution = new THREE.Vector3();
let startTime = performance.now();
let lastTime = startTime;
let frame = 0;

let targetA1, targetA2;               // ping-pong for Buffer A
let volumeNoiseTex, blueNoiseTex;     // iChannel0 / iChannel1 for our shaders

init();
animate();

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.LinearEncoding;
  document.body.appendChild(renderer.domElement);

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene = new THREE.Scene();
  plane = new THREE.PlaneBufferGeometry(2, 2);

  const drawingBufferSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(drawingBufferSize);
  iResolution.set(drawingBufferSize.x, drawingBufferSize.y, 1);

  // Render targets
  const rtOptions = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType // good default; browser may upgrade to float
  };
  targetA1 = new THREE.WebGLRenderTarget(iResolution.x, iResolution.y, rtOptions);
  targetA2 = new THREE.WebGLRenderTarget(iResolution.x, iResolution.y, rtOptions);
  // clear to black like original
  const tmpScene = new THREE.Scene();
  const clearMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  renderer.setRenderTarget(targetA1); renderer.render(tmpScene, camera);
  renderer.setRenderTarget(targetA2); renderer.render(tmpScene, camera);
  renderer.setRenderTarget(null);

  // --- textures (ported from original ink.js) ---
  const loader = new THREE.TextureLoader();
  blueNoiseTex = loader.load('textures/blue-noise.png', t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = t.magFilter = THREE.NearestFilter;
  });

  // volume noise BIN → DataTexture (same logic as original ink.js)
  fetch('textures/rgba-noise-volume.bin')
    .then(r => r.arrayBuffer())
    .then(buffer => {
      const view = new DataView(buffer);
      const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 3));
      let size, data;
      if (magic === 'BIN') {
        const width  = view.getUint32(4,  true);
        const height = view.getUint32(8,  true);
        const depth  = view.getUint32(12, true);
        // channels := view.getUint32(16,true)
        size = width; data = new Uint8Array(buffer, 20);
      } else {
        size = 32;    data = new Uint8Array(buffer);
      }
      const textureSize = 256;
      const out = new Uint8Array(textureSize * textureSize * 4);
      for (let y=0; y<textureSize; y++) for (let x=0; x<textureSize; x++) {
        const dst = (y*textureSize + x)*4;
        const fx = (x/textureSize)*size, fy=(y/textureSize)*size;
        const vx1=Math.floor(fx)%size, vy1=Math.floor(fy)%size;
        const vx2=(vx1+1)%size,       vy2=(vy1+1)%size;
        const wx=fx-Math.floor(fx),   wy=fy-Math.floor(fy);
        const vz = Math.floor(size/2);
        const px = (vx,vy)=> {
          const idx = ((vz*size + vy)*size + vx)*4;
          return [data[idx]??128,data[idx+1]??128,data[idx+2]??128,data[idx+3]??255];
        };
        const p1=px(vx1,vy1), p2=px(vx2,vy1), p3=px(vx1,vy2), p4=px(vx2,vy2);
        for (let c=0;c<4;c++){
          const top=p1[c]*(1-wx)+p2[c]*wx;
          const bot=p3[c]*(1-wx)+p4[c]*wx;
          out[dst+c]=Math.round(top*(1-wy)+bot*wy);
        }
      }
      const tex = new THREE.DataTexture(out, textureSize, textureSize, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      volumeNoiseTex = tex;
    })
    .catch(() => {
      // fallback to 2D noise
      volumeNoiseTex = loader.load('textures/noise.png', t => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.minFilter = t.magFilter = THREE.LinearFilter;
      });
    });

  // ----- shaders (lifted from original ink.js) -----
  const vert = `
      void main() {
        gl_Position = vec4(position, 1.0);
      }
    `;

  const commonShader = `
    #define TEX(uv)  texture2D(iChannel0, uv).r
    #define TEX1(uv) texture2D(iChannel1, uv).r
    #define TEX2(uv) texture2D(iChannel2, uv).r
    #define TEX3(uv) texture2D(iChannel3, uv).r
    #define trace(edge, thin) smoothstep(thin,.0,edge)
    #define ss(a,b,t) smoothstep(a,b,t)
  `;

  const bufferA_frag = `
    precision highp float;
    uniform float iTime;
    uniform float iTimeDelta;
    uniform vec3  iResolution;
    uniform vec4  iMouse;
    uniform vec4  iMouseArray[${MAX_BODIES}];
    uniform sampler2D iChannel0; // volume noise
    uniform sampler2D iChannel1; // previous frame
    ${commonShader}
    const float speed=.01; const float scale=.1; const float falloff=3.;
    const float fade=.4;   const float strength=1.; const float range=5.;
    vec3 fbm(vec3 p){
      vec3 r=vec3(0); float a=.5;
      for(float i=0.; i<3.; ++i){
        vec2 uv = p.xy / a;
        float zOff = (p.z + i*.33)*.1;
        float tv = iTime*.25;
        vec2 tOf = vec2(sin(tv+i*2.)*.03, cos(tv*1.3+i*1.5)*.025);
        uv += vec2(zOff*.5, zOff*.7) + tOf;
        r += texture2D(iChannel0, uv).xyz * a;
        a /= falloff;
      } return r;
    }
    void main(){
      vec2 uv = (gl_FragCoord.xy - iResolution.xy/2.)/iResolution.y;
      vec2 aspect = vec2(iResolution.x/iResolution.y,1.);
      vec3 spice = fbm(vec3(uv*scale, iTime*speed));
      float paint=0.; bool any=false;
      for(int i=0;i<${MAX_BODIES};i++){
        if(iMouseArray[i].z>0.5){
          any=true;
          vec2 m=(iMouseArray[i].xy - iResolution.xy/2.)/iResolution.y;
          vec2 luv=uv-m; paint=max(paint, trace(length(luv), .1));
        }
      }
      if(!any){
        float t=iTime*2.; vec2 auv=uv+vec2(cos(t),sin(t))*.3;
        paint=trace(length(auv),.1);
      }
      vec2 offset=vec2(0);
      uv = gl_FragCoord.xy / iResolution.xy;
      vec4 data = texture2D(iChannel1, uv);
      vec3 unit = vec3(range/472./aspect,0.);
      vec3 normal = normalize(vec3(
          texture2D(iChannel1, uv - unit.xz).r - texture2D(iChannel1, uv + unit.xz).r,
          texture2D(iChannel1, uv - unit.zy).r - texture2D(iChannel1, uv + unit.zy).r,
          data.x*data.x)+.001);
      offset -= normal.xy;
      spice.x *= 6.28*2.; spice.x += iTime;
      offset += vec2(cos(spice.x), sin(spice.x));
      uv += strength * offset / aspect / 472.;
      vec4 frame = texture2D(iChannel1, uv);
      paint = max(paint, frame.x - iTimeDelta * fade);
      gl_FragColor = vec4(clamp(paint,0.,1.));
    }
  `;

  const image_frag = `
    precision highp float;
    uniform float iTime;
    uniform vec3  iResolution;
    uniform vec4  iMouse;
    uniform vec4  iMouseArray[${MAX_BODIES}];
    uniform sampler2D iChannel0; // bufferA
    uniform sampler2D iChannel1; // blue noise
    ${commonShader}
    void main(){
      vec2 uv = gl_FragCoord.xy / iResolution.xy;
      vec3 dither = texture2D(iChannel1, gl_FragCoord.xy/1024.).rgb;
      vec4 data = texture2D(iChannel0, uv);
      float gray = data.x;
      float range = 3.; vec2 aspect = vec2(iResolution.x/iResolution.y,1.);
      vec3 unit = vec3(range/472./aspect,0.);
      vec3 normal = normalize(vec3(
        texture2D(iChannel0, uv + unit.xz).r - texture2D(iChannel0, uv - unit.xz).r,
        texture2D(iChannel0, uv - unit.zy).r - texture2D(iChannel0, uv + unit.zy).r,
        gray*gray*gray));
      vec3 color = vec3(.3)*(1.-abs(dot(normal, vec3(0,0,1))));
      vec3 dir = normalize(vec3(0,1,2));
      float spec = pow(dot(normal,dir)*.5+.5,20.);
      color += vec3(.5)*smoothstep(.2,1.,spec);
      vec3 tint = .5+.5*cos(vec3(1,2,3)*1.+dot(normal,dir)*4.-uv.y*3.-3.);
      color += tint * smoothstep(.15,.0,gray);
      color -= dither.x*.1;
      vec3 bg = vec3(1.); bg *= smoothstep(1.5,-.5,length(uv-.5));
      color = mix(bg, clamp(color,0.,1.), smoothstep(.01,.1,gray));
      gl_FragColor = vec4(color,1.);
    }
  `;

  // Materials
  const bufferA = new THREE.ShaderMaterial({
    uniforms: {
      iResolution: { value: new THREE.Vector3(iResolution.x, iResolution.y, 1) },
      iTime: { value: 0 },
      iTimeDelta: { value: 0 },
      iMouse: { value: new THREE.Vector4() },
      iMouseArray: { value: iMouseArray },
      iChannel0: { value: null },   // volume noise
      iChannel1: { value: null }    // previous frame (ping-pong)
    },
    vertexShader: vert,
    fragmentShader: bufferA_frag
  });

  const imageMat = new THREE.ShaderMaterial({
    uniforms: {
      iResolution: { value: iResolution },
      iTime: { value: 0 },
      iMouse: { value: new THREE.Vector4() },
      iMouseArray: { value: iMouseArray },
      iChannel0: { value: null },   // bufferA
      iChannel1: { value: null }    // blue noise
    },
    vertexShader: vert,
    fragmentShader: image_frag
  });

  // We’ll render BufferA on a throwaway mesh scene, then final image to screen
  function renderFullScreen(mat, target) {
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(plane, mat));
    renderer.setRenderTarget(target);
    renderer.render(s, camera);
    renderer.setRenderTarget(null);
  }

  // Expose for animate()
  init._bufferA = bufferA;
  init._imageMat = imageMat;
  init._renderFSQ = renderFullScreen;

  // --- input (mouse + socket) same as original ink.js ------------------------
  document.addEventListener('mousemove', (e)=>{
    const pr = window.devicePixelRatio;
    iMouseTarget.x = e.clientX * pr;
    iMouseTarget.y = (window.innerHeight - e.clientY) * pr;
  });
  document.addEventListener('mousedown', ()=>{
    iMouseTarget.z = iMouseTarget.x; // pressed flag encoded as >0
    iMouseTarget.w = iMouseTarget.y;
  });
  document.addEventListener('mouseup', ()=>{
    iMouseTarget.set(0,0,0,0);
  });

  // Socket.io viewer (kept as-is)
  const PORT = window.__SOCKET_PORT__ || 3000;
  const socket = io(`http://127.0.0.1:${PORT}/viewer`, { transports: ['websocket'] });
  socket.on('frame', (payload)=>{
    if (!payload || !payload.rigidbodies) return;
    const seen = new Set();
    for (const rb of payload.rigidbodies) {
      seen.add(rb.ID);
      if (!trackedEntities[rb.ID]) {
        let idx=-1; const used=Object.values(trackedEntities).map(e=>e.index);
        for (let i=1;i<MAX_BODIES;i++) if(!used.includes(i)){ idx=i; break; }
        if (idx<0) continue;
        trackedEntities[rb.ID] = {
          id: rb.ID, index: idx,
          iMouse: new THREE.Vector4(0,0,0,0),
          iMouseTarget: new THREE.Vector4(0,0,0,0),
          lastSeen: Date.now(),
          stationaryTimer: null, timeoutTimer: null
        };
      }
      const e = trackedEntities[rb.ID];
      e.lastSeen = Date.now();
      if (e.timeoutTimer) clearTimeout(e.timeoutTimer);
      const v = Math.hypot(rb.vx, rb.vy);
      if (v < STATIONARY_VELOCITY_THRESHOLD) {
        if (!e.stationaryTimer) {
          e.stationaryTimer = setTimeout(()=>{
            e.iMouseTarget.set(0,0,0,0);
            e.stationaryTimer = null;
          }, STATIONARY_TIMEOUT);
        }
      } else {
        if (e.stationaryTimer) { clearTimeout(e.stationaryTimer); e.stationaryTimer=null; }
        const arena_x=3000, arena_y=3000;
        const nx = (-rb.x + arena_x)/(2*arena_x);
        const ny = (rb.y + arena_y)/(2*arena_y);
        const pr = window.devicePixelRatio;
        const sx = nx * window.innerWidth  * pr;
        const sy = (1.0 - ny) * window.innerHeight * pr;
        if (e.iMouseTarget.z===0 && e.iMouseTarget.w===0) { e.iMouse.set(sx,sy,0,0); }
        e.iMouseTarget.set(sx,sy,sx,sy);
      }
    }
    for (const id in trackedEntities) {
      if (!seen.has(+id)) {
        const e = trackedEntities[id];
        if (!e.timeoutTimer) e.timeoutTimer = setTimeout(()=> e.iMouseTarget.set(0,0,0,0), 100);
      }
    }
  });

  window.addEventListener('resize', onResize);
  onResize(); // ensure sizes match before first frame
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w,h);
  const db = new THREE.Vector2(); renderer.getDrawingBufferSize(db);
  iResolution.set(db.x, db.y, 1);
  targetA1.setSize(db.x, db.y);
  targetA2.setSize(db.x, db.y);
  init._bufferA.uniforms.iResolution.value.set(db.x, db.y, 1);
}

function animate() {
  requestAnimationFrame(animate);

  cleanupEntities();

  // time + dt like original ink.js
  const now = performance.now();
  const t  = (now - startTime)/1000;
  const dt = Math.min(0.05, Math.max(0, (now - lastTime)/1000)); // clamp to avoid spikes
  lastTime = now;

  // smooth local mouse (slot 0)
  iMouseArray[0].x += (iMouseTarget.x - iMouseArray[0].x) * MOUSE_SMOOTHING;
  iMouseArray[0].y += (iMouseTarget.y - iMouseArray[0].y) * MOUSE_SMOOTHING;
  iMouseArray[0].z = iMouseTarget.z;
  iMouseArray[0].w = iMouseTarget.w;

  // smooth tracked entities into their slots
  for (const id in trackedEntities) {
    const e = trackedEntities[id];
    e.iMouse.x += (e.iMouseTarget.x - e.iMouse.x) * MOUSE_SMOOTHING;
    e.iMouse.y += (e.iMouseTarget.y - e.iMouse.y) * MOUSE_SMOOTHING;
    e.iMouse.z = e.iMouseTarget.z; e.iMouse.w = e.iMouseTarget.w;
    if (e.index >= 0 && e.index < MAX_BODIES) iMouseArray[e.index].copy(e.iMouse);
  }

  // ---- Buffer A pass (ping-pong) ----
  const bufferA = init._bufferA;
  bufferA.uniforms.iTime.value = t;
  bufferA.uniforms.iTimeDelta.value = dt;
  bufferA.uniforms.iChannel0.value = volumeNoiseTex || blueNoiseTex; // until volume loads
  bufferA.uniforms.iChannel1.value = targetA1.texture;

  init._renderFSQ(bufferA, targetA2);
  // swap
  [targetA1, targetA2] = [targetA2, targetA1];

  // ---- Final image to screen ----
  const img = init._imageMat;
  img.uniforms.iResolution.value.copy(iResolution);
  img.uniforms.iTime.value = t;
  img.uniforms.iChannel0.value = targetA1.texture;
  img.uniforms.iChannel1.value = blueNoiseTex;

  const s = new THREE.Scene(); s.add(new THREE.Mesh(plane, img));
  renderer.setRenderTarget(null);
  renderer.render(s, camera);

  frame++;
}