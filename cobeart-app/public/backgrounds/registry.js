// Background Shader Registry
// Centralizes all available background shaders for the fluid simulation

import electricClouds from './electric-clouds/shader.js';
import circles from './circles/shader.js';
import zephyr from './zephyr/shader.js';

export default [
  electricClouds,
  circles,
  zephyr
];
