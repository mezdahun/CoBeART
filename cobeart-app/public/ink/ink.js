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

function rebuildIMouseArray() {
  // clear all slots
  for (let i = 0; i < MAX_BODIES; i++) {
    iMouseArray[i].set(0, 0, 0, 0);
  }
  // pack by entity.index (which equals m.id)
  for (const id in trackedEntities) {
    const e = trackedEntities[id];
    if (!e) continue;
    const idx = (e.index | 0);
    if (idx < 0 || idx >= MAX_BODIES) continue;

    // smooth motion
    e.iMouse.x += (e.iMouseTarget.x - e.iMouse.x) * MOUSE_SMOOTHING;
    e.iMouse.y += (e.iMouseTarget.y - e.iMouse.y) * MOUSE_SMOOTHING;

    // active flag from target.z (set to 1.0 above)
    const active = e.iMouseTarget.z > 0.5 ? 1.0 : 0.0;
    iMouseArray[idx].set(e.iMouse.x, e.iMouse.y, active, 0.0);
  }

  // push to shaders
  if (init && init._bufferA)   init._bufferA.uniforms.iMouseArray.value = iMouseArray;
  if (init && init._imageMat)  init._imageMat.uniforms.iMouseArray.value = iMouseArray;
}

function syncPerEntityUniforms() {
  const img = init && init._imageMat;
  const buf = init && init._bufferA;
  if (!img && !buf) return;

  const inkBaseDefault = CONFIG.inkBase;
  const inkTintDefault = CONFIG.inkTint;
  const blobDefault = CONFIG.blobSize;
  const fadeDefault = CONFIG.fade;
  const range1Default = CONFIG.range1;
  const range2Default = CONFIG.range2;
  const scaleDefault = CONFIG.scale;
  const falloffDefault = CONFIG.falloff;
  const specDefault = CONFIG.specularStrength;
  const normalDivDefault = CONFIG.normalDivider;

  const getEntityByIndex = (idx) => {
    for (const id in trackedEntities) {
      const e = trackedEntities[id];
      if (e && e.index === idx) return e;
    }
    return null;
  };

  // Image material vec3 arrays (ink base/tint)
  if (img && img.uniforms.uInkBaseArray && img.uniforms.uInkTintArray) {
    const baseArr = img.uniforms.uInkBaseArray.value;
    const tintArr = img.uniforms.uInkTintArray.value;
    for (let i = 0; i < MAX_BODIES; i++) {
      const ent = getEntityByIndex(i);
      const b = ent && ent.config && ent.config.inkBase ? ent.config.inkBase : inkBaseDefault;
      const t = ent && ent.config && ent.config.inkTint ? ent.config.inkTint : inkTintDefault;
      if (baseArr[i] instanceof THREE.Vector3) baseArr[i].set(b[0], b[1], b[2]);
      else baseArr[i] = new THREE.Vector3(b[0], b[1], b[2]);
      if (tintArr[i] instanceof THREE.Vector3) tintArr[i].set(t[0], t[1], t[2]);
      else tintArr[i] = new THREE.Vector3(t[0], t[1], t[2]);
    }
    img.uniforms.uInkBaseArray.value = baseArr;
    img.uniforms.uInkTintArray.value = tintArr;
    img.needsUpdate = true;
  }

  // Build float arrays for all per-entity scalars
  const fadeArr = new Float32Array(MAX_BODIES);
  const range1Arr = new Float32Array(MAX_BODIES);
  const range2Arr = new Float32Array(MAX_BODIES);
  const scaleArr = new Float32Array(MAX_BODIES);
  const falloffArr = new Float32Array(MAX_BODIES);
  const specArr = new Float32Array(MAX_BODIES);
  const normalDivArr = new Float32Array(MAX_BODIES);
  const blobArr = new Float32Array(MAX_BODIES);

  for (let i = 0; i < MAX_BODIES; i++) {
    const ent = getEntityByIndex(i);
    fadeArr[i] = ent && ent.config && (ent.config.fade !== undefined) ? ent.config.fade : fadeDefault;
    range1Arr[i] = ent && ent.config && (ent.config.range1 !== undefined) ? ent.config.range1 : range1Default;
    range2Arr[i] = ent && ent.config && (ent.config.range2 !== undefined) ? ent.config.range2 : range2Default;
    scaleArr[i] = ent && ent.config && (ent.config.scale !== undefined) ? ent.config.scale : scaleDefault;
    falloffArr[i] = ent && ent.config && (ent.config.falloff !== undefined) ? ent.config.falloff : falloffDefault;
    specArr[i] = ent && ent.config && (ent.config.specularStrength !== undefined) ? ent.config.specularStrength : specDefault;
    normalDivArr[i] = ent && ent.config && (ent.config.normalDivider !== undefined) ? ent.config.normalDivider : normalDivDefault;
    blobArr[i] = ent && ent.config && (ent.config.blobSize !== undefined) ? ent.config.blobSize : blobDefault;
  }

  if (buf && buf.uniforms.uBlobSizeArray) buf.uniforms.uBlobSizeArray.value = blobArr;
  if (buf && buf.uniforms.uFadeArray) buf.uniforms.uFadeArray.value = fadeArr;
  if (buf && buf.uniforms.uRange1Array) buf.uniforms.uRange1Array.value = range1Arr;
  if (buf && buf.uniforms.uScaleArray) buf.uniforms.uScaleArray.value = scaleArr;
  if (buf && buf.uniforms.uFalloffArray) buf.uniforms.uFalloffArray.value = falloffArr;
  if (buf && buf.uniforms.uNormalDividerArray) buf.uniforms.uNormalDividerArray.value = normalDivArr;

  if (img && img.uniforms.uBlobSizeArray) img.uniforms.uBlobSizeArray.value = blobArr;
  if (img && img.uniforms.uRange2Array) img.uniforms.uRange2Array.value = range2Arr;
  if (img && img.uniforms.uSpecularStrengthArray) img.uniforms.uSpecularStrengthArray.value = specArr;
  if (img && img.uniforms.uNormalDividerArray) img.uniforms.uNormalDividerArray.value = normalDivArr;

  if (buf) buf.needsUpdate = true;
  if (img) img.needsUpdate = true;
}

