// Kaleidoscope Background Shader
// Converted from ISF format to THREE.js
// Original by @dot2dot (bareimage): 
// https://github.com/bareimage/ISF/blob/main/Release.5/IM-KaleidoKnot.fs

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
let iResolution = new THREE.Vector3();

// Render targets for multi-pass ISF shader (6 persistent buffers)
let timeBuffer, paramBufferA, pulsationTimeBuffer, rotationBuffer, colorBuffer, controlsBuffer;
let timeBufferPingPong, paramBufferPingPong, pulsationBufferPingPong, rotationBufferPingPong, colorBufferPingPong, controlsBufferPingPong;

// Materials for each pass
let timePassMaterial, paramPassMaterial, pulsationPassMaterial, rotationPassMaterial, colorPassMaterial, controlsPassMaterial, finalPassMaterial;

// Quad for fullscreen rendering
let quad;

// Frame counter and time tracking
let frameIndex = 0;
let startTime = Date.now();
let lastTime = Date.now();

// Shader parameters (from ISF inputs)
const params = {
    speed: 4.0,
    transitionSpeed: 2.0,
    kaleidoscopeSegments: 6.0,
    rotationSpeed: 0.2,
    distortionAmount: 0.2,
    lineFrequency: 50.0,
    pulsationSpeed: 0.1,
    warpFactor: 1.0,
    colorPalette: 2,  // Nebula
    colorAnimSpeed: 0.2,
    colorBrightness: 1.5,
    patternScale: 3.0,
    patternComplexity: 0.5,
    centerFadeRadius: 0.1,
    centerFadeSharpness: 10.0
};

// Common shader code (utility functions)
const commonShaderCode = `
#define PI 3.14159265359
#define TAU (2.0 * PI)

vec3 hsv2rgb(vec3 c) {
    vec4 K=vec4(1.,2./3.,1./3.,3.);
    vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);
    return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);
}

float hash11(float p) { return fract(sin(p*727.1)*435.545); }

vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
}

float noise(vec3 x) {
    vec3 p=floor(x), f=fract(x);
    f=f*f*(3.-2.*f);
    float n=p.x+p.y*157.+113.*p.z;
    return mix(mix(mix(hash11(n),hash11(n+1.),f.x),mix(hash11(n+157.),hash11(n+158.),f.x),f.y),
               mix(mix(hash11(n+113.),hash11(n+114.),f.x),mix(hash11(n+270.),hash11(n+271.),f.x),f.y),f.z);
}

vec3 aces_approx(vec3 v) {
    v=max(v,0.);
    float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
    return clamp((v*(a*v+b))/(v*(c*v+d)+e),0.,1.);
}

mat2 rot(float angle) {
    return mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
}

vec2 kaleidoscope(vec2 uv, float segments) {
    float angle = atan(uv.y, uv.x);
    float radius = length(uv);
    float segmentAngle = PI / segments;
    angle = mod(angle, segmentAngle);
    if (angle > segmentAngle / 2.0) {
        angle = segmentAngle - angle;
    }
    return vec2(cos(angle), sin(angle)) * radius;
}

vec3 getColor(int p_int, float time, vec3 p, float t, vec4 controls) {
    p *= controls.z;
    vec2 face_uv = p.xy;

    // Stargate
    if(p_int==0){vec3 col=vec3(0.);for(float i=1.;i<3.+10.*controls.w;i++){float a=atan(face_uv.y,face_uv.x)*ceil(i*2.5)+time*2.*sin(i*i)+i*i;col+=25./(abs(length(face_uv)*6.-i*1.5)+40.)*clamp(cos(a),0.,0.8)*(cos(a-i+vec4(0,1,2,0))+1.).rgb;}return col;}
    // Circuit Board
    if(p_int==1){vec3 grid=abs(fract(p*0.5)-0.5)/0.1;float lines=pow(min(min(grid.x,grid.y),grid.z),0.1+controls.w*0.4);float pulse=sin(p.x*(1.+controls.w*5.)-time)*0.5+0.5;return vec3(lines*pulse*2.,lines*1.5,lines*4.);}
    // Nebula
    if(p_int==2){float f=0.;mat2 m=mat2(1.6,1.2,-1.2,1.6);p*=0.5;for(int i=0;i<3+int(controls.w*4.);i++){f+=noise(p)*pow(0.5,float(i));p.xy*=m;}return hsv2rgb(vec3(f+time*0.05,0.8,1.));}
    // Psychedelic Tunnels
    if(p_int==3){vec2 p_polar=vec2(atan(face_uv.y,face_uv.x),log(length(face_uv)));float k=1.+controls.w*10.;float a=p_polar.x+time*0.5;a=floor(a*k)/k;p_polar=vec2(p_polar.y*cos(a)-a*sin(a),p_polar.y*sin(a)+a*cos(a));return hsv2rgb(vec3(fract(p_polar.x*.2+time*.1),1.,smoothstep(0.,1.,fract(p_polar.y*5.))));}
    // Turing Spots
    if(p_int==4){vec2 g=floor(face_uv*3.),f=fract(face_uv*3.)-.5;float d=1e9;vec3 c;for(int i=-1;i<=1;i++)for(int j=-1;j<=1;j++){vec2 o=hash2(g+vec2(i,j));float D=length(f-o+.5);if(D<d){d=D;c=hsv2rgb(vec3(hash11(g.x+g.y*157.+time*.1),.7,.9));}}return(1.-smoothstep(0.,.8,d))*c;}
    // Labyrinth
    if(p_int==5){float n=noise(p*0.5);float pattern=sin(n*15.+time*2.+sin(p.y+n)*2.);pattern=smoothstep(0.,1.,pattern);return hsv2rgb(vec3(fract(n+time*0.1),0.8,pattern));}
    // Coral Growth
    if(p_int==6){vec2 p_warp=face_uv;for(int i=0;i<3+int(controls.w*5.);i++){p_warp=abs(p_warp)/dot(p_warp,p_warp)-.8+sin(time*0.2)*0.1;}return hsv2rgb(vec3(fract(p_warp.x*.2),1.,1.));}
    // Cellular
    if(p_int==7){vec2 st=floor(face_uv/10.*(5.+controls.w*20.));float h=hash11(st.x+st.y*157.);float on=step(0.5,fract(h*10.+time*h));return vec3(on)*hsv2rgb(vec3(fract(h*3.),1.,1.));}

    return vec3(0.8);
}
`;

