import { useEffect, useRef } from 'react';
import { useSettings } from '../settings';

const MUL: Record<string, number> = { subtle: 0.6, balanced: 1, vivid: 1.6 };
const ALPHA: Record<string, number> = { subtle: 0.10, balanced: 0.18, vivid: 0.30 };

/** "#rrggbb" + alpha → "rgba(...)". Falls back to the accent colour. */
function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(217,119,92,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function FlowCanvas({ intensity, theme }: { intensity: string; theme: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const cs = getComputedStyle(document.documentElement);
    const colors = ['--accent', '--blue', '--violet', '--accent-2']
      .map((v) => cs.getPropertyValue(v).trim() || '#d9775c');
    const alpha = ALPHA[intensity] ?? 0.18;
    const blobs = Array.from({ length: 5 }, (_, i) => ({
      x: Math.random(), y: Math.random(), r: 0.28 + Math.random() * 0.22,
      ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random() * 0.8,
      c: colors[i % colors.length],
    }));
    const resize = () => { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let running = true;
    const draw = (t: number) => {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      for (const b of blobs) {
        const cx = (b.x + Math.sin(t * 0.00006 * b.sp + b.ph) * 0.18) * w;
        const cy = (b.y + Math.cos(t * 0.00005 * b.sp + b.ph) * 0.18) * h;
        const rad = b.r * Math.max(w, h);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, rgba(b.c, alpha));
        g.addColorStop(1, rgba(b.c, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      if (running) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onVis = () => {
      running = !document.hidden;
      if (running) raf = requestAnimationFrame(draw);
      else cancelAnimationFrame(raf);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intensity, theme]);

  return <canvas className="bgfx bgfx--flow" ref={ref} aria-hidden="true" />;
}

export function AnimatedBg() {
  const { settings } = useSettings();
  const { background, bgIntensity, reduceMotion, theme } = settings;

  if (background === 'none') return null;
  if (background === 'flow') {
    return reduceMotion ? null : <FlowCanvas intensity={bgIntensity} theme={theme} />;
  }
  // CSS modes (aurora / mesh / grid) — intensity via the --bgfx-mul multiplier.
  return <div className="bgfx" aria-hidden="true" style={{ ['--bgfx-mul' as string]: String(MUL[bgIntensity] ?? 1) }} />;
}