function updateConfig(updates = {}) {
  // merge new values into global CONFIG
  Object.assign(CONFIG, updates);

  // safe refs to shader materials created in init()
  const bufferA = init && init._bufferA;
  const imageMat = init && init._imageMat;
  if (!bufferA && !imageMat) return; // nothing to update yet

  // helper to set uniform value if present
  const setUniform = (mat, name, value) => {
    if (!mat || !mat.uniforms || mat.uniforms[name] === undefined) return;
    mat.uniforms[name].value = value;
  };

  // Buffer A uniforms (floats)
  setUniform(bufferA, 'uFade', CONFIG.fade);
  setUniform(bufferA, 'uStrength', CONFIG.strength);
  setUniform(bufferA, 'uRange1', CONFIG.range1);
  setUniform(bufferA, 'uSpeed', CONFIG.speed);
  setUniform(bufferA, 'uScale', CONFIG.scale);
  setUniform(bufferA, 'uFalloff', CONFIG.falloff);
  setUniform(bufferA, 'uBlobSize', CONFIG.blobSize);
  setUniform(bufferA, 'uNormalDivider', CONFIG.normalDivider);
  setUniform(bufferA, 'uFallBackRadius', CONFIG.fallBackRadius);
  setUniform(bufferA, 'uFallBackSpeed', CONFIG.fallBackSpeed);
  setUniform(imageMat, 'uIdMixRadius',   CONFIG.idMixRadius);
  setUniform(imageMat, 'uIdMixSoftness', CONFIG.idMixSoftness);

  // Image/material uniforms (mix of floats and vec3)
  setUniform(imageMat, 'uRange2', CONFIG.range2);
  if (imageMat && imageMat.uniforms && imageMat.uniforms.uInkBase !== undefined) {
    setUniform(imageMat, 'uInkBase', new THREE.Vector3(...CONFIG.inkBase));
  }
  setUniform(imageMat, 'uAmbientWeight', CONFIG.ambientWeight);
  if (imageMat && imageMat.uniforms && imageMat.uniforms.uInkTint !== undefined) {
    setUniform(imageMat, 'uInkTint', new THREE.Vector3(...CONFIG.inkTint));
  }
  if (imageMat && imageMat.uniforms && imageMat.uniforms.uBackground !== undefined) {
    setUniform(imageMat, 'uBackground', new THREE.Vector3(...CONFIG.background));
  }
  setUniform(imageMat, 'uSpecularStrength', CONFIG.specularStrength);
  setUniform(imageMat, 'uSpecularExponent', CONFIG.specularExponent);
  setUniform(imageMat, 'uDitherStrength', CONFIG.ditherStrength);
  setUniform(imageMat, 'uNormalDivider', CONFIG.normalDivider);
  setUniform(imageMat, 'uBlueNoiseScale', CONFIG.blueNoiseScale);
  setUniform(imageMat, 'uFallBackRadius', CONFIG.fallBackRadius);
  setUniform(imageMat, 'uFallBackSpeed', CONFIG.fallBackSpeed);
  setUniform(imageMat, 'uMixEdgeMin', CONFIG.mixEdgeMin);
  setUniform(imageMat, 'uMixEdgeMax', CONFIG.mixEdgeMax);

  // ensure three.js picks up changes (not required for uniforms, but safe)
  if (bufferA) bufferA.needsUpdate = true;
  if (imageMat) imageMat.needsUpdate = true;
}

