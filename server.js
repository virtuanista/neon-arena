'use strict';

/*
 * NEON ARENA — servidor autoritativo.
 * - HTTP sirve los ficheros estáticos de /public.
 * - WebSocket recibe inputs de los clientes y los aplica de inmediato
 *   (movimiento determinista compartido con el cliente en public/shared.js).
 * - Bucle de física a 30 Hz (balas, daño, regeneración, bots).
 * - Snapshots del estado a 20 Hz con ack del último input procesado
 *   para la reconciliación del cliente.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const S = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const TARGET_BOTS = process.env.BOTS !== undefined ? Math.max(0, parseInt(process.env.BOTS, 10) || 0) : 3;
const MAX_PLAYERS = 20;

const TICK = 1 / 30;
const SNAPSHOT_MS = 50;

// ---------- Servidor HTTP estático ----------

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Estado del juego ----------

const players = new Map(); // id -> jugador
const bullets = [];
let nextId = 1;
let nextBulletId = 1;

const COLORS = ['#3ddad7', '#ff5d5d', '#ffd166', '#9775fa', '#69db7c', '#ff9f43', '#4dabf7', '#f783ac', '#a9e34b', '#e599f7'];
const BOT_NAMES = ['Rex', 'Nova', 'Vega', 'Kilo', 'Pixel', 'Turbo', 'Zumo', 'Bit'];

const now = () => Date.now() / 1000;
const r1 = (v) => Math.round(v * 10) / 10;

function pickColor() {
  const used = new Map();
  for (const p of players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
  let best = COLORS[0], bestN = Infinity;
  for (const c of COLORS) {
    const n = used.get(c) || 0;
    if (n < bestN) { bestN = n; best = c; }
  }
  return best;
}

function sanitizeName(n) {
  if (typeof n !== 'string') return 'Anon';
  n = n.replace(/[^\x20-\x7EáéíóúÁÉÍÓÚñÑüÜ¡¿]/g, '').trim().slice(0, 14);
  return n || 'Anon';
}

function spawn(p) {
  // Elige el punto de aparición más alejado de los enemigos vivos.
  let best = S.SPAWNS[0], bestD = -1;
  for (const s of S.SPAWNS) {
    let dMin = Infinity;
    for (const q of players.values()) {
      if (q === p || q.dead) continue;
      dMin = Math.min(dMin, Math.hypot(q.x - s.x, q.y - s.y));
    }
    const d = dMin === Infinity ? Math.random() * 1000 : dMin;
    if (d > bestD) { bestD = d; best = s; }
  }
  p.x = best.x; p.y = best.y;
  p.vx = 0; p.vy = 0;
  p.hp = S.PLAYER.maxHp;
  p.dead = false;
  p.lastDamageAt = -Infinity;
}

function makePlayer(name, isBot, ws) {
  const p = {
    id: nextId++,
    name,
    isBot,
    ws: ws || null,
    color: pickColor(),
    x: 0, y: 0, vx: 0, vy: 0,
    angle: 0,
    hp: S.PLAYER.maxHp,
    score: 0,
    deaths: 0,
    dead: false,
    respawnAt: 0,
    lastSeq: 0,
    nextShotAt: 0,
    lastDamageAt: -Infinity,
    inputBudget: 0.1,
    lastBudgetAt: now(),
    // IA de bots
    wanderTarget: null,
    wanderUntil: 0,
    losSince: 0,
    strafeDir: 1,
    strafeUntil: 0
  };
  spawn(p);
  return p;
}

function metaOf(p) {
  return { id: p.id, name: p.name, color: p.color, score: p.score, hp: Math.round(p.hp), x: r1(p.x), y: r1(p.y), dead: p.dead };
}

function broadcast(obj, exceptWs) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws !== exceptWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

// ---------- Disparos y daño ----------

function tryShoot(p) {
  const t = now();
  if (t < p.nextShotAt) return;
  p.nextShotAt = t + S.BULLET.cooldown;
  const dx = Math.cos(p.angle), dy = Math.sin(p.angle);
  const off = S.PLAYER.radius + S.BULLET.radius + 2;
  bullets.push({
    id: nextBulletId++,
    owner: p.id,
    x: p.x + dx * off,
    y: p.y + dy * off,
    vx: dx * S.BULLET.speed,
    vy: dy * S.BULLET.speed,
    diesAt: t + S.BULLET.lifetime
  });
}

function damage(victim, attackerId) {
  const t = now();
  victim.hp -= S.BULLET.damage;
  victim.lastDamageAt = t;
  if (victim.hp > 0) return;
  victim.hp = 0;
  victim.dead = true;
  victim.deaths++;
  victim.respawnAt = t + S.PLAYER.respawnTime;
  const attacker = players.get(attackerId);
  if (attacker) attacker.score++;
  broadcast({
    t: 'kill',
    kid: attacker ? attacker.id : 0,
    vid: victim.id,
    k: attacker ? attacker.name : '???',
    v: victim.name,
    kc: attacker ? attacker.color : '#8b949e',
    vc: victim.color
  });
}

function circleHitsRect(x, y, r, rect) {
  const cx = S.clamp(x, rect.x, rect.x + rect.w);
  const cy = S.clamp(y, rect.y, rect.y + rect.h);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

function hitsWall(x, y, r) {
  for (const w of S.WALLS) if (circleHitsRect(x, y, r, w)) return true;
  return false;
}

// ---------- Inputs de los clientes ----------

function handleInputs(p, list) {
  if (!Array.isArray(list)) return;
  const t = now();
  // Presupuesto de tiempo simulable: evita acelerar el juego enviando dt inflados.
  p.inputBudget = Math.min(0.25, p.inputBudget + (t - p.lastBudgetAt) * 1.15);
  p.lastBudgetAt = t;
  for (const item of list.slice(0, 40)) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [seq, dt, k, a] = item;
    if (!Number.isFinite(seq) || !Number.isFinite(dt) || !Number.isFinite(k) || !Number.isFinite(a)) continue;
    if (seq <= p.lastSeq) continue;
    p.lastSeq = seq;
    p.angle = a;
    if (p.dead) continue;
    let step = Math.min(Math.max(dt, 0), 0.05);
    step = Math.min(step, p.inputBudget);
    if (step > 0) {
      p.inputBudget -= step;
      S.applyInput(p, k & 15, step);
    }
    if (k & 16) tryShoot(p);
  }
}

// ---------- IA de los bots ----------

function randomOpenPoint() {
  for (let i = 0; i < 25; i++) {
    const x = 90 + Math.random() * (S.WORLD.w - 180);
    const y = 90 + Math.random() * (S.WORLD.h - 180);
    if (!hitsWall(x, y, S.PLAYER.radius + 12)) return { x, y };
  }
  return { x: S.WORLD.w / 2, y: S.WORLD.h / 2 };
}

function botThink(p, t) {
  let target = null, targetD = Infinity;
  for (const q of players.values()) {
    if (q === p || q.dead) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < targetD) { targetD = d; target = q; }
  }

  let mx = 0, my = 0;
  const sees = target && targetD < 750 && S.hasLineOfSight(p.x, p.y, target.x, target.y);
  if (sees) {
    if (!p.losSince) p.losSince = t;
    // Apunta con predicción básica y algo de ruido para ser batible.
    const lead = targetD / S.BULLET.speed;
    const tx = target.x + target.vx * lead;
    const ty = target.y + target.vy * lead;
    p.angle = Math.atan2(ty - p.y, tx - p.x) + (Math.random() - 0.5) * 0.14;
    if (t - p.losSince > 0.35) {
      tryShoot(p);
      p.nextShotAt = Math.max(p.nextShotAt, t + 0.45); // cadencia más lenta que un humano
    }
    // Se mueve en zigzag manteniendo la distancia.
    if (t > p.strafeUntil) {
      p.strafeDir = Math.random() < 0.5 ? -1 : 1;
      p.strafeUntil = t + 0.8 + Math.random();
    }
    const dirx = (target.x - p.x) / targetD, diry = (target.y - p.y) / targetD;
    mx = -diry * p.strafeDir;
    my = dirx * p.strafeDir;
    if (targetD > 420) { mx += dirx * 0.9; my += diry * 0.9; }
    else if (targetD < 240) { mx -= dirx * 0.9; my -= diry * 0.9; }
  } else {
    p.losSince = 0;
    if (!p.wanderTarget || t > p.wanderUntil ||
        Math.hypot(p.wanderTarget.x - p.x, p.wanderTarget.y - p.y) < 60) {
      p.wanderTarget = randomOpenPoint();
      p.wanderUntil = t + 4;
    }
    const wd = Math.hypot(p.wanderTarget.x - p.x, p.wanderTarget.y - p.y) || 1;
    mx = (p.wanderTarget.x - p.x) / wd;
    my = (p.wanderTarget.y - p.y) / wd;
    p.angle = Math.atan2(my, mx);
  }

  let k = 0;
  if (mx < -0.35) k |= 1; else if (mx > 0.35) k |= 2;
  if (my < -0.35) k |= 4; else if (my > 0.35) k |= 8;
  S.applyInput(p, k, TICK);
}

function adjustBots() {
  const all = [...players.values()];
  const humans = all.filter(p => !p.isBot).length;
  const bots = all.filter(p => p.isBot);
  // Rellena hasta TARGET_BOTS + 1 combatientes; sin humanos no hay bots.
  const want = humans === 0 ? 0 : S.clamp(TARGET_BOTS + 1 - humans, 0, TARGET_BOTS);
  while (bots.length < want) {
    const name = '🤖 ' + BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const b = makePlayer(name, true, null);
    players.set(b.id, b);
    bots.push(b);
    broadcast({ t: 'join', p: metaOf(b) });
  }
  while (bots.length > want) {
    const b = bots.pop();
    players.delete(b.id);
    broadcast({ t: 'leave', id: b.id });
  }
}

// ---------- Bucle de física (30 Hz) ----------

function tick() {
  const t = now();

  // Balas con subpasos para no atravesar jugadores entre ticks.
  const SUB = 4;
  const sdt = TICK / SUB;
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    let dead = t > b.diesAt;
    for (let s = 0; s < SUB && !dead; s++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      if (hitsWall(b.x, b.y, S.BULLET.radius)) { dead = true; break; }
      for (const p of players.values()) {
        if (p.dead || p.id === b.owner) continue;
        const rr = S.PLAYER.radius + S.BULLET.radius;
        const dx = p.x - b.x, dy = p.y - b.y;
        if (dx * dx + dy * dy <= rr * rr) {
          damage(p, b.owner);
          dead = true;
          break;
        }
      }
    }
    if (dead) bullets.splice(i, 1);
  }

  for (const p of players.values()) {
    if (p.dead) {
      if (t >= p.respawnAt) spawn(p);
    } else if (p.hp < S.PLAYER.maxHp && t - p.lastDamageAt > S.PLAYER.regenDelay) {
      p.hp = Math.min(S.PLAYER.maxHp, p.hp + S.PLAYER.regenRate * TICK);
    }
  }

  for (const p of players.values()) {
    if (p.isBot && !p.dead) botThink(p, t);
  }
}

// ---------- Snapshots (20 Hz) ----------

function broadcastState() {
  if (players.size === 0) return;
  const ps = [];
  for (const p of players.values()) {
    ps.push([p.id, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy),
      Math.round(p.angle * 1000) / 1000, Math.round(p.hp), p.score, p.dead ? 1 : 0]);
  }
  const bs = bullets.map(b => [b.id, r1(b.x), r1(b.y), b.owner]);
  const t = now();
  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    p.ws.send(JSON.stringify({ t: 'st', ts: t, ack: p.lastSeq, p: ps, b: bs }));
  }
}

// ---------- WebSocket ----------

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'join' && !player) {
      const humans = [...players.values()].filter(p => !p.isBot).length;
      if (humans >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'full' }));
        ws.close();
        return;
      }
      player = makePlayer(sanitizeName(msg.name), false, ws);
      players.set(player.id, player);
      ws.send(JSON.stringify({ t: 'init', id: player.id, players: [...players.values()].map(metaOf) }));
      broadcast({ t: 'join', p: metaOf(player) }, ws);
      adjustBots();
      console.log(`+ ${player.name} (#${player.id}) — ${players.size} en la arena`);
    } else if (msg.t === 'in' && player) {
      handleInputs(player, msg.l);
    } else if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
    }
  });

  ws.on('close', () => {
    if (!player) return;
    players.delete(player.id);
    broadcast({ t: 'leave', id: player.id });
    adjustBots();
    console.log(`- ${player.name} (#${player.id}) — ${players.size} en la arena`);
  });

  ws.on('error', () => {});
});

// Termina conexiones muertas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(tick, TICK * 1000);
setInterval(broadcastState, SNAPSHOT_MS);

httpServer.listen(PORT, () => {
  console.log(`NEON ARENA en marcha → http://localhost:${PORT}  (bots: ${TARGET_BOTS})`);
});
