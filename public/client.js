'use strict';

/*
 * NEON ARENA — cliente.
 * Fluidez:
 * - Predicción local del propio jugador + reconciliación con el ack del servidor.
 * - Interpolación de jugadores y balas remotos con ~120 ms de retardo.
 * - Render a la tasa del monitor con requestAnimationFrame.
 */
(() => {
  const S = window.SHARED;

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const overlay = document.getElementById('overlay');
  const nameInput = document.getElementById('name');
  const playBtn = document.getElementById('play');
  const statusEl = document.getElementById('status');
  const hpFill = document.getElementById('hpfill');
  const lbList = document.getElementById('lb-list');
  const killfeed = document.getElementById('killfeed');
  const pingEl = document.getElementById('ping');
  const onlineEl = document.getElementById('online');
  const deathEl = document.getElementById('death');
  const deathTimerEl = document.getElementById('death-timer');

  // ---------- Constantes de red ----------
  const INTERP_DELAY = 120; // ms de retardo de interpolación
  const FLUSH_MS = 40;      // envío de inputs ~25 Hz

  // ---------- Estado ----------
  let ws = null;
  let myId = null;
  let joined = false;
  let alive = false;
  let myHp = S.PLAYER.maxHp;
  let deathAt = 0;
  let seq = 0;
  let pending = [];   // inputs aún no confirmados por el servidor
  let outbox = [];    // inputs pendientes de enviar
  let lastFlush = 0;
  let localNextShot = 0;

  const pred = { x: S.WORLD.w / 2, y: S.WORLD.h / 2, vx: 0, vy: 0 }; // predicción
  const disp = { x: pred.x, y: pred.y };                             // posición dibujada (suavizada)
  let aimAngle = 0;

  const snaps = [];             // buffer de snapshots { at, p: Map, b: Map }
  const roster = new Map();     // id -> { name, color, score }
  const prevState = new Map();  // id -> { hp, dead, hitAt } para efectos
  let knownBullets = new Set();
  const bulletTrails = new Map();

  const camera = { x: 0, y: 0 };
  let shake = 0;
  let viewW = 0, viewH = 0, dpr = 1;

  const keys = Object.create(null);
  const mouse = { x: 0, y: 0, down: false };
  const particles = [];

  // ---------- Utilidades ----------
  const clamp = S.clamp;
  const lerp = (a, b, f) => a + (b - a) * f;
  const nowSec = () => performance.now() / 1000;

  function lerpAngle(a, b, f) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * f;
  }

  function camClamp(v, min, max) {
    return max < min ? (min + max) / 2 : clamp(v, min, max);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Audio sintetizado (sin ficheros) ----------
  const AudioMgr = {
    ctx: null,
    muted: false,
    noiseBuf: null,
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const len = Math.floor(this.ctx.sampleRate * 0.3);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    },
    blip(freq, endFreq, dur, type, vol) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },
    noise(dur, vol, cutoff) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter).connect(g).connect(this.ctx.destination);
      src.start(t);
      src.stop(t + dur);
    },
    shoot(own) { this.blip(own ? 640 : 470, 150, 0.09, 'square', own ? 0.11 : 0.045); },
    hurt() { this.noise(0.16, 0.22, 900); },
    death() { this.noise(0.45, 0.28, 500); this.blip(220, 40, 0.4, 'sawtooth', 0.13); },
    kill() { this.blip(520, 940, 0.14, 'triangle', 0.12); },
    respawn() { this.blip(300, 720, 0.2, 'sine', 0.1); }
  };

  // ---------- Partículas ----------
  function burst(x, y, color, n, speed, life, size) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.7);
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life, maxLife: life, color,
        size: size * (0.5 + Math.random() * 0.5)
      });
    }
  }

  function muzzleFlash(x, y) {
    particles.push({ x, y, vx: 0, vy: 0, life: 0.06, maxLife: 0.06, color: '#fff3c4', size: 15, flash: true });
  }

  // ---------- Red ----------
  function connect(name) {
    statusEl.textContent = 'Conectando…';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      joined = false;
      alive = false;
      hud.classList.add('hidden');
      deathEl.classList.add('hidden');
      overlay.classList.remove('hidden');
      statusEl.textContent = 'Conexión perdida. Pulsa JUGAR para reintentar.';
      snaps.length = 0;
      roster.clear();
      prevState.clear();
    };
  }

  function handle(msg) {
    switch (msg.t) {
      case 'init': {
        myId = msg.id;
        roster.clear();
        prevState.clear();
        snaps.length = 0;
        knownBullets = new Set();
        bulletTrails.clear();
        for (const p of msg.players) {
          roster.set(p.id, { name: p.name, color: p.color, score: p.score });
          prevState.set(p.id, { hp: p.hp, dead: p.dead, hitAt: 0 });
        }
        const me = msg.players.find(p => p.id === myId);
        if (me) {
          pred.x = me.x; pred.y = me.y; pred.vx = 0; pred.vy = 0;
          disp.x = me.x; disp.y = me.y;
          camera.x = camClamp(me.x - viewW / 2, -60, S.WORLD.w - viewW + 60);
          camera.y = camClamp(me.y - viewH / 2, -60, S.WORLD.h - viewH + 60);
        }
        joined = true;
        alive = true;
        myHp = S.PLAYER.maxHp;
        pending = [];
        outbox = [];
        overlay.classList.add('hidden');
        hud.classList.remove('hidden');
        updateHud();
        updateLeaderboard();
        updateOnline();
        break;
      }
      case 'join':
        roster.set(msg.p.id, { name: msg.p.name, color: msg.p.color, score: msg.p.score });
        prevState.set(msg.p.id, { hp: msg.p.hp, dead: msg.p.dead, hitAt: 0 });
        feed(`<b style="color:${esc(msg.p.color)}">${esc(msg.p.name)}</b> se ha unido`);
        updateOnline();
        break;
      case 'leave': {
        const meta = roster.get(msg.id);
        if (meta) feed(`<b style="color:#8b949e">${esc(meta.name)}</b> se ha ido`);
        roster.delete(msg.id);
        prevState.delete(msg.id);
        updateLeaderboard();
        updateOnline();
        break;
      }
      case 'st':
        onState(msg);
        break;
      case 'kill':
        feed(`<b style="color:${esc(msg.kc)}">${esc(msg.k)}</b> ⚡ <b style="color:${esc(msg.vc)}">${esc(msg.v)}</b>`);
        if (msg.kid === myId) AudioMgr.kill();
        break;
      case 'pong':
        pingEl.textContent = `${Math.max(0, Math.round(performance.now() - msg.ts))} ms`;
        break;
      case 'full':
        statusEl.textContent = 'Servidor lleno, inténtalo más tarde.';
        break;
    }
  }

  function onState(msg) {
    const at = performance.now();
    const pm = new Map();
    for (const a of msg.p) {
      pm.set(a[0], { id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], a: a[5], hp: a[6], score: a[7], dead: !!a[8] });
    }
    const bm = new Map();
    for (const a of msg.b) bm.set(a[0], { x: a[1], y: a[2], owner: a[3] });
    snaps.push({ at, p: pm, b: bm });
    if (snaps.length > 60) snaps.shift();

    // Efectos por cambios de estado (impactos, muertes, reapariciones).
    for (const [id, p] of pm) {
      const old = prevState.get(id);
      if (old) {
        if (!old.dead && p.dead) {
          const color = roster.get(id) ? roster.get(id).color : '#8b949e';
          burst(p.x, p.y, color, 26, 300, 0.65, 4.5);
          burst(p.x, p.y, '#ffffff', 8, 160, 0.3, 3);
          if (id === myId) onDeath();
          else if (Math.hypot(p.x - disp.x, p.y - disp.y) < 1000) AudioMgr.death();
        } else if (p.hp < old.hp && !p.dead) {
          const color = roster.get(id) ? roster.get(id).color : '#ffffff';
          burst(p.x, p.y, color, 7, 220, 0.35, 3);
          old.hitAt = at;
          if (id === myId) { shake = 13; AudioMgr.hurt(); }
        }
        if (old.dead && !p.dead && id === myId) onRespawn(p);
        old.hp = p.hp;
        old.dead = p.dead;
      } else {
        prevState.set(id, { hp: p.hp, dead: p.dead, hitAt: 0 });
      }
      const meta = roster.get(id);
      if (meta) meta.score = p.score;
    }

    // Balas nuevas → fogonazo y sonido (las propias ya sonaron en local).
    for (const [id, b] of bm) {
      if (!knownBullets.has(id)) {
        if (b.owner !== myId) {
          muzzleFlash(b.x, b.y);
          if (Math.hypot(b.x - disp.x, b.y - disp.y) < 950) AudioMgr.shoot(false);
        }
      }
    }
    knownBullets = new Set(bm.keys());

    // Reconciliación del propio jugador.
    const me = pm.get(myId);
    if (me) {
      myHp = me.hp;
      if (!me.dead && alive) {
        pending = pending.filter(i => i.s > msg.ack);
        const rec = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
        for (const i of pending) S.applyInput(rec, i.k & 15, i.d);
        pred.x = rec.x; pred.y = rec.y; pred.vx = rec.vx; pred.vy = rec.vy;
      }
      updateHud();
    }
  }

  function onDeath() {
    alive = false;
    deathAt = performance.now();
    pending = [];
    deathEl.classList.remove('hidden');
    AudioMgr.death();
  }

  function onRespawn(me) {
    alive = true;
    pred.x = me.x; pred.y = me.y; pred.vx = 0; pred.vy = 0;
    disp.x = me.x; disp.y = me.y;
    pending = [];
    deathEl.classList.add('hidden');
    AudioMgr.respawn();
  }

  // ---------- HUD ----------
  function updateHud() {
    const pct = clamp(myHp / S.PLAYER.maxHp, 0, 1);
    hpFill.style.width = `${pct * 100}%`;
    hpFill.classList.toggle('low', pct < 0.35);
  }

  function updateOnline() {
    onlineEl.textContent = roster.size;
  }

  function updateLeaderboard() {
    const rows = [...roster.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);
    lbList.innerHTML = rows.map(([id, m]) =>
      `<div class="lb-row${id === myId ? ' me' : ''}">` +
      `<span class="dot" style="background:${esc(m.color)}"></span>` +
      `<span class="lb-name">${esc(m.name)}</span>` +
      `<span class="lb-score">${m.score}</span></div>`
    ).join('');
  }

  function feed(html) {
    const div = document.createElement('div');
    div.className = 'feed-item';
    div.innerHTML = html;
    killfeed.prepend(div);
    while (killfeed.children.length > 6) killfeed.lastChild.remove();
    setTimeout(() => div.remove(), 4600);
  }

  // ---------- Interpolación de snapshots ----------
  function sample(nowMs) {
    const outP = new Map(), outB = new Map();
    if (!snaps.length) return { players: outP, bullets: outB };
    const rt = nowMs - INTERP_DELAY;
    while (snaps.length > 2 && snaps[1].at <= rt) snaps.shift();

    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].at <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) { a = snaps[0]; b = null; }

    let f = 0;
    if (b && b.at > a.at) f = clamp((rt - a.at) / (b.at - a.at), 0, 1);
    const src = b || a;

    for (const [id, pb] of src.p) {
      const pa = a.p.get(id);
      if (!pa || !b) { outP.set(id, pb); continue; }
      outP.set(id, {
        ...pb,
        x: lerp(pa.x, pb.x, f),
        y: lerp(pa.y, pb.y, f),
        a: lerpAngle(pa.a, pb.a, f)
      });
    }
    for (const [id, bb] of src.b) {
      const ba = a.b.get(id);
      if (!ba || !b) { outB.set(id, bb); continue; }
      outB.set(id, { ...bb, x: lerp(ba.x, bb.x, f), y: lerp(ba.y, bb.y, f) });
    }
    return { players: outP, bullets: outB };
  }

  // ---------- Bucle de simulación local ----------
  function step(dt, nowMs) {
    // Ángulo de apuntado desde la posición dibujada al ratón (en mundo).
    const wmx = camera.x + mouse.x;
    const wmy = camera.y + mouse.y;
    aimAngle = Math.atan2(wmy - disp.y, wmx - disp.x);

    if (joined && alive && ws && ws.readyState === 1) {
      let k = 0;
      if (keys.KeyA || keys.ArrowLeft) k |= 1;
      if (keys.KeyD || keys.ArrowRight) k |= 2;
      if (keys.KeyW || keys.ArrowUp) k |= 4;
      if (keys.KeyS || keys.ArrowDown) k |= 8;
      if (mouse.down || keys.Space) k |= 16;

      const d = Math.min(dt, 0.05);
      const inp = { s: ++seq, d, k, a: Math.round(aimAngle * 1000) / 1000 };
      S.applyInput(pred, k & 15, d);
      pending.push(inp);
      if (pending.length > 240) pending.shift();
      outbox.push([inp.s, inp.d, inp.k, inp.a]);

      // Feedback inmediato del disparo (el proyectil real llega del servidor).
      if ((k & 16) && nowSec() >= localNextShot) {
        localNextShot = nowSec() + S.BULLET.cooldown;
        const off = S.PLAYER.radius + 10;
        muzzleFlash(disp.x + Math.cos(aimAngle) * off, disp.y + Math.sin(aimAngle) * off);
        AudioMgr.shoot(true);
      }
    }

    if (nowMs - lastFlush >= FLUSH_MS && ws && ws.readyState === 1) {
      if (outbox.length) {
        ws.send(JSON.stringify({ t: 'in', l: outbox }));
        outbox = [];
      }
      lastFlush = nowMs;
    }

    // Suavizado de la posición propia dibujada.
    const sf = 1 - Math.exp(-dt * 20);
    disp.x += (pred.x - disp.x) * sf;
    disp.y += (pred.y - disp.y) * sf;
    if (Math.hypot(pred.x - disp.x, pred.y - disp.y) > 120) { disp.x = pred.x; disp.y = pred.y; }

    // Cámara: sigue al jugador; en el menú orbita por la arena.
    let tx, ty;
    if (joined) {
      tx = disp.x - viewW / 2;
      ty = disp.y - viewH / 2;
    } else {
      const t = nowMs / 1000;
      tx = S.WORLD.w / 2 + Math.cos(t * 0.13) * 300 - viewW / 2;
      ty = S.WORLD.h / 2 + Math.sin(t * 0.09) * 200 - viewH / 2;
    }
    const cf = 1 - Math.exp(-dt * 8);
    camera.x += (camClamp(tx, -60, S.WORLD.w - viewW + 60) - camera.x) * cf;
    camera.y += (camClamp(ty, -60, S.WORLD.h - viewH + 60) - camera.y) * cf;

    shake *= Math.exp(-dt * 7);
    if (shake < 0.3) shake = 0;

    // Partículas.
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-dt * 4);
      p.vy *= Math.exp(-dt * 4);
    }

    // Contador de reaparición.
    if (joined && !alive) {
      const remaining = Math.max(0, S.PLAYER.respawnTime - (nowMs - deathAt) / 1000);
      deathTimerEl.textContent = remaining.toFixed(1);
    }
  }

  // ---------- Render ----------
  function drawArena(camX, camY) {
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(camX, camY, viewW, viewH);

    ctx.fillStyle = '#10141d';
    ctx.fillRect(0, 0, S.WORLD.w, S.WORLD.h);

    // Rejilla (solo la parte visible).
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 100;
    const x0 = Math.max(0, Math.floor(camX / step) * step);
    const x1 = Math.min(S.WORLD.w, camX + viewW);
    const y0 = Math.max(0, Math.floor(camY / step) * step);
    const y1 = Math.min(S.WORLD.h, camY + viewH);
    for (let x = x0; x <= x1; x += step) { ctx.moveTo(x, Math.max(0, camY)); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += step) { ctx.moveTo(Math.max(0, camX), y); ctx.lineTo(x1, y); }
    ctx.stroke();

    // Muros.
    for (const w of S.WALLS) {
      ctx.fillStyle = '#222b3d';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = 'rgba(110,170,255,0.16)';
      ctx.lineWidth = 2;
      ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
    }

    // Borde de la arena con brillo.
    ctx.strokeStyle = 'rgba(61,218,215,0.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(40, 40, S.WORLD.w - 80, S.WORLD.h - 80);
  }

  function drawPlayer(x, y, angle, color, name, hp, isMe, hitAt, nowMs) {
    const r = S.PLAYER.radius;

    // Cañón.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = '#2b3345';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(6, -6, r + 14, 12, 4);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Cuerpo.
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.2, x, y, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, color);
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Destello al recibir un impacto.
    if (hitAt && nowMs - hitAt < 120) {
      ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - (nowMs - hitAt) / 120)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (isMe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Barra de vida y nombre.
    const bw = 48, bh = 5;
    const pct = clamp(hp / S.PLAYER.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - bw / 2, y - r - 16, bw, bh);
    ctx.fillStyle = `hsl(${pct * 120}, 70%, 48%)`;
    ctx.fillRect(x - bw / 2, y - r - 16, bw * pct, bh);

    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? 'rgba(255,255,255,0.95)' : 'rgba(230,237,243,0.75)';
    ctx.fillText(name, x, y - r - 22);
  }

  function drawBullets(bulls) {
    ctx.globalCompositeOperation = 'lighter';
    const liveIds = new Set();
    for (const [id, b] of bulls) {
      liveIds.add(id);
      const meta = roster.get(b.owner);
      const color = meta ? meta.color : '#ffd166';

      const prev = bulletTrails.get(id);
      if (prev) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      bulletTrails.set(id, { x: b.x, y: b.y });

      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 11);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.35, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 11, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const id of bulletTrails.keys()) {
      if (!liveIds.has(id)) bulletTrails.delete(id);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawParticles() {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      if (p.flash) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
        g.addColorStop(0, `rgba(255,243,196,${0.85 * a})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * a + 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function render(nowMs) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const camX = camera.x + (shake ? (Math.random() - 0.5) * shake : 0);
    const camY = camera.y + (shake ? (Math.random() - 0.5) * shake : 0);
    ctx.translate(-camX, -camY);

    drawArena(camX, camY);

    const view = sample(nowMs);
    drawBullets(view.bullets);

    for (const [id, p] of view.players) {
      if (p.dead) continue;
      const meta = roster.get(id);
      const st = prevState.get(id);
      if (id === myId) {
        if (alive) {
          drawPlayer(disp.x, disp.y, aimAngle, meta ? meta.color : '#3ddad7',
            meta ? meta.name : '', myHp, true, st ? st.hitAt : 0, nowMs);
        }
        continue;
      }
      drawPlayer(p.x, p.y, p.a, meta ? meta.color : '#8b949e',
        meta ? meta.name : '', p.hp, false, st ? st.hitAt : 0, nowMs);
    }

    drawParticles();
  }

  // ---------- Bucle principal ----------
  let lastFrame = performance.now();
  function frame(nowMs) {
    requestAnimationFrame(frame);
    const dt = Math.min((nowMs - lastFrame) / 1000, 0.05);
    lastFrame = nowMs;
    step(dt, nowMs);
    render(nowMs);
  }

  // ---------- Entrada ----------
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === nameInput) {
      if (e.key === 'Enter') playBtn.click();
      return;
    }
    keys[e.code] = true;
    if (e.code === 'KeyM') AudioMgr.muted = !AudioMgr.muted;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    mouse.down = false;
  });

  window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) mouse.down = true; });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.down = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  playBtn.addEventListener('click', () => {
    AudioMgr.init();
    if (AudioMgr.ctx && AudioMgr.ctx.state === 'suspended') AudioMgr.ctx.resume();
    const name = nameInput.value.trim() || 'Anon';
    try { localStorage.setItem('na_name', name); } catch {}
    if (!ws || ws.readyState !== WebSocket.OPEN) connect(name);
    else if (!joined) ws.send(JSON.stringify({ t: 'join', name }));
  });

  try {
    const saved = localStorage.getItem('na_name');
    if (saved) nameInput.value = saved;
  } catch {}

  // ---------- Redimensionado ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
  }
  window.addEventListener('resize', resize);
  resize();

  // Ping y clasificación periódicos.
  setInterval(() => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
  }, 2000);
  setInterval(() => { if (joined) updateLeaderboard(); }, 500);

  nameInput.focus();
  requestAnimationFrame(frame);
})();