// ---- THREE bootstrap (same structure as molten.js) ---------------------------
let camera, scene, renderer, plane;
let iResolution = new THREE.Vector3();
let startTime = performance.now();
let lastTime = startTime;
let frame = 0;

let targetA1, targetA2;               // ping-pong for Buffer A
let volumeNoiseTex, blueNoiseTex;     // iChannel0 / iChannel1 for our shaders

// Creating animation parameters config
let CONFIG = {
    'blobSize': 0.015, // size of ink blobs
    'fade': 0.55, // fade speed, if large, fades faster
    'strength': 1.0,  // flicker and grain strength
    'range1': 5.0,  // ink tail spread width
    'range2': 3.0,  // ink lighting normal spread (color depth)
    'speed': 0.1, // speed of noise evolution, spice (wiggliness/inkspread noise)
    'scale': 0.1, // tail spread noise scale
    'falloff': 1.0, // spread fluidity and turbulence
    'inkBase': [0.15, 0.0, 0.0],    // base ink color
    'ambientWeight': 0.8,  // ambient/base ink weight (how much the ink resembles base color)
    'inkTint': [3.0, 3.0, 3.0],    // color of the ghost around ink tail
    'background': [1.0, 1.0, 1.0], // paper/background color
    'specularStrength': 0.5, // strength of specular highlights def: 0.5 (How shiny the ink is
    'specularExponent': 10.0, // exponent for specular highlights def: 20.0 (how wide the lit part is in the middle)
    'ditherStrength': 0.1, // strength of dithering effect def: 0.1, Graininess of the ink
    'normalDivider': 472.0, // divisor for normal calculation def: 472.0  SPREAD OUT PARAMETER: smaller = more spread, don't get below 100
    'blueNoiseScale': 1024.0, // scale for blue noise texture def: 1024.0, added blue noise for velvetiness
    'fallBackRadius': 0.3, // fallback radius for ink blobs when no input def: 0.3
    'fallBackSpeed': 2.0, // speed for fallback ink blob movement def: 2.0
    'mixEdgeMin': 0.005, // minimum edge mix for ink to background def: 0.01
    'mixEdgeMax': 0.2, // maximum edge mix for ink to background def: 0.1
    'idMixRadius': 0,    // 1..2 px works well
    'idMixSoftness': 0.9 // lower = more sensitive seam blending
}


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