init();
animate();

function init() {
    // Camera and scene setup
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene = new THREE.Scene();

    // Renderer setup
    renderer = new THREE.WebGLRenderer();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    iResolution.set(window.innerWidth, window.innerHeight, 1);

    // Create 1x1 pixel render targets for persistent buffers
    const bufferOptions = {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.FloatType
    };

    // Create ping-pong buffers
    timeBuffer = new THREE.WebGLRenderTarget(1, 1, bufferOptions);
    timeBufferPingPong = new THREE.WebGLRenderTarget(1, 1, bufferOptions);

    paramBufferA = new THREE.WebGLRenderTarget(1, 1, bufferOptions);
    paramBufferPingPong = new THREE.WebGLRenderTarget(1, 1, bufferOptions);

    pulsationTimeBuffer = new THREE.WebGLRenderTarget(1, 1, bufferOptions);
    pulsationBufferPingPong = new THREE.WebGLRenderTarget(1, 1, bufferOptions);

    rotationBuffer = new THREE.WebGLRenderTarget(1, 1, bufferOptions);
    rotationBufferPingPong = new THREE.WebGLRenderTarget(1, 1, bufferOptions);

    colorBuffer = new THREE.WebGLRenderTarget(1, 1, bufferOptions);
    colorBufferPingPong = new THREE.WebGLRenderTarget(1, 1, bufferOptions);

    controlsBuffer = new THREE.WebGLRenderTarget(1, 1, bufferOptions);
    controlsBufferPingPong = new THREE.WebGLRenderTarget(1, 1, bufferOptions);

    // Create quad geometry
    const quadGeometry = new THREE.PlaneGeometry(2, 2);

    // Create materials for each pass
    createPassMaterials();

    // Create quad mesh
    quad = new THREE.Mesh(quadGeometry, finalPassMaterial);
    scene.add(quad);

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);
}

