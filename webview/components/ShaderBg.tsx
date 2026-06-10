import { useEffect, useRef, useState } from 'react';

const ALPHA: Record<string, number> = { subtle: 0.12, balanced: 0.22, vivid: 0.36 };

function rgb01(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision mediump float;
uniform vec2 u_res; uniform float u_time;
uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3; uniform float u_alpha;
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = uv * 3.2;
  float t = u_time * 0.12;
  float v = sin(p.x + t);
  v += sin((p.y + t) * 1.3);
  v += sin((p.x + p.y + t) * 0.7);
  p += vec2(sin(t * 0.5), cos(t * 0.4));
  v += sin(sqrt(p.x * p.x + p.y * p.y + 1.0) * 1.5 + t);
  float m = 0.5 + 0.25 * v;
  vec3 col = mix(u_c1, u_c2, smoothstep(0.0, 0.6, m));
  col = mix(col, u_c3, smoothstep(0.55, 1.0, m));
  gl_FragColor = vec4(col, u_alpha);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

const MAX_ATTEMPTS = 8;

/**
 * WebGL plasma background. A freshly-rendered canvas can hand back an already-lost
 * context (software/cold-start); when that happens we remount a brand-new canvas
 * element (via `attempt` key) after a short delay and try again, falling back to
 * the 2D Flow (onUnsupported) only after several failures.
 */
export function ShaderBg({ intensity, theme, onUnsupported }: { intensity: string; theme: string; onUnsupported: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || dead) return;
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;

    if (!gl || gl.isContextLost()) {
      if (attempt < MAX_ATTEMPTS) {
        const t = setTimeout(() => setAttempt((a) => a + 1), 120);
        return () => clearTimeout(t);
      }
      setDead(true);
      onUnsupported();
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) { setDead(true); onUnsupported(); return; }
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setDead(true); onUnsupported(); return; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const cs = getComputedStyle(document.documentElement);
    const c1 = rgb01(cs.getPropertyValue('--accent'), [0.85, 0.47, 0.36]);
    const c2 = rgb01(cs.getPropertyValue('--blue'), [0.37, 0.61, 0.84]);
    const c3 = rgb01(cs.getPropertyValue('--violet'), [0.61, 0.55, 0.94]);
    const alpha = ALPHA[intensity] ?? 0.22;

    const u = {
      res: gl.getUniformLocation(prog, 'u_res'),
      time: gl.getUniformLocation(prog, 'u_time'),
      c1: gl.getUniformLocation(prog, 'u_c1'), c2: gl.getUniformLocation(prog, 'u_c2'),
      c3: gl.getUniformLocation(prog, 'u_c3'), alpha: gl.getUniformLocation(prog, 'u_alpha'),
    };
    gl.uniform3fv(u.c1, c1); gl.uniform3fv(u.c2, c2); gl.uniform3fv(u.c3, c3);
    gl.uniform1f(u.alpha, alpha);

    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.res, w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let running = true;
    const start = performance.now();
    const draw = () => {
      gl.uniform1f(u.time, (performance.now() - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (running) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onVis = () => { running = !document.hidden; if (running) raf = requestAnimationFrame(draw); else cancelAnimationFrame(raf); };
    const onLost = (e: Event) => { e.preventDefault(); running = false; cancelAnimationFrame(raf); };
    document.addEventListener('visibilitychange', onVis);
    canvas.addEventListener('webglcontextlost', onLost);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
    };
  }, [attempt, intensity, theme, dead, onUnsupported]);

  if (dead) return null;
  return <canvas key={attempt} className="bgfx bgfx--shader" ref={ref} aria-hidden="true" />;
}
