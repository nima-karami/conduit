// Shared GLSL for the custom-shader background. The user's fragment shader receives:
//   uniform vec2  u_res;          // canvas size in pixels
//   uniform float u_time;         // seconds since start
//   uniform vec3  u_c1, u_c2, u_c3; // theme colours (accent / blue / violet), 0..1
//   uniform float u_alpha;        // intensity-derived alpha for gl_FragColor

export const SHADER_UNIFORMS_DOC =
  'uniform vec2 u_res; uniform float u_time; uniform vec3 u_c1,u_c2,u_c3; uniform float u_alpha;';

/** Default animated-gradient template shown when the user has no custom shader yet. */
export const DEFAULT_CUSTOM = `precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_c1; // accent
uniform vec3 u_c2; // blue
uniform vec3 u_c3; // violet
uniform float u_alpha;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float t = u_time * 0.12;
  // diagonal animated gradient that breathes between the three theme colours
  float g = 0.5 + 0.5 * sin(uv.x * 3.0 + uv.y * 2.0 + t * 2.0);
  float h = 0.5 + 0.5 * cos((uv.x - uv.y) * 2.5 - t * 1.5);
  vec3 col = mix(u_c1, u_c2, uv.y);
  col = mix(col, u_c3, g * 0.6);
  col = mix(col, u_c1, h * 0.25);
  gl_FragColor = vec4(col, u_alpha);
}`;

/** Compile a fragment shader in a throwaway WebGL context to check validity. */
export function validateShader(source: string): { ok: boolean; log: string } {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { ok: false, log: 'WebGL unavailable' };
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) return { ok: false, log: 'Could not create shader' };
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    const ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    const log = ok ? '' : (gl.getShaderInfoLog(sh) || 'compile failed');
    gl.deleteShader(sh);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok, log };
  } catch (e) {
    return { ok: false, log: e instanceof Error ? e.message : String(e) };
  }
}
