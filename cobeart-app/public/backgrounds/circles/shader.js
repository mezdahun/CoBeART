// Circles Background Shader
// Converted from ISF shader by @colin_movecraft
// Original: https://editor.isf.video/shaders/5e7a80127c113618206dea15

export default {
  name: 'Circles',
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;

    uniform float time;
    uniform vec2 resolution;
    uniform float circle_size;
    uniform vec3 fill_color;
    uniform vec3 grad_color;

    float makeDist(vec2 screenSpace, float multiplier) {
        return length(screenSpace * multiplier);
    }

    mat2 scale(vec2 _scale) {
        return mat2(_scale.x, 0.0,
                    0.0, _scale.y);
    }

    vec4 ellipseGrad(vec2 screenSpace, float radius, vec3 gradColor, vec3 fillColor) {
        screenSpace = scale(vec2(radius)) * screenSpace;

        vec4 color = vec4(0.0, 0.0, 0.0, 1.0);

        float gradDist = makeDist(screenSpace, 1.75);
        float solidDist = makeDist(screenSpace, 1.0);

        float gradSDF = 1.0 - pow(gradDist, 3.0);
        float solidSDF = 1.0 - smoothstep(0.495, 0.5, solidDist);

        vec3 grad = vec3(gradSDF) * gradColor;
        vec3 solid = vec3(solidSDF) * fillColor;

        color.rgb += grad;
        color.a -= max(1.0 - gradSDF, 0.0);
        color.a += solidSDF;
        color.rgb = 1.0 - vec3(solidSDF);
        color.rgb *= grad;
        color.rgb += solid;

        return color;
    }

    void main() {
        vec4 color = vec4(0.1, 0.2, 0.1, 1.0);

        // Convert vUv (0..1) to centered screen space with aspect ratio correction
        vec2 screenSpace = vUv - 0.5;
        screenSpace.x *= resolution.x / resolution.y;

        // Main circle
        color += ellipseGrad(screenSpace, circle_size, grad_color, fill_color);

        // Three animated circles orbiting around
        color += ellipseGrad(screenSpace + vec2(cos(time) * 0.1, sin(time + 3.14) * 0.1), circle_size, grad_color, fill_color);
        color += ellipseGrad(screenSpace - vec2(cos(time) * 0.1, sin(time + 3.14) * 0.1), circle_size, grad_color, fill_color);
        color += ellipseGrad(screenSpace - vec2(cos(time) * 0.1, sin(time) * 0.1), circle_size, grad_color, fill_color);

        color.a = 1.0;

        gl_FragColor = color;
    }
  `
};