// javascript
// javascript
const bufferA_frag = `
precision highp float;
uniform float iTime;
uniform float iTimeDelta;
uniform vec3  iResolution;
uniform vec4  iMouseArray[${MAX_BODIES}];
uniform sampler2D iChannel0; // volume noise
uniform sampler2D iChannel1; // previous frame (x=paint, y=idNorm)
uniform float uFade;
uniform float uStrength;
uniform float uRange1;
uniform float uSpeed;
uniform float uScale;
uniform float uFalloff;
uniform float uBlobSize;
uniform float uNormalDivider;
uniform float uFallBackRadius;
uniform float uFallBackSpeed;

// per-entity arrays
uniform float uBlobSizeArray[${MAX_BODIES}];
uniform float uFadeArray[${MAX_BODIES}];
uniform float uRange1Array[${MAX_BODIES}];
uniform float uScaleArray[${MAX_BODIES}];
uniform float uFalloffArray[${MAX_BODIES}];
uniform float uNormalDividerArray[${MAX_BODIES}];

${commonShader}

vec3 fbmSlot(vec3 p, float slotFalloff){
  vec3 r = vec3(0.0);
  float a = 0.5;
  for (float i = 0.0; i < 3.0; ++i) {
    vec2 uv = p.xy / a;
    float zOff = (p.z + i * 0.33) * 0.1;
    float tv = p.z * 0.25;
    vec2 tOf = vec2(sin(tv + i * 2.0) * 0.03, cos(tv * 1.3 + i * 1.5) * 0.025);
    uv += vec2(zOff * 0.5, zOff * 0.7) + tOf;
    r += texture2D(iChannel0, uv).xyz * a;
    a /= slotFalloff;
  }
  return r;
}

int idxFromNorm(float idNorm) {
  float idxf = idNorm * float(${MAX_BODIES});
  int idx = int(floor(idxf + 0.5));
  if (idx < 0) idx = 0;
  if (idx >= ${MAX_BODIES}) idx = ${MAX_BODIES - 1};
  return idx;
}

void main(){
  vec2 uvC = (gl_FragCoord.xy - iResolution.xy * 0.5) / iResolution.y;
  vec2 aspect = vec2(iResolution.x / iResolution.y, 1.0);

  float bestPaint = 0.0;
  float bestIdNorm = 0.0;
  bool any = false;

  // Collect splats; choose strongest new splat for id
  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (iMouseArray[i].z > 0.5) {
      any = true;
      float slotScale = uScaleArray[i];
      float slotFalloff = uFalloffArray[i];
      float slotBlob = uBlobSizeArray[i];

      vec2 m = (iMouseArray[i].xy - iResolution.xy * 0.5) / iResolution.y;
      vec2 luv = uvC - m;

      float seed = float(i) * 13.17;
      vec3 spice = fbmSlot(vec3(luv * (slotScale * 0.8) + seed, iTime * uSpeed + seed), slotFalloff);
      float jitterRadius = clamp(slotBlob * 0.06, 0.005, 0.1);
      vec2 slotOffset = vec2(cos(spice.x * 6.283 + seed), sin(spice.x * 6.283 + seed)) * jitterRadius;

      float slotPaint = trace(length(luv + slotOffset), slotBlob);
      if (slotPaint > bestPaint) {
        bestPaint = slotPaint;
        bestIdNorm = (float(i) + 0.5) / float(${MAX_BODIES});
      }
    }
  }

//  // Fallback motion
//  if (!any) {
//    float t = iTime * uFallBackSpeed;
//    vec2 fbPos = vec2(cos(t) * uFallBackRadius, sin(t * 1.3) * uFallBackRadius);
//    vec2 luv = uvC - fbPos;
//    vec3 spice = fbmSlot(vec3(luv * (uScale * 0.8), iTime * uSpeed), uFalloff);
//    vec2 fbOffset = vec2(cos(spice.x * 6.283), sin(spice.x * 6.283)) * (uBlobSize * 0.03);
//    bestPaint = max(bestPaint, trace(length(luv + fbOffset), uFallBackRadius));
//    bestIdNorm = 0.5 / float(${MAX_BODIES});
//  }

  // Previous frame advection
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  vec4 centerSample = texture2D(iChannel1, uv);
  float center = centerSample.x;
  float centerIdNorm = centerSample.y;
  int centerIdx = idxFromNorm(centerIdNorm);
  float hasInk = step(1e-5, center);

  float useRange1     = mix(uRange1,        uRange1Array[centerIdx],        hasInk);
  float useNormalDiv  = mix(uNormalDivider, uNormalDividerArray[centerIdx], hasInk);
  float useScale      = mix(uScale,         uScaleArray[centerIdx],         hasInk);
  float useFalloff    = mix(uFalloff,       uFalloffArray[centerIdx],       hasInk);

  vec3 unit = vec3(useRange1 / useNormalDiv / aspect, 0.0);
  float l = texture2D(iChannel1, uv - unit.xz).x;
  float r = texture2D(iChannel1, uv + unit.xz).x;
  float u = texture2D(iChannel1, uv - unit.zy).x;
  float d = texture2D(iChannel1, uv + unit.zy).x;
  vec3 normal = normalize(vec3(l - r, u - d, center * center) + 0.001);

  vec2 offset = -normal.xy;
  vec3 spiceAdv = fbmSlot(vec3(uvC * useScale, iTime * uSpeed), useFalloff);
  float ang = spiceAdv.x * 6.283 * 2.0 + iTime;
  offset += vec2(cos(ang), sin(ang));

  vec2 advUV = uv + uStrength * offset / aspect / useNormalDiv;
  vec4 advSample = texture2D(iChannel1, advUV);
  float prevIdNorm = advSample.y;
  int prevIdx = idxFromNorm(prevIdNorm);
  float prevFade = uFadeArray[prevIdx];
  float prevDecayed = advSample.x - iTimeDelta * prevFade;

  // Override logic: if any splat touched this pixel, keep max paint but prefer splat id when it wins
  float splatMask = step(0.0, bestPaint);
  float finalPaint;
  float finalIdNorm;
  if (splatMask > 0.0) {
    float combined = max(prevDecayed, bestPaint);
    bool splatWins = (bestPaint >= prevDecayed);
    finalPaint = combined;
    finalIdNorm = splatWins ? bestIdNorm : prevIdNorm;
  } else {
    finalPaint = prevDecayed;
    finalIdNorm = prevIdNorm;
  }

  gl_FragColor = vec4(clamp(finalPaint, 0.0, 1.0), finalIdNorm, 0.0, 1.0);
}
`;

