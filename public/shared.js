/*
 * Código compartido entre servidor y cliente: constantes del juego y la
 * simulación de movimiento. Al usar exactamente las mismas funciones en ambos
 * lados, la predicción local del cliente coincide con el servidor autoritativo.
 */
(function (exports) {
  'use strict';

  exports.WORLD = { w: 2400, h: 1600 };

  exports.PLAYER = {
    radius: 22,
    accel: 2800,        // aceleración (px/s²)
    friction: 7,        // amortiguación exponencial por segundo
    maxSpeed: 380,      // velocidad máxima (px/s)
    maxHp: 100,
    regenDelay: 4,      // s sin recibir daño para empezar a regenerar
    regenRate: 14,      // hp/s de regeneración
    respawnTime: 3      // s hasta reaparecer
  };

  exports.BULLET = {
    radius: 5,
    speed: 950,         // px/s
    damage: 20,
    cooldown: 0.19,     // s entre disparos
    lifetime: 1.1       // s de vida máxima
  };

  // Muros del mapa (rectángulos { x, y, w, h }); los 4 primeros son los bordes.
  var W = exports.WORLD.w, H = exports.WORLD.h, B = 40;
  exports.WALLS = [
    { x: 0, y: 0, w: W, h: B },
    { x: 0, y: H - B, w: W, h: B },
    { x: 0, y: 0, w: B, h: H },
    { x: W - B, y: 0, w: B, h: H },
    { x: 1100, y: 690, w: 200, h: 220 },
    { x: 500, y: 260, w: 340, h: 70 },
    { x: 1560, y: 260, w: 340, h: 70 },
    { x: 500, y: 1270, w: 340, h: 70 },
    { x: 1560, y: 1270, w: 340, h: 70 },
    { x: 320, y: 650, w: 70, h: 300 },
    { x: 2010, y: 650, w: 70, h: 300 }
  ];

  exports.SPAWNS = [
    { x: 160, y: 160 }, { x: 2240, y: 160 },
    { x: 160, y: 1440 }, { x: 2240, y: 1440 },
    { x: 1200, y: 150 }, { x: 1200, y: 1450 },
    { x: 150, y: 800 }, { x: 2250, y: 800 }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  exports.clamp = clamp;

  // Empuja un círculo (jugador) fuera de un muro rectangular.
  function resolveCircleRect(p, r, rect) {
    var cx = clamp(p.x, rect.x, rect.x + rect.w);
    var cy = clamp(p.y, rect.y, rect.y + rect.h);
    var dx = p.x - cx, dy = p.y - cy;
    var d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    if (d2 > 1e-9) {
      var d = Math.sqrt(d2);
      var nx = dx / d, ny = dy / d;
      p.x = cx + nx * r;
      p.y = cy + ny * r;
      var vn = p.vx * nx + p.vy * ny;
      if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
    } else {
      // Centro dentro del muro: salir por el lado más cercano.
      var left = p.x - rect.x, right = rect.x + rect.w - p.x;
      var top = p.y - rect.y, bottom = rect.y + rect.h - p.y;
      var m = Math.min(left, right, top, bottom);
      if (m === left) { p.x = rect.x - r; if (p.vx > 0) p.vx = 0; }
      else if (m === right) { p.x = rect.x + rect.w + r; if (p.vx < 0) p.vx = 0; }
      else if (m === top) { p.y = rect.y - r; if (p.vy > 0) p.vy = 0; }
      else { p.y = rect.y + rect.h + r; if (p.vy < 0) p.vy = 0; }
    }
  }

  exports.collideWorld = function (p, r) {
    for (var i = 0; i < exports.WALLS.length; i++) resolveCircleRect(p, r, exports.WALLS[i]);
    p.x = clamp(p.x, r, exports.WORLD.w - r);
    p.y = clamp(p.y, r, exports.WORLD.h - r);
  };

  /*
   * Aplica un paso de input a un estado { x, y, vx, vy }.
   * k es una máscara de bits: 1 izquierda, 2 derecha, 4 arriba, 8 abajo.
   * Determinista para un mismo (k, dt): sirve para predicción y reconciliación.
   */
  exports.applyInput = function (p, k, dt) {
    var P = exports.PLAYER;
    var ax = ((k & 2) ? 1 : 0) - ((k & 1) ? 1 : 0);
    var ay = ((k & 8) ? 1 : 0) - ((k & 4) ? 1 : 0);
    if (ax !== 0 && ay !== 0) { ax *= Math.SQRT1_2; ay *= Math.SQRT1_2; }
    p.vx += ax * P.accel * dt;
    p.vy += ay * P.accel * dt;
    var damp = Math.exp(-P.friction * dt);
    p.vx *= damp;
    p.vy *= damp;
    var sp = Math.hypot(p.vx, p.vy);
    if (sp > P.maxSpeed) { p.vx *= P.maxSpeed / sp; p.vy *= P.maxSpeed / sp; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    exports.collideWorld(p, P.radius);
  };

  // Recorte de Liang-Barsky: ¿el segmento cruza el rectángulo?
  exports.segIntersectsRect = function (x1, y1, x2, y2, rect) {
    var dx = x2 - x1, dy = y2 - y1;
    var t0 = 0, t1 = 1;
    var p = [-dx, dx, -dy, dy];
    var q = [x1 - rect.x, rect.x + rect.w - x1, y1 - rect.y, rect.y + rect.h - y1];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return true;
  };

  // Línea de visión entre dos puntos (ignora los muros del borde).
  exports.hasLineOfSight = function (x1, y1, x2, y2) {
    for (var i = 4; i < exports.WALLS.length; i++) {
      if (exports.segIntersectsRect(x1, y1, x2, y2, exports.WALLS[i])) return false;
    }
    return true;
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.SHARED = {}));
