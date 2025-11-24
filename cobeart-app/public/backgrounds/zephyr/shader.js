// Zephyr Background Shader
// Converted from ISF shader by @Silvia Fabiani
// Based on @patriciogv - 2015 and Morgan McGuire @morgan3d
// Original: https://editor.isf.video/shaders/5e7a801d7c113618206deaf7

export default {
    name: 'Zephyr',
    fragmentShader: `
    precision highp float;
    varying vec2 vUv;

    uniform float time;
    uniform vec2 resolution;
    uniform float scaling;
    uniform float calm;
    uniform float contrast;
    uniform vec3 color1;
    uniform vec3 color2;

    float random(in vec2 _st) {
        return fract(sin(dot(_st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    float noise(in vec2 _st) {
        vec2 i = floor(_st);
        vec2 f = fract(_st);

        // Four corners in 2D of a tile
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));

        vec2 u = f * f * (3.0 - 2.0 * f);

        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }

    #define NUM_OCTAVES 5

    float fbm(in vec2 _st) {
        float TT = clamp(time, 0.0, 12.0);
        float v = -0.5;
        float a = contrast;
        vec2 shift = vec2(100.0);

        // Rotate to reduce axial bias
        mat2 rot = mat2(cos(calm), sin(1.02), -sin(0.5), cos(-0.001));

        for (int i = 0; i < NUM_OCTAVES; ++i) {
            v += a * noise(_st);
            _st = rot * _st * 2.0 + shift;
            a *= 0.5;
        }
        return v;
    }

    void main() {
        // Convert vUv to match ISF coordinate system
        vec2 st = gl_FragCoord.xy / resolution.xy * 3.0;
        st += st * scaling;

        vec3 color = vec3(0.0);
        float TT = clamp(time, 0.0, 12.0);

        vec2 q = vec2(0.0);
        q.x = fbm(st + 0.00 * time);
        q.y = fbm(st + vec2(1.0));

        vec2 r = vec2(0.0);
        r.x = fbm(st + 1.0 * q + vec2(1.7, 9.2) + 0.15 * time);
        r.y = fbm(st + 1.0 * q + vec2(8.3, 2.8) + 0.126 * time);

        float f = fbm(st + r);

        color = mix(vec3(0.2, 0.2, 0.6),
                    vec3(0.1, 0.1, 0.5),
                    clamp((f * f) * -0.096, 0.0, 0.0));

        color = mix(color,
                    color1 * (0.5 + 0.3 * cos(time / TT / 2.0)),
                    clamp(length(q), 0.0, 1.0));

        color = mix(color,
                    color2 * (0.5 + 0.3 * sin(time / TT / 2.0)),
                    clamp(length(r.x), 0.0, 1.0));

        gl_FragColor = vec4((0.35 * f * f + 0.25 * f) * color, 1.0);
    }
  `
};