// image: unchanged logic; reads paint in .x, id in .y for per-entity shading.
const image_frag = `
  precision highp float;
  uniform float iTime;
  uniform vec3  iResolution;
  uniform vec4  iMouseArray[${MAX_BODIES}];
  uniform sampler2D iChannel0; // bufferA (x=paint, y=idNorm)
  uniform sampler2D iChannel1; // blue noise
  uniform float uRange2;
  uniform vec3 uInkBase;
  uniform float uAmbientWeight;
  uniform vec3 uInkTint;
  uniform vec3 uBackground;
  uniform float uNormalDivider;
  uniform float uBlueNoiseScale;
  uniform float uDitherStrength;
  uniform float uMixEdgeMax;
  uniform float uMixEdgeMin;
  uniform float uSpecularExponent;
  uniform float uSpecularStrength;

  // per-entity arrays
  uniform vec3  uInkBaseArray[${MAX_BODIES}];
  uniform vec3  uInkTintArray[${MAX_BODIES}];
  uniform float uRange2Array[${MAX_BODIES}];
  uniform float uSpecularStrengthArray[${MAX_BODIES}];
  uniform float uNormalDividerArray[${MAX_BODIES}];

  // new: seam smoothing controls
  uniform float uIdMixRadius;   // in pixels (e.g., 1.0 - 2.0)
  uniform float uIdMixSoftness; // 0..1 threshold for turning on blend

  ${commonShader}
  void main(){
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    vec2 texel = 1.0 / iResolution.xy;

    // gather 5 taps of bufferA for a soft id average at seams
    vec4 sC = texture2D(iChannel0, uv);
    vec4 sR = texture2D(iChannel0, uv + texel * vec2(+uIdMixRadius, 0.0));
    vec4 sL = texture2D(iChannel0, uv + texel * vec2(-uIdMixRadius, 0.0));
    vec4 sU = texture2D(iChannel0, uv + texel * vec2(0.0, +uIdMixRadius));
    vec4 sD = texture2D(iChannel0, uv + texel * vec2(0.0, -uIdMixRadius));

    float gray = sC.x;

    // fractional owner id from neighborhood
    float idC   = sC.y;
    float idAvg = (idC + sR.y + sL.y + sU.y + sD.y) / 5.0;

    // how strong the seam is around this pixel
    float idDiff = max(max(abs(idC - sR.y), abs(idC - sL.y)),
                       max(abs(idC - sU.y), abs(idC - sD.y)));
    float wBlend = smoothstep(0.0, max(1e-6, uIdMixSoftness), idDiff);

    // blend between two nearest entity slots using averaged id
    float idxfAvg = clamp(idAvg * float(${MAX_BODIES - 1}), 0.0, float(${MAX_BODIES - 1}));
    int   i0 = int(floor(idxfAvg));
    int   i1 = min(i0 + 1, ${MAX_BODIES - 1});
    float t  = fract(idxfAvg) * wBlend;

    // pick and blend per-entity params
    vec3  inkBasePicked   = mix(uInkBaseArray[i0],            uInkBaseArray[i1],            t);
    vec3  inkTintPicked   = mix(uInkTintArray[i0],            uInkTintArray[i1],            t);
    float pickedRange2    = mix(uRange2Array[i0],             uRange2Array[i1],             t);
    float pickedSpec      = mix(uSpecularStrengthArray[i0],   uSpecularStrengthArray[i1],   t);
    float pickedNormalDiv = mix(uNormalDividerArray[i0],      uNormalDividerArray[i1],      t);

    // shading (unchanged, but uses blended params)
    vec3 dither = texture2D(iChannel1, gl_FragCoord.xy/uBlueNoiseScale).rgb;
    vec2 aspect = vec2(iResolution.x/iResolution.y, 1.0);
    vec3 unit = vec3(pickedRange2/pickedNormalDiv/aspect, 0.0);
    vec3 normal = normalize(vec3(
      texture2D(iChannel0, uv + unit.xz).r - texture2D(iChannel0, uv - unit.xz).r,
      texture2D(iChannel0, uv - unit.zy).r - texture2D(iChannel0, uv + unit.zy).r,
      gray*gray*gray));

    float NdotZ = abs(dot(normal, vec3(0,0,1)));
    vec3 lightTerm = inkBasePicked * (1.0 - NdotZ);
    vec3 ambient   = inkBasePicked * uAmbientWeight;
    vec3 color     = ambient + lightTerm;

    vec3 dir = normalize(vec3(0,1,2));
    float spec = pow(dot(normal,dir)*0.5 + 0.5, uSpecularExponent);
    color += vec3(pickedSpec) * smoothstep(0.2, 1.0, spec);

    vec3 tint = inkTintPicked * (0.5 + 0.5 * cos(vec3(1,2,3) * 1.0 + dot(normal,dir)*4.0 - uv.y*3.0 - 3.0));
    color += tint * smoothstep(0.15, 0.0, gray);

    color -= dither.x * uDitherStrength;
    vec3 bg = uBackground;
    bg *= smoothstep(1.5, -0.5, length(uv - 0.5));
    color = mix(bg, clamp(color, 0.0, 1.0), smoothstep(uMixEdgeMin, uMixEdgeMax, gray));
    gl_FragColor = vec4(color, 1.0);
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
      iChannel1: { value: null },    // previous frame (ping-pong)
      uFade: { value: CONFIG.fade },
      uStrength: { value: CONFIG.strength },
      uRange1: { value: CONFIG.range1 },
      uSpeed: { value: CONFIG.speed },
      uScale: { value: CONFIG.scale },
      uFalloff: { value: CONFIG.falloff },
      uBlobSize: { value: CONFIG.blobSize },
      uNormalDivider: { value: CONFIG.normalDivider },
      uFallBackRadius: { value: CONFIG.fallBackRadius },
      uFallBackSpeed: { value: CONFIG.fallBackSpeed },
      uBlobSizeArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.blobSize) },
      uFadeArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.fade) },
      uRange1Array: { value: new Float32Array(MAX_BODIES).fill(CONFIG.range1) },
      uScaleArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.scale) },
      uFalloffArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.falloff) },
      uNormalDividerArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.normalDivider) }
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
        iChannel0: { value: null },
        iChannel1: { value: null },
        uRange2: { value: CONFIG.range2 },
        uInkBase: { value: new THREE.Vector3(...CONFIG.inkBase) },
        uAmbientWeight: { value: CONFIG.ambientWeight },
        uInkTint: { value: new THREE.Vector3(...CONFIG.inkTint) },
        uBackground: { value: new THREE.Vector3(...CONFIG.background) },
        uSpecularStrength: { value: CONFIG.specularStrength },
        uSpecularExponent: { value: CONFIG.specularExponent },
        uDitherStrength: { value: CONFIG.ditherStrength },
        uNormalDivider: { value: CONFIG.normalDivider },
        uBlueNoiseScale: { value: CONFIG.blueNoiseScale },
        uFallBackRadius: { value: CONFIG.fallBackRadius },
        uFallBackSpeed: { value: CONFIG.fallBackSpeed },
        uMixEdgeMin: { value: CONFIG.mixEdgeMin },
        uMixEdgeMax: { value: CONFIG.mixEdgeMax },
        uInkBaseArray: { value: Array.from({length: MAX_BODIES}, () => new THREE.Vector3(...CONFIG.inkBase)) },
        uInkTintArray: { value: Array.from({length: MAX_BODIES}, () => new THREE.Vector3(...CONFIG.inkTint)) },
        uRange2Array: { value: new Float32Array(MAX_BODIES).fill(CONFIG.range2) },
        uSpecularStrengthArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.specularStrength) },
        uNormalDividerArray: { value: new Float32Array(MAX_BODIES).fill(CONFIG.normalDivider) },
        uIdMixRadius: { value: CONFIG.idMixRadius },
        uIdMixSoftness: { value: CONFIG.idMixSoftness }
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

  // seed arrays from trackedEntities / CONFIG so shader sees non-zero blob sizes immediately
  syncPerEntityUniforms();

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

  let bodyPartsIndex = {};
  // reading common body parts map from json
  fetch('/body_map.json')
    .then(response => response.json())
    .then(data => {
        if (data) {
            bodyPartsIndex = data;
            console.log("Loaded body_map.json: ", data);
            // defining which body parts to follow with steady splats
            trackedBodyParts = [
                bodyPartsIndex['right_hand'],
                bodyPartsIndex['left_hand'],
                //bodyPartsIndex['left_foot'],
                //bodyPartsIndex['right_foot']
            ];
            console.log("Tracking body parts IDs: ", trackedBodyParts);
        }
    })
    .catch(error => {
        console.error('Failed to load body_map.json:', error);
    });

  // receive messages from common bridge
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'splat') return;

    // ensure tracked entry exists and allocate a free index (1..MAX_BODIES-1)
    if (!trackedEntities[m.id] && (m.id === bodyPartsIndex['left_hand'] ||
        m.id === bodyPartsIndex['right_hand'])) {
      // use incoming id directly as shader index (0-based)
      if (m.id < 0 || m.id >= MAX_BODIES) {
        console.warn('Incoming id out of range:', m.id);
        return;
      }
      trackedEntities[m.id] = {
        id: m.id,
        index: m.id, // critical: matches iMouseArray & shader loop index
        iMouse: new THREE.Vector4(0, 0, 0, 0),
        iMouseTarget: new THREE.Vector4(0, 0, 0, 0),
        lastSeen: Date.now(),
        config: {
          fade: CONFIG.fade,
          range1: CONFIG.range1,
          range2: CONFIG.range2,
          scale: CONFIG.scale,
          falloff: CONFIG.falloff,
          inkBase: [...CONFIG.inkBase],
          inkTint: [...CONFIG.inkTint],
          specularStrength: CONFIG.specularStrength,
          normalDivider: CONFIG.normalDivider,
          blobSize: CONFIG.blobSize
        }
      };
    }

    const entity = trackedEntities[m.id];

    // convert arena coords -> normalized screen pixels (same mapping as before)
    const arena_x = 3000, arena_y = 3000;
    const norm_x = (-m.x + arena_x) / (2 * arena_x);
    const norm_y = (m.y + arena_y) / (2 * arena_y);
    const pr = window.devicePixelRatio || 1;
    const screenX = norm_x * window.innerWidth * pr;
    const screenY = (1.0 - norm_y) * window.innerHeight * pr;

    if (m.id === bodyPartsIndex['left_hand'] || m.id === bodyPartsIndex['right_hand']) {
        entity.lastSeen = Date.now();

        // set immediate position to avoid jump if previously unset
        if (entity.iMouseTarget.z === 0 && entity.iMouseTarget.w === 0) {
          entity.iMouse.x = screenX;
          entity.iMouse.y = screenY;
        }

        // update target (z/w used as >0 active flag)
        entity.iMouseTarget.x = screenX;
        entity.iMouseTarget.y = screenY;
        entity.iMouseTarget.z = screenX;
        entity.iMouseTarget.w = screenY;

    }

    const minZHand = 200, maxZHand = 2000;
    const minZFoot = 0, maxZFoot = 1500;
    const minScale = 0.1, maxScale = 0.2;
    const minFalloff = 1.0, maxFalloff = 1.1;
    const maxBlobSize = 0.1; const minBlobSize = 0.01;
    const minMixEdgeMax = 0.1; const maxMixEdgeMax = 0.8;
    const normX = Math.abs(m.x / 3000); // arena x range assumed -3000..+3000
    const normY = Math.abs(m.y / 3000); // arena y range assumed -3000..+3000
    const normZHand = Math.min(Math.max((m.z - minZHand) / (maxZHand - minZHand), 0.0), 1.0);
    const normZFoot = Math.min(Math.max((m.z - minZFoot) / (maxZFoot - minZFoot), 0.0), 1.0);

    // Changing hand blob size according to depth, disappearing above threshold
    let blobSize = minBlobSize + (maxBlobSize - minBlobSize) * (1.0 - normZHand);
    if (m.z >= maxZHand) {
      blobSize = 0.0;
    } else {
      blobSize = minBlobSize + (maxBlobSize - minBlobSize) * (1.0 - normZHand);
    }

    // mixEdgeMax adjustment based on depth of left foot
    let edgeMaxValueFoot = maxMixEdgeMax - (minMixEdgeMax + (maxMixEdgeMax - minMixEdgeMax) * (1.0 - normZFoot));
    if (m.z < minZFoot) {
        edgeMaxValueFoot = 0.1;
    }

    //console.log(`Entity ${m.id} at (${m.x.toFixed(1)}, ${m.y.toFixed(1)}) -> screen (${screenX.toFixed(1)}, ${screenY.toFixed(1)}), blobSize: ${entity.config.blobSize.toFixed(3)}`);
    // Pattern 2: per-entity tint using trackedEntities.config (scale/mutate entity config here)
    if (m.id === bodyPartsIndex['left_hand']) {
        entity.config.inkBase = [0.0, (1.0-normX)*0.1, 0.0];   // deep green
        entity.config.blobSize = blobSize;
    } else if (m.id === bodyPartsIndex['right_hand']) {
        entity.config.inkBase = [(1.0-normY)*0.1, 0.0, 0.0];  //deep red
        entity.config.blobSize = blobSize;
    } else if (m.id === bodyPartsIndex['left_foot']) {
        trackedBodyParts = trackedBodyParts.filter(id => id !== m.id);
        updateConfig(updates = {'mixEdgeMax': edgeMaxValueFoot});
    } else {
      // any other entity is deleted (not tracked)
      trackedBodyParts = trackedBodyParts.filter(id => id !== m.id);
    }
    // push per-entity values into shader uniforms
    syncPerEntityUniforms();
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
  //rebuildIMouseArray();
  requestAnimationFrame(animate);

  cleanupEntities();

  // time + dt like original ink.js
  const now = performance.now();
  const t  = (now - startTime)/1000;
  const dt = Math.min(0.05, Math.max(0, (now - lastTime)/1000)); // clamp to avoid spikes
  lastTime = now;

  // smooth local mouse (slot 0)
  const MOUSE_SLOT = MAX_BODIES - 1;
  iMouseArray[MOUSE_SLOT].x += (iMouseTarget.x - iMouseArray[MOUSE_SLOT].x) * MOUSE_SMOOTHING;
  iMouseArray[MOUSE_SLOT].y += (iMouseTarget.y - iMouseArray[MOUSE_SLOT].y) * MOUSE_SMOOTHING;
  iMouseArray[MOUSE_SLOT].z = iMouseTarget.z;
  iMouseArray[MOUSE_SLOT].w = iMouseTarget.w;

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