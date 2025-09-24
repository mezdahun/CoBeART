document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gl-canvas');
    const regl = createREGL({
        canvas: canvas,
        extensions: ['OES_texture_float'],
        optionalExtensions: [
            'OES_texture_float_linear',
            'WEBGL_color_buffer_float',
            'EXT_color_buffer_float',
            // Half-float fallbacks
            'OES_texture_half_float',
            'OES_texture_half_float_linear',
            'EXT_color_buffer_half_float'
        ]
    });

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const commonShader = `
    // shortcut to sample texture
    #define TEX(uv) texture2D(iChannel0, uv).r
    #define TEX1(uv) texture2D(iChannel1, uv).r
    #define TEX2(uv) texture2D(iChannel2, uv).r
    #define TEX3(uv) texture2D(iChannel3, uv).r

    // shorcut for smoothstep uses
    #define trace(edge, thin) smoothstep(thin,.0,edge)
    #define ss(a,b,t) smoothstep(a,b,t)
  `;

    const bufferA_frag = `
    precision highp float;
    uniform float iTime;
    uniform float iTimeDelta;
    uniform vec3 iResolution;
    uniform vec4 iMouse;
    uniform sampler2D iChannel0; // rgba-noise-volume (3D volume packed as 2D atlas)
    uniform sampler2D iChannel1; // previous frame

    ${commonShader}

    // Liquid toy by Leon Denise 2022-05-18
    // Playing with shading with a fake fluid heightmap
    // Updated to use 3D volume texture sampling

    const float speed = .01;
    const float scale = .1;
    const float falloff = 3.;
    const float fade = .4;
    const float strength = 1.;
    const float range = 5.;

    // fractal brownian motion (layers of multi scale noise)
    // Match original Shadertoy behavior: sample 2D texture with 3D coordinates
    vec3 fbm(vec3 p)
    {
        vec3 result = vec3(0);
        float amplitude = 0.5;
        for (float index = 0.; index < 3.; ++index)
        {
            // Original uses p/amplitude and treats as 2D texture sample
            // We use the Z component to offset between volume slices for variation
            vec2 sampleUV = p.xy / amplitude;
            
            // Use Z component to sample different parts of the volume texture
            // Create Z-based offset to simulate volume layers with time variation
            float zOffset = (p.z + index * 0.33) * 0.1;
            
            // Add slow time-based variation to hide static artifacts
            float timeVariation = iTime * 0.25; // 25% per second change
            vec2 timeOffset = vec2(
                sin(timeVariation + index * 2.0) * 0.03,
                cos(timeVariation * 1.3 + index * 1.5) * 0.025
            );
            
            sampleUV += vec2(zOffset * 0.5, zOffset * 0.7) + timeOffset;
            
            result += texture2D(iChannel0, sampleUV).xyz * amplitude;
            amplitude /= falloff;
        }
        return result;
    }

    void main()
    {
        // coordinates
        vec2 uv = (gl_FragCoord.xy - iResolution.xy / 2.)/iResolution.y;
        vec2 aspect = vec2(iResolution.x/iResolution.y, 1);
        
        // noise: animate z over time for volumetric look
        vec3 spice = fbm(vec3(uv*scale, iTime*speed));
        
        // draw circle at mouse or in motion
        float t = iTime*2.;
        vec2 mouse = (iMouse.xy - iResolution.xy / 2.)/iResolution.y;
        if (iMouse.z > .5) uv -= mouse;
        else uv -= vec2(cos(t),sin(t))*.3;
        float paint = trace(length(uv),.1);
        
        // expansion
        vec2 offset = vec2(0);
        uv = gl_FragCoord.xy / iResolution.xy;
        vec4 data = texture2D(iChannel1, uv);
        vec3 unit = vec3(range/472./aspect,0);
        vec3 normal = normalize(vec3(
            texture2D(iChannel1, uv - unit.xz).r-texture2D(iChannel1, uv + unit.xz).r,
            texture2D(iChannel1, uv - unit.zy).r-texture2D(iChannel1, uv + unit.zy).r,
            data.x*data.x)+.001);
        offset -= normal.xy;
        
        // turbulence
        spice.x *= 6.28*2.;
        spice.x += iTime;
        offset += vec2(cos(spice.x),sin(spice.x));
        
        uv += strength * offset / aspect / 472.;
        
        // sample buffer
        vec4 frame = texture2D(iChannel1, uv);
        
        // temporal fading buffer
        paint = max(paint, frame.x - iTimeDelta * fade);
        
        // print result
        gl_FragColor = vec4(clamp(paint, 0., 1.));
    }
  `;

    const image_frag = `
    precision highp float;
    uniform float iTime;
    uniform vec3 iResolution;
    uniform vec4 iMouse;
    uniform sampler2D iChannel0; // buffer A
    uniform sampler2D iChannel1; // dither/noise (blue noise)

    ${commonShader}

    // Liquid toy by Leon Denise 2022-05-18
    // Playing with shading with a fake fluid heightmap

    // 2023-01-20 update:
    // fix scalars to be resolution independant
    // (samed speed and look at different frame size)

    void main()
    {
        // coordinates
        vec2 uv = gl_FragCoord.xy / iResolution.xy;
        vec3 dither = texture2D(iChannel1, gl_FragCoord.xy / 1024.).rgb;
        
        // value from buffer A
        vec4 data =  texture2D(iChannel0, uv);
        float gray = data.x;
        
        // gradient normal from gray value
        float range = 3.;
        vec2 aspect = vec2(iResolution.x/iResolution.y, 1);
        vec3 unit = vec3(range/472./aspect,0);
        vec3 normal = normalize(vec3(
            texture2D(iChannel0, uv + unit.xz).r-texture2D(iChannel0, uv - unit.xz).r,
            texture2D(iChannel0, uv - unit.zy).r-texture2D(iChannel0, uv + unit.zy).r,
            gray*gray*gray));
            
        // backlight
        vec3 color = vec3(.3)*(1.-abs(dot(normal, vec3(0,0,1))));
        
        // specular light
        vec3 dir = normalize(vec3(0,1,2));
        float specular = pow(dot(normal, dir)*.5+.5,20.);
        color += vec3(.5)*ss(.2,1.,specular);
        
        // rainbow
        vec3 tint = .5+.5*cos(vec3(1,2,3)*1.+dot(normal, dir)*4.-uv.y*3.-3.);
        color += tint * smoothstep(.15,.0,gray);

        // dither
        color -= dither.x*.1;
        
        // background blend
        vec3 background = vec3(1);
        background *= smoothstep(1.5,-.5,length(uv-.5));
        color = mix(background, clamp(color, 0., 1.), ss(.01,.1,gray));
        
        // display layers when clic
        if (iMouse.z > 0.5 && iMouse.x/iResolution.x < .1)
        {
            if (uv.x < .33) color = vec3(gray);
            else if (uv.x < .66) color = normal*.5+.5;
            else color = vec3(tint);
        }

        gl_FragColor = vec4(color, 1);
    }
  `;

    const vert = `
    precision mediump float;
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0, 1);
    }
  `;

    const quadPositions = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

    // Load textures to match Shadertoy mapping
    let blueNoiseTexture;   // IMAGE iChannel1
    let volumeNoiseTexture; // BUFFER A iChannel0 - 3D volume texture
    let pending = 2;

    const imgBlue = new Image();
    imgBlue.src = 'textures/blue-noise.png';
    imgBlue.onload = () => {
        blueNoiseTexture = regl.texture({ data: imgBlue, wrap: 'repeat', mag: 'nearest', min: 'nearest' });
        if (--pending === 0) init();
    };

    // Load 3D volume texture from binary file
    fetch('textures/rgba-noise-volume.bin')
        .then(response => response.arrayBuffer())
        .then(buffer => {
            // 32x32x32 volume, 4 channels, uint8
            const data = new Uint8Array(buffer);
            const size = 32;

            // Check if we have the expected data size
            const expectedSize = size * size * size * 4;
            if (data.length !== expectedSize) {
                console.warn(`Volume texture size mismatch. Expected ${expectedSize}, got ${data.length}`);
            }

            // Create a seamless tileable 2D texture from the volume data
            const textureSize = 256; // Larger than original 32x32 for better quality
            const textureData = new Uint8Array(textureSize * textureSize * 4);

            // Create a seamless texture using proper wrapping coordinates
            for (let y = 0; y < textureSize; y++) {
                for (let x = 0; x < textureSize; x++) {
                    const dstIdx = (y * textureSize + x) * 4;

                    // Use floating-point coordinates for smoother mapping
                    const fx = (x / textureSize) * size;
                    const fy = (y / textureSize) * size;

                    // Get integer coordinates and fractional parts for interpolation
                    const vx1 = Math.floor(fx) % size;
                    const vy1 = Math.floor(fy) % size;
                    const vx2 = (vx1 + 1) % size;
                    const vy2 = (vy1 + 1) % size;

                    const wx = fx - Math.floor(fx);
                    const wy = fy - Math.floor(fy);

                    // Use multiple slices to create variation over time
                    const vz = Math.floor(size / 2);

                    // Sample 4 neighboring pixels
                    const getPixel = (vx, vy) => {
                        const idx = ((vz * size + vy) * size + vx) * 4;
                        if (idx + 3 < data.length) {
                            return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
                        }
                        return [128, 128, 128, 255];
                    };

                    const p1 = getPixel(vx1, vy1);
                    const p2 = getPixel(vx2, vy1);
                    const p3 = getPixel(vx1, vy2);
                    const p4 = getPixel(vx2, vy2);

                    // Bilinear interpolation
                    for (let c = 0; c < 4; c++) {
                        const top = p1[c] * (1 - wx) + p2[c] * wx;
                        const bottom = p3[c] * (1 - wx) + p4[c] * wx;
                        const final = top * (1 - wy) + bottom * wy;
                        textureData[dstIdx + c] = Math.round(final);
                    }
                }
            }

            volumeNoiseTexture = regl.texture({
                width: textureSize,
                height: textureSize,
                data: textureData,
                wrap: 'repeat',
                mag: 'linear',
                min: 'linear',
                format: 'rgba',
                type: 'uint8'
            });

            if (--pending === 0) init();
        })
        .catch(err => {
            console.error('Failed to load volume texture:', err);
            // Fallback to 2D texture
            const imgFBM = new Image();
            imgFBM.src = 'textures/noise.png';
            imgFBM.onload = () => {
                volumeNoiseTexture = regl.texture({ data: imgFBM, wrap: 'repeat', mag: 'linear', min: 'linear' });
                if (--pending === 0) init();
            };
        });

    let fbos, drawBufferA, drawImage;
    let lastTime = 0;

    function init() {
        const gl = regl && regl._gl;
        const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

        const hasFloatRT = regl.hasExtension && (regl.hasExtension('EXT_color_buffer_float') || regl.hasExtension('WEBGL_color_buffer_float'));
        const hasFloat = regl.hasExtension && regl.hasExtension('OES_texture_float');
        const hasFloatLinear = (regl.hasExtension && regl.hasExtension('OES_texture_float_linear')) || isWebGL2;

        const hasHalfFloat = regl.hasExtension && regl.hasExtension('OES_texture_half_float');
        const hasHalfFloatRT = regl.hasExtension && regl.hasExtension('EXT_color_buffer_half_float');
        const hasHalfFloatLinear = (regl.hasExtension && regl.hasExtension('OES_texture_half_float_linear')) || isWebGL2;

        function chooseTypeAndFilter() {
            // Prefer full float with linear filtering
            if (hasFloatRT && hasFloat && hasFloatLinear) {
                return { type: 'float', mag: 'linear', min: 'linear' };
            }
            // Half-float with linear filtering is next best
            if (hasHalfFloatRT && hasHalfFloat && hasHalfFloatLinear) {
                return { type: 'half float', mag: 'linear', min: 'linear' };
            }
            // Float renderable but only nearest filtering
            if (hasFloatRT && hasFloat) {
                return { type: 'float', mag: 'nearest', min: 'nearest' };
            }
            // Last resort: 8-bit
            return { type: 'uint8', mag: 'linear', min: 'linear' };
        }

        const tf = chooseTypeAndFilter();
        const bufferTexOptions = {
            width: canvas.width,
            height: canvas.height,
            wrap: 'clamp',
            type: tf.type,
            mag: tf.mag,
            min: tf.min
        };

        fbos = Array(2).fill().map(() =>
            regl.framebuffer({
                color: regl.texture(bufferTexOptions),
                depth: false
            })
        );

        // Clear ping-pong buffers to a known state
        fbos.forEach(fbo => {
            regl.clear({ framebuffer: fbo, color: [0, 0, 0, 1] });
        });

        drawBufferA = regl({
            frag: bufferA_frag,
            vert: vert,
            attributes: {
                position: quadPositions
            },
            uniforms: {
                iTime: ({ time }) => time,
                iTimeDelta: ({ time }) => {
                    const dt = Math.max(0, time - lastTime);
                    lastTime = time;
                    return dt; // match Shadertoy's raw iTimeDelta behavior
                },
                iResolution: ({ viewportWidth, viewportHeight }) => [viewportWidth, viewportHeight, 1],
                iMouse: () => [mouse.x, mouse.y, mouse.z, mouse.w],
                iChannel0: volumeNoiseTexture,
                iChannel1: ({ tick }) => fbos[tick % 2]
            },
            framebuffer: ({ tick }) => fbos[(tick + 1) % 2],
            count: 4,
            primitive: 'triangle strip'
        });

        drawImage = regl({
            frag: image_frag,
            vert: vert,
            attributes: {
                position: quadPositions
            },
            uniforms: {
                iTime: ({ time }) => time,
                iResolution: ({ viewportWidth, viewportHeight }) => [viewportWidth, viewportHeight, 1],
                iMouse: () => [mouse.x, mouse.y, mouse.z, mouse.w],
                iChannel0: ({ tick }) => fbos[(tick + 1) % 2],
                iChannel1: blueNoiseTexture
            },
            count: 4,
            primitive: 'triangle strip'
        });

        regl.frame(() => {
            drawBufferA();
            drawImage();
        });
    }

    // Mouse handling
    const mouse = { x: 0, y: 0, z: 0, w: 0 };
    window.addEventListener('mousedown', () => mouse.z = 1);
    window.addEventListener('mouseup', () => mouse.z = 0);
    window.addEventListener('mousemove', (event) => {
        mouse.x = event.clientX;
        mouse.y = canvas.height - event.clientY; // flip Y
    });

    // Socket.io connection
    const PORT = window.__SOCKET_PORT__ || 3000;
    const socket = io(`http://127.0.0.1:${PORT}/viewer`, { transports: ['websocket'] });
    socket.on('connect', () => console.log('[ink] Connected to /viewer'));
    socket.on('frame', (payload) => {
        // This shader does not use incoming data, but we keep the connection.
        // console.log('Received frame data:', payload);
    });
    socket.on('disconnect', () => console.log('[ink] Disconnected from /viewer'));

    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        // re-initialize fbos and draw commands
        if (typeof init === 'function') {
            init();
        }
    }, false);
});
