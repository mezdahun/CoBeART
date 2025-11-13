/*
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import backgroundRegistry from '../backgrounds/registry.js';

'use strict';

// Mobile promo section

//const promoPopup = document.getElementsByClassName('promo')[0];
//const promoPopupClose = document.getElementsByClassName('promo-close')[0];
//
//if (isMobile()) {
//    setTimeout(() => {
//        promoPopup.style.display = 'table';
//    }, 20000);
//}
//
//promoPopupClose.addEventListener('click', e => {
//    promoPopup.style.display = 'none';
//});
//
//const appleLink = document.getElementById('apple_link');
//appleLink.addEventListener('click', e => {
//    ga('send', 'event', 'link promo', 'app');
//    window.open('https://apps.apple.com/us/app/fluid-simulation/id1443124993');
//});
//
//const googleLink = document.getElementById('google_link');
//googleLink.addEventListener('click', e => {
//    ga('send', 'event', 'link promo', 'app');
//    window.open('https://play.google.com/store/apps/details?id=games.paveldogreat.fluidsimfree');
//});

// Simulation section

const canvas = document.getElementsByTagName('canvas')[0];
resizeCanvas();

//Main parameters of the fluid simulation
let config = {
    SIM_RESOLUTION: 256,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 3.5,
    VELOCITY_DISSIPATION: 2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 30,
    //CURL is vorticity
    CURL: 5,
    SPLAT_RADIUS: 0.2,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLORFUL: false,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    BLOOM: true,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.0,
    BLOOM_THRESHOLD: 1,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: true,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 0.5,
    SHOW_BACKGROUND: false,
    DYNAMIC_CONFIG: false,
    BACKGROUND_INDEX: 0
}

// Definition of single pointer in canvas
// A pointer is a snapshot of user inputs, such as mouse clicks or drags.
function pointerPrototype() {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [30, 0, 300];
}
// The pointer array will serve as the input for the fluid simulation.
let pointers = [];
let splatStack = [];
pointers.push(new pointerPrototype());

// Variables to track time for the new background shader
const startTime = Date.now();

// Importing WebGL API package related stuff
const { gl, ext } = getWebGLContext(canvas);

if (isMobile()) {
    config.DYE_RESOLUTION = 512;
}
if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
}

startGUI();

function getWebGLContext(canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
        gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2) {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    }
    else {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    ga('send', 'event', isWebGL2 ? 'webgl2' : 'webgl', formatRGBA == null ? 'not supported' : 'supported');

    return {
        gl,
        ext: {
            formatRGBA,
            formatRG,
            formatR,
            halfFloatTexType,
            supportLinearFiltering
        }
    };
}

function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
        switch (internalFormat) {
            case gl.R16F:
                return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F:
                return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:
                return null;
        }
    }

    return {
        internalFormat,
        format
    }
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
}

// Todo: get rid of or hide GUI for production
function startGUI() {
    var gui = new dat.GUI({ width: 300 });
    gui.add(config, 'DYNAMIC_CONFIG').name('Dynamic Config');
    gui.add(config, 'DYE_RESOLUTION', { 'high': 1024, 'medium': 512, 'low': 256, 'very low': 128 }).name('quality').onFinishChange(initFramebuffers);
    gui.add(config, 'SIM_RESOLUTION', { '32': 32, '64': 64, '128': 128, '256': 256 }).name('sim resolution').onFinishChange(initFramebuffers);
    gui.add(config, 'DENSITY_DISSIPATION', 0, 4.0).name('density diffusion');
    gui.add(config, 'VELOCITY_DISSIPATION', 0, 4.0).name('velocity diffusion');
    gui.add(config, 'PRESSURE', 0.0, 1.0).name('pressure');
    gui.add(config, 'CURL', 0, 50).name('vorticity').step(1);
    gui.add(config, 'SPLAT_RADIUS', 0.01, 1.0).name('splat radius');
    gui.add(config, 'SHADING').name('shading').onFinishChange(updateKeywords);
    gui.add(config, 'COLORFUL').name('colorful');
    gui.add(config, 'PAUSED').name('paused').listen();
    gui.add(config, 'SHOW_BACKGROUND').name('show background');

    const bgOptions = {};
    backgroundRegistry.forEach((bg, i) => { bgOptions[bg.name] = i; });
    gui.add(config, 'BACKGROUND_INDEX', bgOptions).name('background');

    gui.add({
        fun: () => {
            splatStack.push(parseInt(Math.random() * 20) + 5);
        }
    }, 'fun').name('Random splats');

    let bloomFolder = gui.addFolder('Bloom');
    bloomFolder.add(config, 'BLOOM').name('enabled').onFinishChange(updateKeywords);
    bloomFolder.add(config, 'BLOOM_INTENSITY', 0.1, 2.0).name('intensity');
    bloomFolder.add(config, 'BLOOM_THRESHOLD', 0.0, 1.0).name('threshold');

    let sunraysFolder = gui.addFolder('Sunrays');
    sunraysFolder.add(config, 'SUNRAYS').name('enabled').onFinishChange(updateKeywords);
    sunraysFolder.add(config, 'SUNRAYS_WEIGHT', 0.3, 1.0).name('weight');

    let captureFolder = gui.addFolder('Capture');
    captureFolder.addColor(config, 'BACK_COLOR').name('background color');
    captureFolder.add(config, 'TRANSPARENT').name('transparent');
    captureFolder.add({ fun: captureScreenshot }, 'fun').name('take screenshot');

    let github = gui.add({
        fun: () => {
            window.open('https://github.com/PavelDoGreat/WebGL-Fluid-Simulation');
            ga('send', 'event', 'link button', 'github');
        }
    }, 'fun').name('Github');
    github.__li.className = 'cr function bigFont';
    github.__li.style.borderLeft = '3px solid #8C8C8C';
    let githubIcon = document.createElement('span');
    github.domElement.parentElement.appendChild(githubIcon);
    githubIcon.className = 'icon github';

    let twitter = gui.add({
        fun: () => {
            ga('send', 'event', 'link button', 'twitter');
            window.open('https://twitter.com/PavelDoGreat');
        }
    }, 'fun').name('Twitter');
    twitter.__li.className = 'cr function bigFont';
    twitter.__li.style.borderLeft = '3px solid #8C8C8C';
    let twitterIcon = document.createElement('span');
    twitter.domElement.parentElement.appendChild(twitterIcon);
    twitterIcon.className = 'icon twitter';

    let discord = gui.add({
        fun: () => {
            ga('send', 'event', 'link button', 'discord');
            window.open('https://discordapp.com/invite/CeqZDDE');
        }
    }, 'fun').name('Discord');
    discord.__li.className = 'cr function bigFont';
    discord.__li.style.borderLeft = '3px solid #8C8C8C';
    let discordIcon = document.createElement('span');
    discord.domElement.parentElement.appendChild(discordIcon);
    discordIcon.className = 'icon discord';

    let app = gui.add({
        fun: () => {
            ga('send', 'event', 'link button', 'app');
            window.open('http://onelink.to/5b58bn');
        }
    }, 'fun').name('Check out mobile app');
    app.__li.className = 'cr function appBigFont';
    app.__li.style.borderLeft = '3px solid #00FF7F';
    let appIcon = document.createElement('span');
    app.domElement.parentElement.appendChild(appIcon);
    appIcon.className = 'icon app';

    // closing gui as default
    gui.close();

    if (isMobile())
        gui.close();
}

function isMobile() {
    return /Mobi|Android/i.test(navigator.userAgent);
}

function captureScreenshot() {
    let res = getResolution(config.CAPTURE_RESOLUTION);
    let target = createFBO(res.width, res.height, ext.formatRGBA.internalFormat, ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);
    render(target);

    let texture = framebufferToTexture(target);
    texture = normalizeTexture(texture, target.width, target.height);

    let captureCanvas = textureToCanvas(texture, target.width, target.height);
    let datauri = captureCanvas.toDataURL();
    downloadURI('fluid.png', datauri);
    URL.revokeObjectURL(datauri);
}

// Fetching current state of WebGL frame buffer into a pixel array (texture)
function framebufferToTexture(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length = target.width * target.height * 4;
    let texture = new Float32Array(length);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
    return texture;
}

// Scale texture pixel values between 0 and 255
function normalizeTexture(texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    for (let i = height - 1; i >= 0; i--) {
        for (let j = 0; j < width; j++) {
            let nid = i * width * 4 + j * 4;
            result[nid + 0] = clamp01(texture[id + 0]) * 255;
            result[nid + 1] = clamp01(texture[id + 1]) * 255;
            result[nid + 2] = clamp01(texture[id + 2]) * 255;
            result[nid + 3] = clamp01(texture[id + 3]) * 255;
            id += 4;
        }
    }
    return result;
}

function clamp01(input) {
    return Math.min(Math.max(input, 0), 1);
}

// Pushing extracted texture to canvas
function textureToCanvas(texture, width, height) {
    let captureCanvas = document.createElement('canvas');
    let ctx = captureCanvas.getContext('2d');
    captureCanvas.width = width;
    captureCanvas.height = height;

    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);

    return captureCanvas;
}

function downloadURI(filename, uri) {
    let link = document.createElement('a');
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

class Material {
    constructor(vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }

    setKeywords(keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++)
            hash += hashCode(keywords[i]);

        let program = this.programs[hash];
        if (program == null) {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }

        if (program == this.activeProgram) return;

        this.uniforms = getUniforms(program);
        this.activeProgram = program;
    }

    bind() {
        gl.useProgram(this.activeProgram);
    }
}

class Program {
    constructor(vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = createProgram(vertexShader, fragmentShader);
        this.uniforms = getUniforms(this.program);
    }

    bind() {
        gl.useProgram(this.program);
    }
}

function createProgram(vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.trace(gl.getProgramInfoLog(program));

    return program;
}

function getUniforms(program) {
    let uniforms = [];
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
        let uniformName = gl.getActiveUniform(program, i).name;
        uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
}

function compileShader(type, source, keywords) {
    source = addKeywords(source, keywords);

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.trace(gl.getShaderInfoLog(shader));

    return shader;
};

function addKeywords(source, keywords) {
    if (keywords == null) return source;
    let keywordsString = '';
    keywords.forEach(keyword => {
        keywordsString += '#define ' + keyword + '\n';
    });
    return keywordsString + source;
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`);

const copyShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        gl_FragColor = texture2D(uTexture, vUv);
    }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`);

const colorShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`);

const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`);

const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;

    vec3 linearToGamma (vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;

    #ifdef SHADING
        vec3 lc = texture2D(uTexture, vL).rgb;
        vec3 rc = texture2D(uTexture, vR).rgb;
        vec3 tc = texture2D(uTexture, vT).rgb;
        vec3 bc = texture2D(uTexture, vB).rgb;

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        c *= diffuse;
    #endif

    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
    #endif

    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
    #ifdef BLOOM
        bloom *= sunrays;
    #endif
    #endif

    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif

        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`);

const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum;
    }
`);

const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum * intensity;
    }
`);

const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec4 c = texture2D(uTexture, vUv);
        float br = max(c.r, max(c.g, c.b));
        c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
        gl_FragColor = c;
    }
`);

const sunraysShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;

    #define ITERATIONS 16

    void main () {
        float Density = 0.3;
        float Decay = 0.95;
        float Exposure = 0.7;

        vec2 coord = vUv;
        vec2 dir = vUv - 0.5;

        dir *= 1.0 / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;

        float color = texture2D(uTexture, vUv).a;

        for (int i = 0; i < ITERATIONS; i++)
        {
            coord -= dir;
            float col = texture2D(uTexture, coord).a;
            color += col * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }

        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`);

const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`);

const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
    #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
    #endif
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
    }`,
    ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']
);

const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`);

const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`);

const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`);

const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target, clear = false) => {
        if (target == null) {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        else {
            gl.viewport(0, 0, target.width, target.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear) {
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        // CHECK_FRAMEBUFFER_STATUS();
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
})();

function CHECK_FRAMEBUFFER_STATUS() {
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE)
        console.trace("Framebuffer error: " + status);
}

let dye;
let velocity;
let divergence;
let curl;
let pressure;
let bloom;
let bloomFramebuffers = [];
let sunrays;
let sunraysTemp;

let ditheringTexture = createTextureAsync('LDR_LLL1_0.png');

// Creating programs from base vertex shader with combination of fragment shaders
const blurProgram = new Program(blurVertexShader, blurShader);
const copyProgram = new Program(baseVertexShader, copyShader);
const clearProgram = new Program(baseVertexShader, clearShader);
const colorProgram = new Program(baseVertexShader, colorShader);
const checkerboardProgram = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram = new Program(baseVertexShader, sunraysShader);
const splatProgram = new Program(baseVertexShader, splatShader);
const advectionProgram = new Program(baseVertexShader, advectionShader);
const divergenceProgram = new Program(baseVertexShader, divergenceShader);
const curlProgram = new Program(baseVertexShader, curlShader);
const vorticityProgram = new Program(baseVertexShader, vorticityShader);
const pressureProgram = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

// Compile all background shaders from the registry
const backgroundPrograms = backgroundRegistry.map(bg =>
  new Program(baseVertexShader, compileShader(gl.FRAGMENT_SHADER, bg.fragmentShader))
);

const displayMaterial = new Material(baseVertexShader, displayShaderSource);

function initFramebuffers() {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const rg = ext.formatRG;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (dye == null)
        dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    else
        dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity == null)
        velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    else
        velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

    initBloomFramebuffers();
    initSunraysFramebuffers();
}

function initBloomFramebuffers() {
    let res = getResolution(config.BLOOM_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
        let width = res.width >> (i + 1);
        let height = res.height >> (i + 1);

        if (width < 2 || height < 2) break;

        let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
        bloomFramebuffers.push(fbo);
    }
}

function initSunraysFramebuffers() {
    let res = getResolution(config.SUNRAYS_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    sunrays = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
}

function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let texelSizeX = 1.0 / w;
    let texelSizeY = 1.0 / h;

    return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX,
        texelSizeY,
        attach(id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
        width: w,
        height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read() {
            return fbo1;
        },
        set read(value) {
            fbo1 = value;
        },
        get write() {
            return fbo2;
        },
        set write(value) {
            fbo2 = value;
        },
        swap() {
            let temp = fbo1;
            fbo1 = fbo2;
            fbo2 = temp;
        }
    }
}

function resizeFBO(target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
}

function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width == w && target.height == h)
        return target;
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
}

function createTextureAsync(url) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));

    let obj = {
        texture,
        width: 1,
        height: 1,
        attach(id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };

    let image = new Image();
    image.onload = () => {
        obj.width = image.width;
        obj.height = image.height;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    };
    image.src = url;

    return obj;
}

function updateKeywords() {
    let displayKeywords = [];
    if (config.SHADING) displayKeywords.push("SHADING");
    if (config.BLOOM) displayKeywords.push("BLOOM");
    if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
    displayMaterial.setKeywords(displayKeywords);
}

updateKeywords();
initFramebuffers();
multipleSplats(parseInt(Math.random() * 20) + 5);

let lastUpdateTime = Date.now();
let colorUpdateTimer = 0.0;
// Latest observed velocity magnitudes from incoming messages
let latestNormVel = 0;
let latestZ = {};
// Latest observed angular velocities from incoming messages
let latestAngVel = { vroll: 0, vpitch: 0, vyaw: 0 };

function computeVelocityDissipation(zdict) {
    // TODO: modify other global variables to have IDs for multiple tracked opbjects
    const posz = zdict[1]
    // zpos between 0 and 1000
    //console.log("z coord: ", posz);
    var z = typeof posz === 'number' ? posz : 0;
    z = Math.max(0, Math.min(z, 2000)) / 2000;
    // higher the z lower the dissipation (between 1 and 4)
    const mindiss = 1.0;
    const maxdiss = 4.0;
    const diss = maxdiss - z * (maxdiss - mindiss);
    //console.log("dissipation: ", z, diss);
    return diss;
}

function computeSplatRadius(normVel) {
    // Map normVel -> splat radius using e^(2*normVel - 2.5) + 0.1
    const v = typeof normVel === 'number' ? normVel : 0;
    return Math.max(0, Math.min(v, 0.8)) / 1.5;
}

function computeCurl(vroll, vpitch, vyaw) {
    // Placeholder mapping f(vroll, vpitch, vyaw) -> CURL in [0, 50]
    // Currently maps angular speed magnitude to the 0..1 range; adjust as needed.
    const rx = typeof vroll === 'number' ? vroll : 0;
    const ry = typeof vpitch === 'number' ? vpitch : 0;
    const rz = typeof vyaw === 'number' ? vyaw : 0;
    const angSpeed = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const normalized = Math.max(0, Math.min(1, angSpeed / 100));
    return normalized * 50.0;
}

// START: This is the call that starts the entire simulation loop
update();

// The main loop that updates the simulation.
function update() {
    const dt = calcDeltaTime();
    const elapsedTime = (Date.now() - startTime) / 1000.0;
    if (resizeCanvas())
        initFramebuffers();
    updateColors(dt);
    // Update splat radius and curl based on latest incoming velocities before applying inputs
//    if (config.DYNAMIC_CONFIG) {
//        config.SPLAT_RADIUS = computeSplatRadius(latestNormVel);
//        console.log("splat radius: ", config.SPLAT_RADIUS);
//        config.VELOCITY_DISSIPATION = computeVelocityDissipation(latestZ);
//        console.log("velocity dissipation: ", config.VELOCITY_DISSIPATION);
//        config.CURL = computeCurl(latestAngVel.vroll, latestAngVel.vpitch, latestAngVel.vyaw);
//    }
    applyInputs();
    if (!config.PAUSED)
        step(dt);
    render(null, elapsedTime);
    requestAnimationFrame(update);
}

function calcDeltaTime() {
    let now = Date.now();
    let dt = (now - lastUpdateTime) / 1000;
    dt = Math.min(dt, 0.016666);
    lastUpdateTime = now;
    return dt;
}

function resizeCanvas() {
    let width = scaleByPixelRatio(canvas.clientWidth);
    let height = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
        return true;
    }
    return false;
}

//todo: modify such that we change color according to movement
function updateColors(dt) {
    if (!config.COLORFUL) return;

    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
        colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
        pointers.forEach(p => {
            p.color = generateColor();
        });
    }
}

function applyInputs() {
    if (splatStack.length > 0)
        multipleSplats(splatStack.pop());

    pointers.forEach(p => {
        if (p.moved) {
            p.moved = false;
            splatPointer(p);
        }
    });
}

function step(dt) {

    //todo: add calculation of different config parameters according to received splat parameters

    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    let velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
}

function render(target, elapsedTime) {
    if (config.BLOOM)
        applyBloom(dye.read, bloom);
    if (config.SUNRAYS) {
        applySunrays(dye.read, dye.write, sunrays);
        blur(sunrays, sunraysTemp, 1);
    }

    if (target == null || !config.TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    }
    else {
        gl.disable(gl.BLEND);
    }

    if (config.SHOW_BACKGROUND) {
        drawBackground(target, elapsedTime);
    } else {
        // Fall back to the original solid color background
        if (!config.TRANSPARENT)
            drawColor(target, normalizeColor(config.BACK_COLOR));
    }

    if (target == null && config.TRANSPARENT)
        drawCheckerboard(target);
    drawDisplay(target);
}

function drawBackground(target, elapsedTime) {
    const currentProgram = backgroundPrograms[config.BACKGROUND_INDEX];
    const bgDef = backgroundRegistry[config.BACKGROUND_INDEX];

    currentProgram.bind();

    // Set uniforms based on which background is active
    if (bgDef.name === 'Electric Clouds') {
        gl.uniform3f(currentProgram.uniforms.iResolution, canvas.width, canvas.height, 1.0);
        gl.uniform1f(currentProgram.uniforms.iTime, elapsedTime * 0.25); // Slow down time by 75%
    } else if (bgDef.name === 'Circles') {
        gl.uniform1f(currentProgram.uniforms.time, elapsedTime);
        gl.uniform2f(currentProgram.uniforms.resolution, canvas.width, canvas.height);
        gl.uniform1f(currentProgram.uniforms.circle_size, 1.59);
        gl.uniform3f(currentProgram.uniforms.fill_color, 0.948, 0.133, 0.185);
        gl.uniform3f(currentProgram.uniforms.grad_color, 0.995, 0.834, 0.0);
    } else if (bgDef.name === 'Zephyr') {
        gl.uniform1f(currentProgram.uniforms.time, elapsedTime);
        gl.uniform2f(currentProgram.uniforms.resolution, canvas.width, canvas.height);
        gl.uniform1f(currentProgram.uniforms.scaling, 0.7);
        gl.uniform1f(currentProgram.uniforms.calm, 1.0);
        gl.uniform1f(currentProgram.uniforms.contrast, 1.1);
        gl.uniform3f(currentProgram.uniforms.color1, 0.9, 0.7, 0.2); // Warm gold
        gl.uniform3f(currentProgram.uniforms.color2, 0.3, 0.7, 1.0); // Cool cyan
    }

    blit(target);
}

function drawColor(target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
}

function drawCheckerboard(target) {
    checkerboardProgram.bind();
    gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    blit(target);
}

function drawDisplay(target) {
    let width = target == null ? gl.drawingBufferWidth : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;

    displayMaterial.bind();
    if (config.SHADING)
        gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    if (config.BLOOM) {
        gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let scale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
    }
    if (config.SUNRAYS)
        gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    blit(target);
}

function applyBloom(source, destination) {
    if (bloomFramebuffers.length < 2)
        return;

    let last = destination;

    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);

    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        let dest = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        blit(dest);
        last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
        let baseTex = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        gl.viewport(0, 0, baseTex.width, baseTex.height);
        blit(baseTex);
        last = baseTex;
    }

    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
}

function applySunrays(source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);

    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
}

function blur(target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
        gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
        gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
        blit(temp);

        gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
        gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
        blit(target);
    }
}

function splatPointer(pointer) {
    let dx = pointer.deltaX * config.SPLAT_FORCE;
    let dy = pointer.deltaY * config.SPLAT_FORCE;
    // getting pointer.splatRadius if this exists, otherwise null
    let splatRadius = pointer.splatRadius !== undefined ? pointer.splatRadius : null;
    splat(pointer.texcoordX, pointer.texcoordY, dx, dy, pointer.color, splatRadius=splatRadius);
}

function multipleSplats(amount) {
    for (let i = 0; i < amount; i++) {
        const color = generateColor();
        color.r *= 10.0;
        color.g *= 10.0;
        color.b *= 10.0;
        const x = Math.random();
        const y = Math.random();
        const dx = 1000 * (Math.random() - 0.5);
        const dy = 1000 * (Math.random() - 0.5);
        splat(x, y, dx, dy, color);
    }
}

function splat(x, y, dx, dy, color, splatRadius=null) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);

    // check if splatRadius is null, then use default, otherwise use passed value
    splatRadius = splatRadius === null ? config.SPLAT_RADIUS : splatRadius;

    gl.uniform1f(splatProgram.uniforms.radius, correctRadius(splatRadius / 100.0));
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
}

function correctRadius(radius) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1)
        radius *= aspectRatio;
    return radius;
}

canvas.addEventListener('mousedown', e => {
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    let pointer = pointers.find(p => p.id == -1);
    if (pointer == null)
        pointer = new pointerPrototype();
    updatePointerDownData(pointer, -1, posX, posY);
});

canvas.addEventListener('mousemove', e => {
    let pointer = pointers[0];
    if (!pointer.down) return;
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    updatePointerMoveData(pointer, posX, posY);
});

window.addEventListener('mouseup', () => {
    updatePointerUpData(pointers[0]);
});

canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const touches = e.targetTouches;
    while (touches.length >= pointers.length)
        pointers.push(new pointerPrototype());
    for (let i = 0; i < touches.length; i++) {
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
    }
});

canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touches = e.targetTouches;
    for (let i = 0; i < touches.length; i++) {
        let pointer = pointers[i + 1];
        if (!pointer.down) continue;
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerMoveData(pointer, posX, posY);
    }
}, false);

window.addEventListener('touchend', e => {
    const touches = e.changedTouches;
    for (let i = 0; i < touches.length; i++) {
        let pointer = pointers.find(p => p.id == touches[i].identifier);
        if (pointer == null) continue;
        updatePointerUpData(pointer);
    }
});

// Accept cursor events from composite parent
window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'cursor') return;
    const px = m.x * canvas.width;
    const py = (1.0 - m.y) * canvas.height;
    const pointer = pointers[0] || new pointerPrototype();
    if (m.down) {
        updatePointerDownData(pointer, -1, px, py);
        if (!pointers.includes(pointer)) pointers[0] = pointer;
    } else if (m.up) {
        updatePointerUpData(pointer);
    } else {
        updatePointerMoveData(pointer, px, py);
    }
});

window.addEventListener('keydown', e => {
    if (e.code === 'KeyP')
        config.PAUSED = !config.PAUSED;
    if (e.key === ' ')
        splatStack.push(parseInt(Math.random() * 20) + 5);
    if (e.key === 'g' || e.key === 'G') {
        if (e.shiftKey) {
            // Shift+G: cycle backwards
            config.BACKGROUND_INDEX = (config.BACKGROUND_INDEX - 1 + backgroundRegistry.length) % backgroundRegistry.length;
        } else {
            // G: cycle forwards
            config.BACKGROUND_INDEX = (config.BACKGROUND_INDEX + 1) % backgroundRegistry.length;
        }
        console.log('Switched to background:', backgroundRegistry[config.BACKGROUND_INDEX].name);
    }
});

// Make external messages (postMessage) act like mouse drags.
// Each message should look like: { type: 'splat', x: 0..1, y: 0..1, id?: number, color?: [r,g,b] }
(function () {
    // Map rigid body IDs → pointer indices, so multiple bodies can paint at once (optional)
    const idToIndex = new Map();

    // Use the first body (if any) to drive the parent “cursor”
    // so molten reacts immediately; fluid receives splats for ALL bodies.
    let bodyPartsIndex = {};
    let trackedBodyParts = [];
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
              bodyPartsIndex['left_foot'],
              bodyPartsIndex['right_foot']
              ];
          console.log("Tracking body parts IDs: ", trackedBodyParts);
        }
      })
      .catch(error => {
        console.error('Failed to load body_map.json:', error);
      });

    function ensurePointer(index) {
        while (pointers.length <= index) pointers.push(new pointerPrototype());
        return pointers[index];
    }

    function pointerForId(id) {
        // Reserve pointer[0] for the first body by default; others get 1..N
        if (id == null) return ensurePointer(0);
        if (!idToIndex.has(id)) {
            idToIndex.set(id, idToIndex.size); // 0,1,2...
        }
        return ensurePointer(idToIndex.get(id));
    }

    let leftFootZBefore = 0;
    let rightFootZBefore = 0;
    let leftFootBefore = [];
    let rightFootBefore = [];
    let chestFrontBefore = [];
    let chestBackBefore = [];
    let leftHandBefore = [];
    let rightHandBefore = [];

    // Defining an RGB color palette of yellow-orange-red-purple of 300 colors
    let colorPalette = [];
    let defaultColorPalette = [];
    let minHue = 60; // yellow
    let maxHue = -60; // purple
    for (let i = 0; i <= 99; i++) {
        const hue = minHue - (i / 99) * (minHue - maxHue);
        const rgb = HSVtoRGB((hue + 360) % 360 / 360, 1.0, 1.0);
        colorPalette.push(rgb);
        defaultColorPalette.push(rgb);
    }


    //PATTERN 7 params
    let fallExplosionPalette = []; // from white to blue color
    for (let i = 0; i <= 99; i++) {
        const hue = 240; // blue hue
        const saturation = i / 99; // from 0 to 1
        const value = 3.0; // full brightness
        const rgb = HSVtoRGB(hue / 360, saturation, value);
        fallExplosionPalette.push(rgb);
    }

    let fallExplosionStarted = false;
    let fallExplosionFinished = false;
    let fallExplosionStartTime = null;
    let fallExplosionDT = 1; // milliseconds
    let fallExplosionSplashCoordinates = [];
    let fallExplosionTargets = [];
    let fallExplosionStep = 15
    let fallExplosionColorIndex = 0;

    //PATTERN 8 params
    let jumpGhostStarted = false;
    let jumpGhostFinished = false;
    let jumpGhostStartTime = null;
    let jumpGhostDT = 1; // milliseconds
    let jumpGhostSplashCoordinates = [];
    let jumpGhostTargets = [];
    let jumpGhostStep = 15

    //PATTERN 9 params
    let headTiltColorMode = false;

    window.addEventListener('message', (e) => {
        const m = e.data;
        //    printing receuived data
        //console.log('Received message:', m);
        if (!m || m.type !== 'splat') return;

        // Track latest angular velocities from the incoming message
        latestAngVel.vroll = typeof m.vroll === 'number' ? m.vroll : 0;
        latestAngVel.vpitch = typeof m.vpitch === 'number' ? m.vpitch : 0;
        latestAngVel.vyaw = typeof m.vyaw === 'number' ? m.vyaw : 0;

        latestNormVel = m.normVel
        latestZ[m.id] = m.z

        // Incoming coords are [0..1]. Convert to CSS px, then to device px using scaleByPixelRatio
        const arena_x = 3000; // Assuming a fixed arena size of 3000x3000
        const arena_y = 3000;

        const norm_x = (-m.x + arena_x) / (2 * arena_x);
        const norm_y = (m.y + arena_y) / (2 * arena_y);
        const cssX = ((norm_x ?? 0) * canvas.clientWidth);
        const cssY = ((norm_y ?? 0) * canvas.clientHeight);

        const posX = scaleByPixelRatio(cssX);
        const posY = scaleByPixelRatio(cssY);

        //    showing final position on console
        console.log(`Pointer position: (${posX}, ${posY})`);

        // Pick a pointer (by body ID if provided)
        const pointer = pointerForId(m.id);

        // Press if not already down, mirroring the mousedown logic in the file
        if (!pointer.down) {
            // Keep id = -1 to match the mouse path; we track body ID via idToIndex map
            updatePointerDownData(pointer, -1, posX, posY);
            if (Array.isArray(m.color) && m.color.length >= 3) {
                // script.js expects {r,g,b} in 0..1 space
                pointer.color = { r: m.color[0], g: m.color[1], b: m.color[2] };
            }
        }

        // PATTERN 1: Hand drop, Changing splat radius with hand depth
        // Calculating splat radius between 0.01 and 0.8 according to the height of the splat (z coord)
        let splatRadius = null;

        // Pattern parameters
        const dynRadiusBelowZ = 1800; // z below which splat radius increases
        const maxSplatRadius = 2.5; // maximum splat radius
        const minSplatRadius = 0.08; // minimum splat radius


        // If the tracked object is a hand we dynamically adjust splat radius
        if (m.id === bodyPartsIndex['right_hand'] || m.id === bodyPartsIndex['left_hand']) {
            const posZ = m.z;
            if (typeof posZ === 'number') {
                // below dynRadiusBelowZ z we increase splat radius according to depth
                if (posZ < dynRadiusBelowZ) {
                    const z = Math.max(0, Math.min(posZ, dynRadiusBelowZ)) / dynRadiusBelowZ;
                    splatRadius = maxSplatRadius - z * (maxSplatRadius - minSplatRadius);
                } else {
                    splatRadius = minSplatRadius;
                }
            }
        }

        // PATTERN 2: Bloom kick: set bloom according to the highest foot's z coord
        const posZ = m.z;
        const maxBloomZ = 1500; // z at which bloom is maximum
        const maxBloomValue = 0.15; // maximum bloom intensity
        const lowerZThreshold = 200; // z below which no bloom is applied and from which smooth change of bloom is applied
        if ((m.id === bodyPartsIndex['right_foot'] && posZ > leftFootZBefore) ||
            (m.id === bodyPartsIndex['left_foot'] && posZ > rightFootZBefore)
        ) {
            if (typeof posZ === 'number') {
                if (posZ > lowerZThreshold) {
                    const z = posZ <= lowerZThreshold ? 0 : Math.min((posZ - lowerZThreshold) / (maxBloomZ - lowerZThreshold), 1) * maxBloomValue;
                    config.BLOOM_INTENSITY = z * maxBloomValue;
                } else {
                    config.BLOOM_INTENSITY = 0.0;
                }
            }
            //console.log("Setting BLOOM_INTENSITY to ", config.BLOOM_INTENSITY);
        }

        //PATTERN 3: Color Speed: change color according to linear velocity of the tracked object
        if (typeof m.normVel === 'number') {
            const speed = m.normVel;
            // Map speed to an index in the color palette. normVel is between 0 and 1 we need the output to be between 0 and 99
            let colorIndex = Math.floor(Math.max(0, Math.min(speed, 1.0)) * 99);
            console.log("Setting color index to ", colorIndex, " for speed ", speed);
            const newColor = colorPalette[colorIndex];
            console.log("Setting pointer color to ", newColor);
            pointer.color = newColor;
        }

        //PATTERN 4: Density Control: change density diffusion according to hand-hand closeness
        const minDensityDissipation = 0.01;
        const maxDensityDissipation = 4.5;
        if ((m.id === bodyPartsIndex['left_hand'] && rightHandBefore.length === 3) ||
            (m.id === bodyPartsIndex['right_hand'] && leftHandBefore.length === 3)) {
            var handLeftPos = leftHandBefore;
            var handRightPos = rightHandBefore;
            if (m.id === bodyPartsIndex['left_hand']) {
                handLeftPos = [m.x, m.y, m.z];
            } else if (m.id === bodyPartsIndex['right_hand']) {
                handRightPos = [m.x, m.y, m.z];
            }

            // check the distance between hands
            const distance = Math.sqrt(
                (handLeftPos[0] - handRightPos[0]) ** 2 +
                (handLeftPos[1] - handRightPos[1]) ** 2 +
                (handLeftPos[2] - handRightPos[2]) ** 2
            );

            if (distance > 1500) {
                // Map distance to density dissipation between 0 (close) and 3.5 (far)
                const maxDistance = 2000; // distance at which dissipation is maximum
                const z = Math.max(0, Math.min(distance, maxDistance)) / maxDistance;
                var newDissipation = maxDensityDissipation - z * (maxDensityDissipation - minDensityDissipation);
                if (newDissipation < minDensityDissipation) {
                    newDissipation = 0.01;
                }
                config.DENSITY_DISSIPATION = newDissipation;
            } else {
                config.DENSITY_DISSIPATION = maxDensityDissipation;
            }
            console.log("Setting DENSITY_DISSIPATION to ", config.DENSITY_DISSIPATION);
        }

        //PATTERN 5: Unique Feet: Feet are tracked with black (at 0) to gray (at 2000) splat colors according to height
        if (m.id === bodyPartsIndex['left_foot'] || m.id === bodyPartsIndex['right_foot']) {
            const posZ = m.z;
            if (typeof posZ === 'number') {
                const z = Math.max(0, Math.min(posZ, 2000)) / 8000;
                const grayValue = z; // between 0 (black) and 1 (white)
                //black splat means we still can swirl the already existing splats with feet but
                // foot movement will not make new splats
                var footColor = { r: 0, g: 0, b: 0 };
                if (posZ > 500) {
                    footColor = { r: grayValue, g: grayValue, b: grayValue}
                }
                pointer.color = footColor;
                //console.log("Setting foot color to ", footColor, " for z ", posZ);
            }
        }

        //PATTERN 6: Fall Explosion: When fall is detected, we generate a series of splats with dedicated ID,
        //such that the splash goes from one of the corners of the arena to the position of the center of mass of the body
        const fallZThreshold = 500; // z above which a fall is detected when all hands and feet are below this z
        if (leftFootZBefore < fallZThreshold &&
            rightFootZBefore < fallZThreshold &&
            leftHandBefore[2] < fallZThreshold &&
            rightHandBefore[2] < fallZThreshold) {
            if (!fallExplosionStarted) {
                fallExplosionStarted = true;
                fallExplosionFinished = false;
                fallExplosionStartTime = Date.now();
                fallExplosionColorIndex = 0;
                const explosionRoots = [
                    { x: -arena_x, y: -arena_y }, // bottom-left
                    { x: 0,        y: -arena_y }, // bottom-center
                    { x:  arena_x, y: -arena_y }, // bottom-right
                    { x:  arena_x, y: 0        }, // right-center
                    { x:  arena_x, y:  arena_y }, // top-right
                    { x: 0,        y:  arena_y }, // top-center
                    { x: -arena_x, y:  arena_y }, // top-left
                    { x: -arena_x, y: 0        }, // left-center
                ];

                // Define splash coordinates based on arena scaling
                fallExplosionSplashCoordinates = explosionRoots.map(corner => {
                    const norm_x = (-corner.x + arena_x) / (2 * arena_x);
                    const norm_y = ( corner.y + arena_y) / (2 * arena_y);
                    return [
                        norm_x * canvas.clientWidth,
                        norm_y * canvas.clientHeight
                    ];
                });

                // Target is the center of mass of the hands, scaled with the *same* mapping
                const centerX = (leftHandBefore[0] + rightHandBefore[0]) / 2;
                const centerY = (leftHandBefore[1] + rightHandBefore[1]) / 2;

                const norm_centerX = (-centerX + arena_x) / (2 * arena_x);
                const norm_centerY = ( centerY + arena_y) / (2 * arena_y);

                fallExplosionTargets = [
                    norm_centerX * canvas.clientWidth,
                    norm_centerY * canvas.clientHeight
                ];

                console.log("Fall detected! Starting fall explosion towards ", fallExplosionTargets);
            }
        }

        if (fallExplosionStarted && (Date.now() - fallExplosionStartTime) > fallExplosionDT) {
            console.log("Generating fall explosion splats at coordinates: ", fallExplosionSplashCoordinates);

            fallExplosionSplashCoordinates.forEach((coord, index) => {
                const posX = scaleByPixelRatio(coord[0]);
                const posY = scaleByPixelRatio(coord[1]);

                const dx = fallExplosionTargets[0] - coord[0];
                const dy = fallExplosionTargets[1] - coord[1];
                const dist = Math.sqrt(dx * dx + dy * dy);
                const normDist = Math.max(0, Math.min(dist / (2 * arena_x), 1.0));

                const cornerId = 9999 + index;
                const pointer = pointerForId(cornerId);

                updatePointerDownData(pointer, -1, posX, posY);
                pointer.color = fallExplosionPalette[fallExplosionColorIndex];
                fallExplosionColorIndex = Math.min(fallExplosionColorIndex + 1, fallExplosionPalette.length - 1);
                console.log("Fall corner pointer DOWN: ", pointer.color);
                updatePointerMoveData(pointer, posX, posY);

                // force the splat in case delta ends up 0
                pointer.moved = true;
                // map radius between 0.5 and 2 according to distance from target
                pointer.splatRadius = 0.5 + normDist * (2.0 - 0.5);

                console.log("Fall corner pointer: ", pointer);
            });

            fallExplosionStartTime = Date.now();

            // move each splash by a fixed distance towards the target
            fallExplosionSplashCoordinates = fallExplosionSplashCoordinates.map(coord => {
                const dx = fallExplosionTargets[0] - coord[0];
                const dy = fallExplosionTargets[1] - coord[1];
                const dist = Math.sqrt(dx * dx + dy * dy);

                // already close enough, snap to target
                if (dist <= fallExplosionStep || dist === 0) {
                    return [fallExplosionTargets[0], fallExplosionTargets[1]];
                }

                const ux = dx / dist;
                const uy = dy / dist;

                const newX = coord[0] + ux * fallExplosionStep;
                const newY = coord[1] + uy * fallExplosionStep;

                return [newX, newY];
            });

            // stop once the first splash reached the center (all arrive almost together)
            const distToTarget = Math.sqrt(
                (fallExplosionSplashCoordinates[0][0] - fallExplosionTargets[0]) ** 2 +
                (fallExplosionSplashCoordinates[0][1] - fallExplosionTargets[1]) ** 2
            );
            if (distToTarget <= fallExplosionStep) {
                fallExplosionFinished = true;
            }
        }

        // recover from fall explosion state once both hands above threshold
        if (fallExplosionFinished &&
            leftHandBefore[2] > fallZThreshold &&
            rightHandBefore[2] > fallZThreshold) {
            fallExplosionStarted = false;
        }

        // PATTERN 7: Jump Ghosts: When jump is detected we generate a ghost splash (black color) striking through
        // the center of mass of the hands in the direction of the jump
        const jumpZThreshold = 400; // z above which a jump is detected
        if (leftFootZBefore > jumpZThreshold &&
            rightFootZBefore > jumpZThreshold) {

            if (!jumpGhostStarted && leftHandBefore.length === 3 && rightHandBefore.length === 3) {
                console.log("Jump detected initiation conditions met.");
                jumpGhostStarted = true;
                jumpGhostFinished = false;
                jumpGhostStartTime = Date.now();

                // Center of mass of the hands (arena space)
                const centerX = (leftHandBefore[0] + rightHandBefore[0]) / 2;
                const centerY = (leftHandBefore[1] + rightHandBefore[1]) / 2;

                // Direction of the jump from current foot position vs previous one
                let dirX = 0;
                let dirY = 1; // fallback

                if (m.id === bodyPartsIndex['right_foot'] && rightFootBefore.length === 3) {
                    // posX, posY are the *current* arena coords of the right foot
                    dirX = m.x - rightFootBefore[0];
                    dirY = m.y - rightFootBefore[1];
                } else if (m.id === bodyPartsIndex['left_foot'] && leftFootBefore.length === 3) {
                    // same for left foot
                    dirX = m.x - leftFootBefore[0];
                    dirY = m.y - leftFootBefore[1];
                }

                // Normalize
                let len = Math.sqrt(dirX * dirX + dirY * dirY);
                if (len < 1e-3) {
                    // If the movement vector is tiny, keep a simple default (straight up)
                    dirX = 0;
                    dirY = 1;
                    len = 1;
                }
                dirX /= len;
                dirY /= len;

                // Find how far we can go inside the arena square [-arena_x, arena_x] x [-arena_y, arena_y]
                const tx = dirX !== 0 ? arena_x / Math.abs(dirX) : Infinity;
                const ty = dirY !== 0 ? arena_y / Math.abs(dirY) : Infinity;
                const tMax = Math.min(tx, ty);

                // Farthest point "behind" the COM and the point "ahead" in jump direction
                const startArenaX = -dirX * tMax;
                const startArenaY = -dirY * tMax;
                const endArenaX   =  dirX * tMax;
                const endArenaY   =  dirY * tMax;

                // Map arena → canvas coords using the same transform as everywhere else
                const norm_startX = (-startArenaX + arena_x) / (2 * arena_x);
                const norm_startY = ( startArenaY + arena_y) / (2 * arena_y);
                const norm_endX   = (-endArenaX   + arena_x) / (2 * arena_x);
                const norm_endY   = ( endArenaY   + arena_y) / (2 * arena_y);

                jumpGhostSplashCoordinates = [[
                    norm_startX * canvas.clientWidth,
                    norm_startY * canvas.clientHeight
                ]];

                jumpGhostTargets = [
                    norm_endX * canvas.clientWidth,
                    norm_endY * canvas.clientHeight
                ];

                console.log("Jump detected! Starting jump ghost from ",
                    jumpGhostSplashCoordinates[0], " to ", jumpGhostTargets);
            }
        }

        // Move and render the jump ghost
        if (jumpGhostStarted && !jumpGhostFinished &&
            (Date.now() - jumpGhostStartTime) > jumpGhostDT) {

            console.log("Jump ghost at: ", jumpGhostSplashCoordinates);

            jumpGhostSplashCoordinates.forEach((coord, index) => {
                const posXg = scaleByPixelRatio(coord[0]);
                const posYg = scaleByPixelRatio(coord[1]);

                const dx = jumpGhostTargets[0] - coord[0];
                const dy = jumpGhostTargets[1] - coord[1];
                const dist = Math.sqrt(dx * dx + dy * dy);
                const normDist = Math.max(0, Math.min(dist / (2 * arena_x), 1.0));

                const ghostId = 11000 + index; // dedicated ID for the ghost
                const ghostPointer = pointerForId(ghostId);

                updatePointerDownData(ghostPointer, -1, posXg, posYg);
                // black "ghost" color
                ghostPointer.color = { r: 0.1, g: 0.1, b: 0.1 };
                updatePointerMoveData(ghostPointer, posXg, posYg);

                // force the splat in case delta ends up 0
                ghostPointer.moved = true;
                // radius grows slightly as it approaches the center / target
                ghostPointer.splatRadius = 0.5 + normDist * (2.0 - 0.5);

                console.log("Jump ghost pointer: ", ghostPointer);
            });

            jumpGhostStartTime = Date.now();

            // Move the ghost forward by a fixed distance towards the target
            jumpGhostSplashCoordinates = jumpGhostSplashCoordinates.map(coord => {
                const dx = jumpGhostTargets[0] - coord[0];
                const dy = jumpGhostTargets[1] - coord[1];
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist <= jumpGhostStep || dist === 0) {
                    jumpGhostFinished = true;
                    return [jumpGhostTargets[0], jumpGhostTargets[1]];
                }

                const ux = dx / dist;
                const uy = dy / dist;

                const newX = coord[0] + ux * jumpGhostStep;
                const newY = coord[1] + uy * jumpGhostStep;

                return [newX, newY];
            });
        }

        // Allow a new jump ghost once the current one is done and feet are back down
        if (jumpGhostFinished &&
            leftFootZBefore < jumpZThreshold &&
            rightFootZBefore < jumpZThreshold) {
            jumpGhostStarted = false;
        }

        //PATTERN 8: Pause Boom, Pause diffusion: of left-right hand distance smaller than 200
        const pauseThreshold = 200; // distance below which we pause the fluid
        if (leftHandBefore.length === 3 && rightHandBefore.length === 3) {
            const distance = Math.sqrt(
                (leftHandBefore[0] - rightHandBefore[0]) ** 2 +
                (leftHandBefore[1] - rightHandBefore[1]) ** 2 +
                (leftHandBefore[2] - rightHandBefore[2]) ** 2
            );
            if (distance < pauseThreshold) {
                config.PAUSED = true;
                //console.log("Pausing fluid due to hands closeness: ", distance);
            } else {
                config.PAUSED = false;
            }
        }

        //PATTERN 9: Head Tilt Color Palette Shift: changing the color palette slice according to the roll of the head
        // Head tilt color mode activation by moving right hand close to head
        const headProximityThreshold = 300; // distance below which head tilt color mode is activated
        if (leftHandBefore.length === 3 && rightHandBefore.length === 3) {
            const headX = m.id === bodyPartsIndex['head'] ? m.x : 0;
            const headY = m.id === bodyPartsIndex['head'] ? m.y : 0;
            const headZ = m.id === bodyPartsIndex['head'] ? m.z : 0;

            const distanceToHeadLeft = Math.sqrt(
                (leftHandBefore[0] - headX) ** 2 +
                (leftHandBefore[1] - headY) ** 2 +
                (leftHandBefore[2] - headZ) ** 2
            );

            const distanceToHeadRight = Math.sqrt(
                (rightHandBefore[0] - headX) ** 2 +
                (rightHandBefore[1] - headY) ** 2 +
                (rightHandBefore[2] - headZ) ** 2
            );

            if (distanceToHeadRight < headProximityThreshold) {
                headTiltColorMode = true;
                config.bloom = true;
            }
            if (distanceToHeadLeft < headProximityThreshold) {
                headTiltColorMode = false;
                config.bloom = false;
            }
        }


        // Change color according to head tilt if mode is activated
        if (headTiltColorMode && m.id === bodyPartsIndex['head']) {
            let pitch = m.roll; // in degrees, positive when leaning forward
            let rawPitch = m.roll;
            // Map pitch between -90 (facing up) and 60 (facing down) to palette indices between 0 and 200
            const minPitch = -40;
            const maxPitch = 30;
            if (pitch < minPitch) pitch = minPitch;
            if (pitch > maxPitch) pitch = maxPitch;
            const pitchNorm = (pitch - minPitch) / (maxPitch - minPitch);
            let minHue = 360 * pitchNorm; // from 0 to 360
            let maxHue = minHue + 120; // span of 300 degrees
            // generating palette of 100 colors between minHue and maxHue
            colorPalette.length = 0;
            for (let i = 0; i <= 99; i++) {
                const hue = minHue - (i / 99) * (minHue - maxHue);
                const rgb = HSVtoRGB((hue + 360) % 360 / 360, 1.0, 1.0);
                colorPalette.push(rgb);
            }
            console.log("Head raw pitch: ", rawPitch, "clamped: ", pitch, " setting color palette hues between: ", minHue, "-", maxHue);
        }

        // set back to default palette if mode is not activated
        if (!headTiltColorMode) {
            colorPalette = defaultColorPalette.slice();
        }


        // Updating memory variables
        leftFootZBefore = m.id === bodyPartsIndex['left_foot'] ? m.z : leftFootZBefore;
        rightFootZBefore = m.id === bodyPartsIndex['right_foot'] ? m.z : rightFootZBefore;
        leftHandBefore = m.id === bodyPartsIndex['left_hand'] ? [m.x, m.y, m.z] : leftHandBefore;
        rightHandBefore = m.id === bodyPartsIndex['right_hand'] ? [m.x, m.y, m.z] : rightHandBefore;
        chestFrontBefore = m.id === bodyPartsIndex['chest_front'] ? [m.x, m.y, m.z] : chestFrontBefore;
        chestBackBefore = m.id === bodyPartsIndex['chest_back'] ? [m.x, m.y, m.z] : chestBackBefore;
        leftFootBefore = m.id === bodyPartsIndex['left_foot'] ? [m.x, m.y, m.z] : leftFootBefore;
        rightFootBefore = m.id === bodyPartsIndex['right_foot'] ? [m.x, m.y, m.z] : rightFootBefore;


        if (trackedBodyParts.includes(m.id)) {
            // Defining the parameters of the splat to be visualized and save it in the pointer move data
            updatePointerMoveData(pointer, posX, posY, splatRadius=splatRadius);
            //console.log("Fall body part pointer: ", pointer);

            // Auto-release after a short silence so pointers don't stay "stuck down"
            clearTimeout(pointer._autoUpTimer);
            pointer._autoUpTimer = setTimeout(() => {
                updatePointerUpData(pointer);
            }, 60); // ms; tweak to taste for smoother/continuous drags
        };
    });
})();

function updatePointerDownData(pointer, id, posX, posY) {
    pointer.id = id;
    pointer.down = true;
    pointer.moved = false;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.deltaX = 0;
    pointer.deltaY = 0;
    pointer.color = generateColor();
}

function updatePointerMoveData(pointer, posX, posY, splatRadius=null) {
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
    pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
    pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
    pointer.splatRadius = splatRadius;
}

function updatePointerUpData(pointer) {
    pointer.down = false;
}

function correctDeltaX(delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio < 1) delta *= aspectRatio;
    return delta;
}

function correctDeltaY(delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) delta /= aspectRatio;
    return delta;
}

function generateColor() {
    let c = HSVtoRGB(Math.random(), 1.0, 1.0);
    c.r *= 0.15;
    c.g *= 0.15;
    c.b *= 0.15;
    return c;
}

function HSVtoRGB(h, s, v) {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);

    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }

    return {
        r,
        g,
        b
    };
}

function normalizeColor(input) {
    let output = {
        r: input.r / 255,
        g: input.g / 255,
        b: input.b / 255
    };
    return output;
}

function wrap(value, min, max) {
    let range = max - min;
    if (range == 0) return min;
    return (value - min) % range + min;
}

function getResolution(resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1)
        aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
        return { width: max, height: min };
    else
        return { width: min, height: max };
}

function getTextureScale(texture, width, height) {
    return {
        x: width / texture.width,
        y: height / texture.height
    };
}

function scaleByPixelRatio(input) {
    let pixelRatio = window.devicePixelRatio || 1;
    return Math.floor(input * pixelRatio);
}

function hashCode(s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash << 5) - hash + s.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
};