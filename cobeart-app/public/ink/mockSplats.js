// javascript
const MockSplats = (function(){
  const arena = { x: 3000, y: 3000 };
  let timer = null;
  let agents = [];
  let lastT = 0;

  function screenToArena(screenX, screenY) {
    const pr = window.devicePixelRatio || 1;
    const w = window.innerWidth * pr;
    const h = window.innerHeight * pr;
    const normX = screenX / w;
    const normY = screenY / h;
    // invert listener mapping:
    const mX = arena.x - 2 * arena.x * normX;
    const mY = 2 * arena.y * (1 - normY) - arena.y;
    return { x: mX, y: mY };
  }

  function emit(agent, dt) {
    // update agent position according to mode
    const a = agent;
    const t = performance.now() / 1000;
    let nx = a.sx, ny = a.sy;

    if (a.mode === 'static') {
      nx = a.sx; ny = a.sy;
    } else if (a.mode === 'linear') {
      const period = a.period || 2.0;
      const u = (Math.sin(t * (2*Math.PI/period)) + 1) / 2;
      nx = a.sx * (1-u) + a.tx * u;
      ny = a.sy * (1-u) + a.ty * u;
    } else if (a.mode === 'circle') {
      const speed = a.speed || 1.0;
      const r = a.radius || Math.min(window.innerWidth, window.innerHeight) * 0.15;
      const cx = a.cx !== undefined ? a.cx : window.innerWidth/2;
      const cy = a.cy !== undefined ? a.cy : window.innerHeight/2;
      const ang = (t * speed + (a.phase||0)) * (a.clockwise?-1:1);
      nx = cx + Math.cos(ang) * r;
      ny = cy + Math.sin(ang) * r;
    } else if (a.mode === 'random') {
      // random walk with smoothing
      a.vx = (a.vx || 0) * 0.9 + (Math.random()-0.5) * (a.step||20);
      a.vy = (a.vy || 0) * 0.9 + (Math.random()-0.5) * (a.step||20);
      nx = (a.sx += a.vx * (dt||0.016));
      ny = (a.sy += a.vy * (dt||0.016));
    }

    // convert to arena coords
    const arenaPos = screenToArena(nx, ny);
    // compute velocity in arena-space (approx from previous)
    const prev = a._prev || { x: arenaPos.x, y: arenaPos.y, t };
    const vx = (arenaPos.x - prev.x) / Math.max(1e-6, (t - prev.t));
    const vy = (arenaPos.y - prev.y) / Math.max(1e-6, (t - prev.t));

    // build message like fluid-bridge splat
    const msg = {
      type: 'splat',
      id: a.id,
      x: arenaPos.x,
      y: arenaPos.y,
      vx: vx,
      vy: vy
    };

    window.postMessage(msg, '*');

    a._prev = { x: arenaPos.x, y: arenaPos.y, t };
    a._lastScreen = { x: nx, y: ny };
  }

  function step() {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    for (let i=0;i<agents.length;i++) emit(agents[i], dt);
  }

  return {
    // config: { intervalMs, agents: [ { id, mode, sx, sy, tx, ty, ... } ] }
    start(cfg = {}) {
      this.stop();
      agents = (cfg.agents || []).map(a => Object.assign({}, a));
      const interval = cfg.intervalMs || 60;
      lastT = performance.now();
      // initialize screen positions if given as arena coords helper:
      agents.forEach(a=>{
        if (a.screen) {
          a.sx = a.screen.x; a.sy = a.screen.y;
        } else if (a.arena) {
          // convert arena->screen (reverse of screenToArena)
          const pr = window.devicePixelRatio || 1;
          const w = window.innerWidth * pr;
          const h = window.innerHeight * pr;
          const normX = (arena.x - a.arena.x) / (2*arena.x);
          const normY = (a.arena.y + arena.y) / (2*arena.y);
          a.sx = normX * w;
          a.sy = (1 - normY) * h;
        } else {
          // default center
          a.sx = a.sx ?? window.innerWidth/2;
          a.sy = a.sy ?? window.innerHeight/2;
        }
      });
      timer = setInterval(step, interval);
      return { started: true, count: agents.length };
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      agents = [];
    },

    // convenience to add agent while running
    addAgent(a) {
      agents.push(Object.assign({}, a));
    }
  };
})();

// Example usage (paste in console or include file):
// MockSplats.start({
//   intervalMs: 50,
//   agents: [
//     { id: 1, mode: 'circle', cx: window.innerWidth/2, cy: window.innerHeight/2, radius: 200, speed: 1.2 },
//     { id: 2, mode: 'linear', sx: 100, sy: 100, tx: window.innerWidth-100, ty: 200, period: 3.0 },
//     { id: 3, mode: 'static', sx: window.innerWidth*0.25, sy: window.innerHeight*0.75 }
//   ]
// });
// Stop: MockSplats.stop();