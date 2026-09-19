// Celebration burst for the win modal, drawn over its backdrop and under the
// card. Shared by both boards.

const GRAVITY = 0.035;
const COLORS = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#c084fc', '#f472b6'];

let frameHandle = null;
let cleanup = null;

function burst(particles, x, y) {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const count = 44 + Math.floor(Math.random() * 28);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.25;
    const speed = 1.4 + Math.random() * 3.2;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.008 + Math.random() * 0.012,
      color,
    });
  }
}

export function startFireworks(canvas) {
  stopFireworks();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const ctx = canvas.getContext('2d');
  const particles = [];
  let nextLaunch = 0;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const frame = (now) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (now > nextLaunch) {
      burst(particles, w * (0.15 + Math.random() * 0.7), h * (0.12 + Math.random() * 0.45));
      nextLaunch = now + 340 + Math.random() * 520;
    }

    // Fade what is already there instead of clearing, which leaves trails.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += GRAVITY;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    frameHandle = requestAnimationFrame(frame);
  };
  frameHandle = requestAnimationFrame(frame);

  cleanup = () => {
    window.removeEventListener('resize', resize);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}

export function stopFireworks() {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