function createPassMaterials() {
    // Pass 0: Time & Speed Buffer
    timePassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            timeBuffer: { value: timeBuffer.texture },
            speed: { value: params.speed },
            colorAnimSpeed: { value: params.colorAnimSpeed },
            transitionSpeed: { value: params.transitionSpeed },
            timeDelta: { value: 0 },
            frameIndex: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: commonShaderCode + `
            uniform sampler2D timeBuffer;
            uniform float speed;
            uniform float colorAnimSpeed;
            uniform float transitionSpeed;
            uniform float timeDelta;
            uniform int frameIndex;
            varying vec2 vUv;

            void main() {
                vec4 pD = texture2D(timeBuffer, vec2(0.5));
                float mainTime = pD.r, smSpeed = pD.g, colorTime = pD.b, smColorSpeed = pD.a;

                float n_smSpeed = mix(smSpeed, speed, min(1.0, timeDelta * transitionSpeed));
                float n_smColorSpeed = mix(smColorSpeed, colorAnimSpeed, min(1.0, timeDelta * transitionSpeed));
                float n_mainTime = mainTime + n_smSpeed * timeDelta;
                float n_colorTime = colorTime + n_smColorSpeed * timeDelta;

                if (frameIndex == 0) {
                    n_mainTime = 0.0; n_smSpeed = speed;
                    n_colorTime = 0.0; n_smColorSpeed = colorAnimSpeed;
                }
                gl_FragColor = vec4(n_mainTime, n_smSpeed, n_colorTime, n_smColorSpeed);
            }
        `
    });

    // Pass 1: Geometry Parameters
    paramPassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            paramBufferA: { value: paramBufferA.texture },
            kaleidoscopeSegments: { value: params.kaleidoscopeSegments },
            distortionAmount: { value: params.distortionAmount },
            lineFrequency: { value: params.lineFrequency },
            warpFactor: { value: params.warpFactor },
            transitionSpeed: { value: params.transitionSpeed },
            timeDelta: { value: 0 },
            frameIndex: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D paramBufferA;
            uniform float kaleidoscopeSegments;
            uniform float distortionAmount;
            uniform float lineFrequency;
            uniform float warpFactor;
            uniform float transitionSpeed;
            uniform float timeDelta;
            uniform int frameIndex;
            varying vec2 vUv;

            void main() {
                vec4 pP = texture2D(paramBufferA, vec2(0.5));
                vec4 cP;
                if (frameIndex == 0) {
                    cP = vec4(kaleidoscopeSegments, distortionAmount, lineFrequency, warpFactor);
                } else {
                    cP.r = mix(pP.r, kaleidoscopeSegments, min(1.0, timeDelta * transitionSpeed));
                    cP.g = mix(pP.g, distortionAmount, min(1.0, timeDelta * transitionSpeed));
                    cP.b = mix(pP.b, lineFrequency, min(1.0, timeDelta * transitionSpeed));
                    cP.a = mix(pP.a, warpFactor, min(1.0, timeDelta * transitionSpeed));
                }
                gl_FragColor = cP;
            }
        `
    });

    // Pass 2: Pulsation Time
    pulsationPassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            pulsationTimeBuffer: { value: pulsationTimeBuffer.texture },
            pulsationSpeed: { value: params.pulsationSpeed },
            transitionSpeed: { value: params.transitionSpeed },
            timeDelta: { value: 0 },
            frameIndex: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D pulsationTimeBuffer;
            uniform float pulsationSpeed;
            uniform float transitionSpeed;
            uniform float timeDelta;
            uniform int frameIndex;
            varying vec2 vUv;

            void main() {
                vec4 pD = texture2D(pulsationTimeBuffer, vec2(0.5));
                float pT = pD.r, pS = pD.g;
                float nS = mix(pS, pulsationSpeed, min(1.0, timeDelta * transitionSpeed));
                float nT = pT + nS * timeDelta;
                if(frameIndex == 0) { nT = 0.0; nS = pulsationSpeed; }
                gl_FragColor = vec4(nT, nS, 0.0, 1.0);
            }
        `
    });

    // Pass 3: Rotation Angle
    rotationPassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            rotationBuffer: { value: rotationBuffer.texture },
            rotationSpeed: { value: params.rotationSpeed },
            transitionSpeed: { value: params.transitionSpeed },
            timeDelta: { value: 0 },
            frameIndex: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D rotationBuffer;
            uniform float rotationSpeed;
            uniform float transitionSpeed;
            uniform float timeDelta;
            uniform int frameIndex;
            varying vec2 vUv;

            void main() {
                vec4 pD = texture2D(rotationBuffer, vec2(0.5));
                float pA = pD.r, pS = pD.g;
                float nS = mix(pS, rotationSpeed, min(1.0, timeDelta * transitionSpeed));
                float nA = pA + nS * timeDelta;
                if(frameIndex == 0) { nA = 0.0; nS = rotationSpeed; }
                gl_FragColor = vec4(nA, nS, 0.0, 1.0);
            }
        `
    });

    // Pass 4: Color Palette Selection
    colorPassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            colorPalette: { value: params.colorPalette }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform int colorPalette;
            varying vec2 vUv;

            void main() {
                gl_FragColor = vec4(float(colorPalette), 0.0, 0.0, 1.0);
            }
        `
    });

    // Pass 5: Color Controls
    controlsPassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            controlsBuffer: { value: controlsBuffer.texture },
            colorBrightness: { value: params.colorBrightness },
            patternScale: { value: params.patternScale },
            patternComplexity: { value: params.patternComplexity },
            transitionSpeed: { value: params.transitionSpeed },
            timeDelta: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D controlsBuffer;
            uniform float colorBrightness;
            uniform float patternScale;
            uniform float patternComplexity;
            uniform float transitionSpeed;
            uniform float timeDelta;
            varying vec2 vUv;

            void main() {
                vec4 pV = texture2D(controlsBuffer, vec2(0.5));
                vec4 tV = vec4(colorBrightness, patternScale, patternComplexity, 0.0);
                gl_FragColor = mix(pV, tV, min(1.0, timeDelta * transitionSpeed));
            }
        `
    });

    // Final Pass: Composite render
    finalPassMaterial = new THREE.ShaderMaterial({
        uniforms: {
            timeBuffer: { value: timeBuffer.texture },
            paramBufferA: { value: paramBufferA.texture },
            pulsationTimeBuffer: { value: pulsationTimeBuffer.texture },
            rotationBuffer: { value: rotationBuffer.texture },
            colorBuffer: { value: colorBuffer.texture },
            controlsBuffer: { value: controlsBuffer.texture },
            iResolution: { value: iResolution },
            centerFadeRadius: { value: params.centerFadeRadius },
            centerFadeSharpness: { value: params.centerFadeSharpness },
            audioRMS: { value: 0 },
            audioPeak: { value: 0 },
            audioFreq: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: commonShaderCode + `
            uniform sampler2D timeBuffer;
            uniform sampler2D paramBufferA;
            uniform sampler2D pulsationTimeBuffer;
            uniform sampler2D rotationBuffer;
            uniform sampler2D colorBuffer;
            uniform sampler2D controlsBuffer;
            uniform vec3 iResolution;
            uniform float centerFadeRadius;
            uniform float centerFadeSharpness;
            uniform float audioRMS;
            uniform float audioPeak;
            uniform float audioFreq;
            varying vec2 vUv;

            void main() {
                vec4 timeData = texture2D(timeBuffer, vec2(0.5));
                vec4 paramsA = texture2D(paramBufferA, vec2(0.5));
                vec4 pulsationData = texture2D(pulsationTimeBuffer, vec2(0.5));
                vec4 rotationData = texture2D(rotationBuffer, vec2(0.5));
                vec4 paletteData = texture2D(colorBuffer, vec2(0.5));
                vec4 controlsData = texture2D(controlsBuffer, vec2(0.5));

                float effectiveTime = timeData.r;
                float colorTime = timeData.b;

                float segments = paramsA.r;
                float distortionMax = paramsA.g;
                float lineFreq = paramsA.b;
                float warp = paramsA.a;

                float pulsationTime = pulsationData.r;
                float rotationAngle = rotationData.r;

                int paletteIndex = int(paletteData.r);
                vec4 colorControls = vec4(0.0, controlsData.x, controlsData.y, controlsData.z);

                // Modulate with audio
                segments += audioRMS * 5.0;
                distortionMax += audioPeak * 0.3;
                lineFreq += audioFreq * 0.01;

                vec2 uv = (-1.0 + 2.0 * vUv);
                uv.x *= iResolution.x / iResolution.y;

                uv *= rot(rotationAngle);

                float original_radius = length(uv);

                uv = kaleidoscope(uv, segments);

                float radius = length(uv);
                float angle = atan(uv.y * tan(warp), uv.x);

                float animatedDistortion = distortionMax * (0.5 + 0.5 * sin(effectiveTime));
                float distortion = sin(angle) * animatedDistortion;
                float distorted_radius = radius + distortion;

                float lines = sin(distorted_radius * sin(pulsationTime) * lineFreq);
                lines = smoothstep(-1.0, 1.0, lines / fwidth(lines));

                float centerFalloff = smoothstep(centerFadeRadius, 0.0, original_radius * centerFadeSharpness);
                centerFalloff = clamp(centerFalloff, 0.0, 1.0);

                vec3 p = vec3(uv.x, uv.y, effectiveTime * 0.2);
                vec3 rawColor = getColor(paletteIndex, colorTime, p, radius, colorControls);

                vec3 finalColor = rawColor * lines * colorControls.y;
                finalColor = mix(finalColor, rawColor * colorControls.y, centerFalloff);
                finalColor = aces_approx(finalColor);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `
    });
}

function onWindowResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    iResolution.set(window.innerWidth, window.innerHeight, 1);
    finalPassMaterial.uniforms.iResolution.value = iResolution;
}

function animate() {
    requestAnimationFrame(animate);

    const currentTime = Date.now();
    const timeDelta = (currentTime - lastTime) / 1000.0; // Convert to seconds
    lastTime = currentTime;

    // Update parameters with audio modulation
    params.rotationSpeed = 0.2 + audioMetrics.rms * 0.5;
    params.colorAnimSpeed = 0.2 + audioMetrics.peak * 0.3;

    // Update uniforms
    const timeDeltaClamped = Math.min(timeDelta, 0.1); // Clamp to avoid huge jumps

    // Render Pass 0: Time Buffer
    timePassMaterial.uniforms.speed.value = params.speed;
    timePassMaterial.uniforms.colorAnimSpeed.value = params.colorAnimSpeed;
    timePassMaterial.uniforms.transitionSpeed.value = params.transitionSpeed;
    timePassMaterial.uniforms.timeDelta.value = timeDeltaClamped;
    timePassMaterial.uniforms.frameIndex.value = frameIndex;
    timePassMaterial.uniforms.timeBuffer.value = timeBuffer.texture;
    quad.material = timePassMaterial;
    renderer.setRenderTarget(timeBufferPingPong);
    renderer.render(scene, camera);
    [timeBuffer, timeBufferPingPong] = [timeBufferPingPong, timeBuffer];

    // Render Pass 1: Param Buffer
    paramPassMaterial.uniforms.kaleidoscopeSegments.value = params.kaleidoscopeSegments;
    paramPassMaterial.uniforms.distortionAmount.value = params.distortionAmount;
    paramPassMaterial.uniforms.lineFrequency.value = params.lineFrequency;
    paramPassMaterial.uniforms.warpFactor.value = params.warpFactor;
    paramPassMaterial.uniforms.transitionSpeed.value = params.transitionSpeed;
    paramPassMaterial.uniforms.timeDelta.value = timeDeltaClamped;
    paramPassMaterial.uniforms.frameIndex.value = frameIndex;
    paramPassMaterial.uniforms.paramBufferA.value = paramBufferA.texture;
    quad.material = paramPassMaterial;
    renderer.setRenderTarget(paramBufferPingPong);
    renderer.render(scene, camera);
    [paramBufferA, paramBufferPingPong] = [paramBufferPingPong, paramBufferA];

    // Render Pass 2: Pulsation Time
    pulsationPassMaterial.uniforms.pulsationSpeed.value = params.pulsationSpeed;
    pulsationPassMaterial.uniforms.transitionSpeed.value = params.transitionSpeed;
    pulsationPassMaterial.uniforms.timeDelta.value = timeDeltaClamped;
    pulsationPassMaterial.uniforms.frameIndex.value = frameIndex;
    pulsationPassMaterial.uniforms.pulsationTimeBuffer.value = pulsationTimeBuffer.texture;
    quad.material = pulsationPassMaterial;
    renderer.setRenderTarget(pulsationBufferPingPong);
    renderer.render(scene, camera);
    [pulsationTimeBuffer, pulsationBufferPingPong] = [pulsationBufferPingPong, pulsationTimeBuffer];

    // Render Pass 3: Rotation
    rotationPassMaterial.uniforms.rotationSpeed.value = params.rotationSpeed;
    rotationPassMaterial.uniforms.transitionSpeed.value = params.transitionSpeed;
    rotationPassMaterial.uniforms.timeDelta.value = timeDeltaClamped;
    rotationPassMaterial.uniforms.frameIndex.value = frameIndex;
    rotationPassMaterial.uniforms.rotationBuffer.value = rotationBuffer.texture;
    quad.material = rotationPassMaterial;
    renderer.setRenderTarget(rotationBufferPingPong);
    renderer.render(scene, camera);
    [rotationBuffer, rotationBufferPingPong] = [rotationBufferPingPong, rotationBuffer];

    // Render Pass 4: Color Palette
    colorPassMaterial.uniforms.colorPalette.value = params.colorPalette;
    quad.material = colorPassMaterial;
    renderer.setRenderTarget(colorBufferPingPong);
    renderer.render(scene, camera);
    [colorBuffer, colorBufferPingPong] = [colorBufferPingPong, colorBuffer];

    // Render Pass 5: Controls
    controlsPassMaterial.uniforms.colorBrightness.value = params.colorBrightness;
    controlsPassMaterial.uniforms.patternScale.value = params.patternScale;
    controlsPassMaterial.uniforms.patternComplexity.value = params.patternComplexity;
    controlsPassMaterial.uniforms.transitionSpeed.value = params.transitionSpeed;
    controlsPassMaterial.uniforms.timeDelta.value = timeDeltaClamped;
    controlsPassMaterial.uniforms.controlsBuffer.value = controlsBuffer.texture;
    quad.material = controlsPassMaterial;
    renderer.setRenderTarget(controlsBufferPingPong);
    renderer.render(scene, camera);
    [controlsBuffer, controlsBufferPingPong] = [controlsBufferPingPong, controlsBuffer];

    // Final Render Pass: Composite to screen
    finalPassMaterial.uniforms.timeBuffer.value = timeBuffer.texture;
    finalPassMaterial.uniforms.paramBufferA.value = paramBufferA.texture;
    finalPassMaterial.uniforms.pulsationTimeBuffer.value = pulsationTimeBuffer.texture;
    finalPassMaterial.uniforms.rotationBuffer.value = rotationBuffer.texture;
    finalPassMaterial.uniforms.colorBuffer.value = colorBuffer.texture;
    finalPassMaterial.uniforms.controlsBuffer.value = controlsBuffer.texture;
    finalPassMaterial.uniforms.audioRMS.value = audioMetrics.rms;
    finalPassMaterial.uniforms.audioPeak.value = audioMetrics.peak;
    finalPassMaterial.uniforms.audioFreq.value = audioMetrics.dominant_frequency;
    quad.material = finalPassMaterial;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);

    frameIndex++;
}
