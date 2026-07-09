import { useEffect, useRef } from "react";
import "./cosmos-stars.css";

/**
 * Full-screen cosmos backdrop for the admin — a fixed star canvas (drift +
 * twinkle + shooting stars + scroll parallax) plus three drifting nebula
 * glows, matching the Console design. Sits at z-0 behind the whole shell;
 * mount it once and layer the shell above (relative z-10) with the sidebar
 * translucent + the content surface transparent so the backdrop reads through.
 * Honors prefers-reduced-motion (static star frame, no nebula animation).
 */
export function CosmosStars() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    const stars: {
      x: number;
      y: number;
      r: number;
      depth: number;
      drift: number;
      tw: number;
      sp: number;
    }[] = [];
    const shooting: { x: number; y: number; vx: number; vy: number; life: number }[] = [];

    const make = () => {
      stars.length = 0;
      const n = Math.round((w * h) / 6500);
      for (let i = 0; i < n; i++) {
        const depth = Math.random();
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: depth * 1.4 + 0.2,
          depth: depth * 0.6 + 0.12,
          drift: 0.02 + depth * 0.05,
          tw: Math.random() * 6.28,
          sp: 0.003 + Math.random() * 0.006,
        });
      }
    };
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      make();
    };
    const paintStatic = () => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        ctx.globalAlpha = 0.5 * (0.45 + s.depth);
        ctx.fillStyle = s.depth > 0.45 ? "#cdbcff" : "#ffffff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      const sy = window.scrollY || 0;
      for (const s of stars) {
        s.tw += s.sp;
        s.y += s.drift;
        if (s.y > h) s.y -= h;
        const a = 0.35 + Math.sin(s.tw) * 0.45;
        let yy = s.y - sy * s.depth * 0.15;
        yy = ((yy % h) + h) % h;
        ctx.globalAlpha = Math.max(0, a) * (0.45 + s.depth);
        ctx.fillStyle = s.depth > 0.45 ? "#cdbcff" : "#ffffff";
        ctx.beginPath();
        ctx.arc(s.x, yy, s.r, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (Math.random() < 0.005 && shooting.length < 2) {
        shooting.push({
          x: Math.random() * w * 0.8,
          y: Math.random() * h * 0.35,
          vx: 6 + Math.random() * 5,
          vy: 2 + Math.random() * 2.5,
          life: 0,
        });
      }
      for (let i = shooting.length - 1; i >= 0; i--) {
        const m = shooting[i];
        if (!m) continue;
        m.x += m.vx;
        m.y += m.vy;
        m.life++;
        const tx = m.x - m.vx * 9;
        const ty = m.y - m.vy * 9;
        const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
        grad.addColorStop(0, "rgba(205,188,255,0.9)");
        grad.addColorStop(1, "rgba(205,188,255,0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        if (m.x > w || m.y > h || m.life > 140) shooting.splice(i, 1);
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener("resize", resize);
    if (reduce) {
      paintStatic();
    } else {
      tick();
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
      <canvas
        ref={ref}
        tabIndex={-1}
        aria-hidden="true"
        className="cosmos-canvas pointer-events-none fixed inset-0 z-0 h-screen w-screen"
      />
      <div aria-hidden="true" className="cosmos-neb-layer pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="cosmos-neb cosmos-neb-1" />
        <div className="cosmos-neb cosmos-neb-2" />
        <div className="cosmos-neb cosmos-neb-3" />
      </div>
    </>
  );
}
