// Electric Clouds Background Shader
// Adapted from Shadertoy shader: https://www.shadertoy.com/view/XXyGzh

export default {
  name: 'Electric Clouds',
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;

    // Uniforms to receive data from JavaScript, matching the Shadertoy format
    uniform vec3      iResolution;           // viewport resolution (in pixels)
    uniform float     iTime;                 // shader playback time (in seconds)
    uniform float     iTimeDelta;            // render time (in seconds)
    uniform float     iFrameRate;            // shader frame rate
    uniform int       iFrame;                // shader playback frame
    uniform float     iChannelTime[4];       // channel playback time (in seconds)
    uniform vec3      iChannelResolution[4]; // channel resolution (in pixels)
    uniform vec4      iMouse;                // mouse pixel coords. xy: current (if MLB down), zw: click
    uniform vec4      iDate;                 // (year, month, day, time in seconds)
    uniform float     iSampleRate;           // sound sample rate (i.e., 44100)

    // Custom tanh implementation for WebGL compatibility
    float tanh_custom(float x) {
        float e2x = exp(2.0 * x);
        return (e2x - 1.0) / (e2x + 1.0);
    }

    vec2 tanh_custom(vec2 v) {
        return vec2(tanh_custom(v.x), tanh_custom(v.y));
    }

    // Helper function from COMMON section
    vec2 stanh(vec2 a) {
        return tanh_custom(clamp(a, -40., 40.));
    }

    // This is the main function adapted from Shadertoy's 'mainImage'
    void mainImage( out vec4 o, vec2 u )
    {
        vec2 v = iResolution.xy;
        // Proper Shadertoy coordinate transformation
        u = 0.2 * (u + u - v) / v.y;

        vec4 z = o = vec4(1,2,3,0); // Restore original colorful base

        float a = 0.5;
        float t = iTime;
        vec4 matVec;

        for (float i = 0.0; i < 19.0; i += 1.0) {
             o += (1. + cos(z+t))
                / length((1.+i*dot(v,v))
                       * sin(1.5*u/(0.5-dot(u,u)) - 9.*u.yx + t));

            t += 1.0;
            v = cos(t - 7.*u*pow(a, i)) - 5.*u;
            a += 0.03;

            // Use stanh here as recommended for black artifacts
            matVec = cos(i + .02*t - vec4(0,11,33,0));
            u *= mat2(matVec.x, matVec.y, matVec.z, matVec.w);
            u += stanh(40. * dot(u, u) * cos(1e2*u.yx + t) * vec2(1.0)) / 2e2
               + .2 * a * u
               + cos(4./exp(dot(o,o)/1e2) + t) / 3e2;
        }

         o = 25.6 / (min(o, vec4(13.)) + 164. / o)
           - dot(u, u) / 250.;

         // Target only the slow oscillating background, preserve fast electric streaks
         float maxComponent = max(max(o.r, o.g), o.b);
         float colorVariation = maxComponent - min(min(o.r, o.g), o.b);

         // Electric effects have high intensity and high color variation
         float electricMask = smoothstep(0.4, 1.0, maxComponent) * smoothstep(0.1, 0.5, colorVariation);

         // Make clouds much darker
         float gray = dot(o.rgb, vec3(0.299, 0.587, 0.114));
         vec3 darkClouds = vec3(gray * 0.1); // Much darker clouds (was 0.3, now 0.1)

         // Boost electric effects brightness
         vec3 brightElectric = o.rgb * 1.4; // Boost brightness by 40%

         // Mix: very dark clouds with bright electric effects
         o.rgb = mix(darkClouds, brightElectric, electricMask);
    }

    // The main entry point for the fragment shader
    void main() {
        // We call the adapted Shadertoy main function, providing the required outputs and inputs.
        mainImage(gl_FragColor, gl_FragCoord.xy);
    }
  `
};
