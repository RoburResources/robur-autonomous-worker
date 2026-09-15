import { useEffect, useRef } from 'react';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'locked';

type Props = {
  state: OrbState;
  /** 0..1 live microphone level. */
  level: number;
  /** Bumped on each spoken word so the orb pulses with the voice. */
  pulse: number;
  size?: number;
};

const LOBES = [
  { k: 3, a: 0.055, s: 0.00055, p: 0 },
  { k: 4, a: 0.038, s: -0.00042, p: 1.9 },
  { k: 5, a: 0.026, s: 0.00071, p: 3.7 },
  { k: 2, a: 0.03, s: -0.00031, p: 5.2 },
];

export default function Orb({ state, level, pulse, size = 264 }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ state, level, pulse: 0, lastPulse: 0 });

  live.current.state = state;
  live.current.level = level;
  if (pulse !== live.current.lastPulse) {
    live.current.lastPulse = pulse;
    live.current.pulse = Math.min(1, live.current.pulse + 0.42);
  }

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const cx = canvas.getContext('2d');
    if (!cx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const s = live.current;
      s.pulse *= 0.9;

      const w = canvas.width;
      const h = canvas.height;
      const px = w / 2;
      const py = h / 2;
      cx.clearRect(0, 0, w, h);

      let energy =
        s.state === 'listening'
          ? s.level
          : s.state === 'speaking'
            ? s.pulse
            : s.state === 'thinking'
              ? 0.16 + 0.1 * Math.sin(t / 420)
              : 0.02;
      if (reduced) energy = s.state === 'idle' || s.state === 'locked' ? 0.02 : 0.16;

      const base = Math.min(w, h) * 0.24;
      const R = base * (1 + energy * 0.3);
      const breathe = reduced ? 0 : Math.sin(t / 1600) * 0.012;

      // Inscribed in the canvas so the glow never clips into a square.
      const GR = Math.min(w, h) * 0.5;
      const glow = cx.createRadialGradient(px, py, Math.min(R * 0.55, GR * 0.8), px, py, GR);
      glow.addColorStop(0, `rgba(255,107,90,${(0.2 + energy * 0.3).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(255,107,90,0)');
      cx.fillStyle = glow;
      cx.beginPath();
      cx.arc(px, py, GR, 0, Math.PI * 2);
      cx.fill();

      cx.beginPath();
      const STEPS = 130;
      for (let i = 0; i <= STEPS; i++) {
        const th = (i / STEPS) * Math.PI * 2;
        let warp = 1 + breathe;
        for (const L of LOBES) {
          warp += L.a * (0.55 + energy * 1.5) * Math.sin(L.k * th + L.p + (reduced ? 0 : t * L.s));
        }
        const rr = R * warp;
        const x = px + Math.cos(th) * rr;
        const y = py + Math.sin(th) * rr;
        if (i === 0) cx.moveTo(x, y);
        else cx.lineTo(x, y);
      }
      cx.closePath();

      const g = cx.createLinearGradient(px - R, py - R, px + R, py + R);
      if (s.state === 'idle' || s.state === 'locked') {
        g.addColorStop(0, '#8A8F9E');
        g.addColorStop(0.55, '#6E7484');
        g.addColorStop(1, '#585E6E');
      } else if (s.state === 'thinking') {
        g.addColorStop(0, '#FFB03A');
        g.addColorStop(0.5, '#C77BC0');
        g.addColorStop(1, '#A855F7');
      } else {
        g.addColorStop(0, '#FFB03A');
        g.addColorStop(0.52, '#FF6B5A');
        g.addColorStop(1, '#A855F7');
      }
      cx.fillStyle = g;
      cx.globalAlpha = s.state === 'idle' || s.state === 'locked' ? 0.5 : 1;
      cx.fill();
      cx.globalAlpha = 1;

      const hi = cx.createRadialGradient(
        px - R * 0.34,
        py - R * 0.4,
        0,
        px - R * 0.34,
        py - R * 0.4,
        R * 1.15,
      );
      hi.addColorStop(0, 'rgba(255,255,255,.34)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = hi;
      cx.fill();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="orb"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
