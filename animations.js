/* =============================================================================
 * animations.js — PUZZLE CAM
 * -----------------------------------------------------------------------------
 * Motor de tweens y efectos sobre <canvas> que NO se resuelven con CSS.
 *
 * Rol de este archivo (según CONTRACT.md §3 y §9):
 *   - Efectos animados por canvas (no CSS): cuenta atrás, shatter/dibujo de
 *     rejilla, deslizamientos de scramble, anillo de "manos juntas", partículas
 *     de papeles/confeti, vuelo de la foto a la tira y crossfades de estado.
 *   - Expone funciones simples play/update que el bucle rAF (app.loop) invoca.
 *
 * Reglas de propiedad (CONTRACT.md §0):
 *   - `animations.js` es el ÚNICO escritor de `APP.fx`.
 *     APP.fx = { confetti:[], flash:0, completoT:0, crossfadeT:1 }
 *   - También puede escribir propiedades-objetivo (props de tween) en los
 *     objetos que se le pasan (p. ej. tiles del puzzle).
 *   - Lee CONFIG y APP.reducedMotion. NUNCA toca phase, hands, puzzle ni strip.
 *
 * Orden de carga (CONTRACT.md §1): config → state → camera → gestures →
 *   puzzle → animations → photostrip → app. Por eso `photostrip.js` puede
 *   llamar a `Anim.flyToStrip` (animations se carga antes).
 *
 * Idioma: comentarios en español para coincidir con el proyecto original.
 * Sin frameworks, sin bundler, sin módulos ES: se adjunta `window.Anim`.
 * ===========================================================================*/

(function () {
  'use strict';

  // Atajos a los objetos globales del contrato.
  var CONFIG = window.CONFIG;
  var APP = window.APP;

  // ---------------------------------------------------------------------------
  // Registro interno de tweens.
  // ---------------------------------------------------------------------------
  // Cada tween es un objeto:
  //   { id, target, props:{prop:{from,to}}, dur, easeName, delay,
  //     onUpdate, onDone, startAt, started, done }
  // El reloj es el `now` (performance.now) que `app.loop` pasa a `Anim.tick`.
  // No usamos setTimeout: TODO avanza dentro del único bucle rAF (CONTRACT §10).
  var _tweens = [];
  var _nextId = 1;

  // ===========================================================================
  // UTILIDADES NUMÉRICAS
  // ===========================================================================

  // Interpolación lineal simple.
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Constante de overshoot para el easing "backOut" (CONTRACT.md §4).
  var BACK_C1 = 1.70158;

  // Funciones de easing numéricas (no las cadenas CSS de CONFIG.EASES).
  // Nombres normativos: linear | outCubic | inCubic | inOutSine | backOut.
  function ease(name, t) {
    // Aseguramos el dominio 0..1 para evitar valores fuera de rango.
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    switch (name) {
      case 'linear':
        return t;
      case 'outCubic': {
        var inv = 1 - t;
        return 1 - inv * inv * inv;
      }
      case 'inCubic':
        return t * t * t;
      case 'inOutSine':
        return -(Math.cos(Math.PI * t) - 1) / 2;
      case 'backOut': {
        // Overshoot suave al final (efecto "muelle").
        var c3 = BACK_C1 + 1;
        var p = t - 1;
        return 1 + c3 * p * p * p + BACK_C1 * p * p;
      }
      default:
        // Por defecto, lineal: comportamiento predecible si llega un nombre raro.
        return t;
    }
  }

  // ===========================================================================
  // MOTOR DE TWEENS
  // ===========================================================================

  // Crea un tween y devuelve su id (para poder cancelarlo).
  // Firma exacta del contrato:
  //   Anim.tween({ target, props, dur, ease, delay=0, onUpdate, onDone })
  // - props: { propName: valorDestino }  ó  { propName: [from, to] }.
  //   Si solo se da el destino, el `from` se toma del valor actual de target.
  function tween(opts) {
    opts = opts || {};
    var target = opts.target || {};
    var rawProps = opts.props || {};
    var dur = typeof opts.dur === 'number' ? opts.dur : 0;
    var easeName = opts.ease || 'outCubic';
    var delay = typeof opts.delay === 'number' ? opts.delay : 0;

    // En movimiento reducido acortamos la duración de los tweens cosméticos
    // (mantenemos el feedback funcional gracias a que igual completan a `to`).
    // Los tweens marcados como funcionales (opts.functional === true) NO se
    // acortan: su duración forma parte del feedback (p. ej. el crossfade B/N o
    // el vuelo a la tira), tal como prometen sus comentarios.
    if (APP && APP.reducedMotion && opts.functional !== true) {
      dur = Math.min(dur, 120);
    }

    // Normalizamos los props: capturamos el `from` ahora (al crear el tween).
    var props = {};
    for (var key in rawProps) {
      if (!Object.prototype.hasOwnProperty.call(rawProps, key)) continue;
      var spec = rawProps[key];
      var from, to;
      if (Array.isArray(spec)) {
        from = spec[0];
        to = spec[1];
      } else {
        // El origen es el valor actual; si no existe, partimos de 0.
        from = typeof target[key] === 'number' ? target[key] : 0;
        to = spec;
      }
      props[key] = { from: from, to: to };
    }

    var t = {
      id: _nextId++,
      target: target,
      props: props,
      dur: dur,
      easeName: easeName,
      delay: delay,
      onUpdate: typeof opts.onUpdate === 'function' ? opts.onUpdate : null,
      onDone: typeof opts.onDone === 'function' ? opts.onDone : null,
      startAt: 0,       // se fija en el primer tick (cuando arranca, tras el delay)
      delayLeft: delay, // ms de retardo pendientes
      started: false,
      done: false
    };

    _tweens.push(t);

    // Duración cero (p. ej. CONFIG.DUR.drag === 0): aplicar destino al instante.
    // Lo dejamos para el siguiente tick para mantener un único punto de avance,
    // pero si no hay delay lo resolvemos en el primer tick igualmente.
    return t.id;
  }

  // Avanza un único tween con el `now` actual. Devuelve true si sigue vivo.
  function _stepTween(t, now) {
    if (t.done) return false;

    // Inicializamos el cronómetro en el primer tick que vemos este tween.
    if (!t.started) {
      t.started = true;
      t.startAt = now;
    }

    // Resolvemos el retardo antes de empezar a interpolar.
    var elapsed = now - t.startAt;
    if (elapsed < t.delayLeft) {
      return true; // todavía en el delay
    }
    var active = elapsed - t.delayLeft;

    // Progreso normalizado 0..1 (duración 0 => completa de inmediato).
    var p = t.dur > 0 ? active / t.dur : 1;
    if (p >= 1) p = 1;

    var e = ease(t.easeName, p);

    // Aplicamos la interpolación a cada propiedad objetivo.
    for (var key in t.props) {
      if (!Object.prototype.hasOwnProperty.call(t.props, key)) continue;
      var pr = t.props[key];
      t.target[key] = lerp(pr.from, pr.to, e);
    }

    if (t.onUpdate) t.onUpdate(p, t.target);

    if (p >= 1) {
      t.done = true;
      if (t.onDone) t.onDone(t.target);
      return false;
    }
    return true;
  }

  // Cancela un tween por id (no dispara onDone).
  function cancel(tweenId) {
    for (var i = 0; i < _tweens.length; i++) {
      if (_tweens[i].id === tweenId) {
        _tweens[i].done = true; // se purga en el próximo tick
        break;
      }
    }
  }

  // Cancela SOLO los tweens en vuelo (sin tocar APP.fx: confeti, flash, etc.).
  // Lo usa app.js antes de re-ajustar el tablero en un resize: si quedara un
  // tween de scramble/swap activo, sobrescribiría las nuevas posiciones con
  // coordenadas del tamaño anterior. A diferencia de clear(), preserva el confeti
  // (importante en SOLVED) y el resto de efectos de APP.fx.
  function clearTweens() {
    _tweens.length = 0;
  }

  // Limpia TODOS los tweens y las partículas. Útil entre rondas / reinicio.
  function clear() {
    _tweens.length = 0;
    if (APP && APP.fx) {
      APP.fx.confetti.length = 0;
      APP.fx.flash = 0;
      APP.fx.completoT = 0;
      APP.fx.crossfadeT = 1;
    }
  }

  // ===========================================================================
  // TICK GLOBAL — un único avance por frame (lo llama app.loop)
  // ===========================================================================
  // Avanza: (1) todos los tweens, (2) las partículas de confeti, (3) la cuenta
  // atrás (de forma implícita: drawCountdown usa APP.countdown ya actualizado
  // por app; aquí solo gestionamos lo que vive en APP.fx y en los tweens).
  function tick(now) {
    // 1) Tweens: avanzar y purgar los terminados/cancelados.
    if (_tweens.length) {
      var alive = [];
      for (var i = 0; i < _tweens.length; i++) {
        var t = _tweens[i];
        var keep = _stepTween(t, now);
        if (keep && !t.done) alive.push(t);
      }
      _tweens = alive;
    }

    // 2) Partículas de confeti: avanzar su física (paso fijo aproximado).
    //    El dibujado real lo hace drawConfetti; aquí integramos posiciones para
    //    que el estado viva en APP.fx y el bucle pueda preguntarlo.
    _stepConfetti(now);

    // 3) Flash de captura (efecto canvas opcional, §6 #6): decae solo si está
    //    activo. La versión CSS (.flash--fire) es la principal; esta es de apoyo.
    if (APP.fx.flash > 0) {
      // Decaimiento suave por frame; el flash dura del orden de DUR.flash.
      APP.fx.flash = Math.max(0, APP.fx.flash - 0.06);
    }
  }

  // ===========================================================================
  // §6 #4 — ANILLO DE "MANOS JUNTAS" (HANDS-JOINED RING FILL)
  // ===========================================================================
  // Dibuja un anillo de progreso circular alrededor del punto de unión.
  // progress01 ∈ [0,1]; al llegar a 1 se dispara la cuenta atrás (lo decide app).
  function drawJoinRing(ctx, cx, cy, progress01) {
    if (!ctx) return;
    var p = Math.max(0, Math.min(1, progress01 || 0));

    var radius = 54;           // radio del anillo en píxeles de stage
    var lineW = 8;
    var start = -Math.PI / 2;  // arranca arriba (12 en punto)
    var end = start + Math.PI * 2 * p;

    ctx.save();

    // Pista de fondo tenue para que el anillo se lea sobre cualquier imagen.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = lineW;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.stroke();

    // Arco de progreso con brillo cian (color de marca).
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end);
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.strokeStyle = CONFIG.COLORS.glowCyan;
    ctx.shadowColor = CONFIG.COLORS.glowCyan;
    ctx.shadowBlur = 16;
    ctx.stroke();

    // Punto guía en el centro (marca el join point).
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = CONFIG.COLORS.glowCyan;
    ctx.fill();

    ctx.restore();
  }

  // ===========================================================================
  // §6 #5 — NÚMEROS DE CUENTA ATRÁS (COUNTDOWN)
  // ===========================================================================
  // Cada número (3,2,1): zoom-in 0.3→1 con fade-in (~0.25s), mantiene, y luego
  // zoom-out 1→1.6 con fade-out (~0.25s). Centrado, con sombra suave y un fino
  // anillo de barrido por segundo. `tickElapsed` = ms desde que empezó el tick.
  function drawCountdown(ctx, value, tickElapsed) {
    if (!ctx || !value) return;

    var W = ctx.canvas.width;
    var H = ctx.canvas.height;
    var cx = W / 2;
    var cy = H / 2;

    var tickDur = CONFIG.DUR.countdownTick; // 1000ms por número
    var te = Math.max(0, Math.min(tickDur, tickElapsed || 0));

    // Tres fases dentro del tick: in (0.25s) · hold (0.5s) · out (0.25s).
    var inMs = tickDur * 0.25;
    var outMs = tickDur * 0.25;
    var outStart = tickDur - outMs;

    var scale, alpha;
    if (te < inMs) {
      // Zoom-in con fade-in.
      var ti = ease('outCubic', te / inMs);
      scale = lerp(0.3, 1, ti);
      alpha = ti;
    } else if (te < outStart) {
      // Mantener.
      scale = 1;
      alpha = 1;
    } else {
      // Zoom-out con fade-out.
      var to = ease('inCubic', (te - outStart) / outMs);
      scale = lerp(1, 1.6, to);
      alpha = 1 - to;
    }

    // En movimiento reducido evitamos el zoom dramático (legibilidad), pero
    // mantenemos el número visible: feedback funcional intacto.
    if (APP && APP.reducedMotion) {
      scale = 1;
      alpha = te < outStart ? 1 : Math.max(0, 1 - (te - outStart) / outMs);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    // Anillo fino de barrido del segundo en curso (opcional, §6 #5).
    var sweep = ease('linear', te / tickDur);
    ctx.beginPath();
    ctx.arc(0, 0, 150, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sweep);
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();

    // Número grande centrado con sombra suave.
    ctx.font = CONFIG.FONT_COUNTDOWN; // '900 220px Inter, sans-serif'
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(value), 0, 0);

    ctx.restore();
  }

  // ===========================================================================
  // §6 #7 — SHATTER / SPLIT-IN
  // ===========================================================================
  // El motor de animaciones expone el "shatter" como un tween de progreso 0→1
  // sobre APP.puzzle (propiedad efímera `shatterT`) que puzzle.js consulta para
  // dibujar las líneas de rejilla y los huecos de los tiles entrando. Aquí solo
  // movemos el reloj; el dibujo de la imagen/rejilla es de puzzle.js.
  // Lo invoca Puzzle.shatterIn(onDone).
  function shatter(onDone) {
    // Garantizamos el campo de progreso sobre el objeto puzzle (sin "poseerlo":
    // es una prop-objetivo de tween, permitida por el contrato).
    var pz = APP.puzzle;
    pz.shatterT = 0;

    tween({
      target: pz,
      props: { shatterT: [0, 1] },
      dur: CONFIG.DUR.shatter, // 400ms
      ease: 'outCubic',
      onDone: function () {
        pz.shatterT = 1;
        if (typeof onDone === 'function') onDone();
      }
    });
  }

  // ===========================================================================
  // §6 #8 — SCRAMBLE (deslizamientos escalonados)
  // ===========================================================================
  // Cada tile se desliza desde su posición actual (renderX/renderY) hasta el
  // centro de su nueva celda, con stagger. puzzle.js ya colocó order[]/cell y
  // fijó renderX/renderY destino en `targetX/targetY` de cada tile.
  function scramble(tiles) {
    if (!tiles || !tiles.length) return;
    var dur = CONFIG.DUR.scramble;          // 350ms
    var stagger = CONFIG.DUR.scrambleStagger; // 30ms

    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      // El destino lo deja puzzle.js en targetX/targetY (centro de la celda).
      var tx = typeof tile.targetX === 'number' ? tile.targetX : tile.renderX;
      var ty = typeof tile.targetY === 'number' ? tile.targetY : tile.renderY;

      tween({
        target: tile,
        props: { renderX: tx, renderY: ty },
        dur: dur,
        delay: i * stagger, // efecto escalonado
        ease: 'outCubic'
      });
    }
  }

  // ===========================================================================
  // §6 #9 — HOVER / RESALTE DE OBJETIVO
  // ===========================================================================
  // Al pasar el cursor de pinza sobre un tile: escala 1.05 + glow suave.
  function setHover(tile, on) {
    if (!tile) return;
    tile.hovered = !!on;
    // Animamos la escala salvo que el tile esté agarrado (la dicta grab/drag).
    if (tile.lifted) return;
    tween({
      target: tile,
      props: { scale: on ? 1.05 : 1.0 },
      dur: CONFIG.DUR.hover, // 150ms
      ease: 'outCubic'
    });
  }

  // ===========================================================================
  // §6 #10 — GRAB (agarrar tile)
  // ===========================================================================
  // En pinch-down: el tile sube (escala 1.08), sombra elevada, z arriba, opacidad 0.95.
  function grab(tile) {
    if (!tile) return;
    tile.lifted = true;
    tween({
      target: tile,
      props: { scale: 1.08, opacity: 0.95 },
      dur: CONFIG.DUR.grab, // 120ms
      ease: 'backOut'
    });
  }

  // ===========================================================================
  // §6 #12 — SWAP / SNAP (intercambio al soltar)
  // ===========================================================================
  // El tile agarrado y el de la celda destino se deslizan para intercambiar
  // celdas (ease-out ~0.25s) y encajan en la rejilla. puzzle.js ya actualizó
  // order[] y dejó los destinos en targetX/targetY de cada tile.
  function swap(tileA, tileB, onDone) {
    var pending = 0;
    var fired = false;
    function done() {
      if (fired) return;
      fired = true;
      if (typeof onDone === 'function') onDone();
    }

    function slide(tile, restoreScale) {
      if (!tile) return;
      pending++;
      var tx = typeof tile.targetX === 'number' ? tile.targetX : tile.renderX;
      var ty = typeof tile.targetY === 'number' ? tile.targetY : tile.renderY;
      tween({
        target: tile,
        props: {
          renderX: tx,
          renderY: ty,
          scale: restoreScale ? 1.0 : tile.scale,
          opacity: 1.0
        },
        dur: CONFIG.DUR.swap, // 250ms
        ease: 'outCubic',
        onDone: function () {
          tile.lifted = false;
          pending--;
          if (pending <= 0) done();
        }
      });
    }

    slide(tileA, true);
    slide(tileB, false);

    // Si por algún motivo no había nada que animar, completamos igualmente.
    if (pending === 0) done();
  }

  // ===========================================================================
  // §6 #13 — FEEDBACK DE CELDA CORRECTA
  // ===========================================================================
  // Cuando un tile cae en su celda correcta: breve pulso de borde verde + glow
  // (~0.4s) y luego se asienta. Usamos `correctPulseT` (1→0) que puzzle.js lee
  // para pintar el borde/glow proporcional.
  function correctPulse(tile) {
    if (!tile) return;
    tile.correctPulseT = 1;
    tween({
      target: tile,
      props: { correctPulseT: [1, 0] },
      dur: CONFIG.DUR.correct, // 400ms
      ease: 'outCubic',
      onDone: function () {
        tile.correctPulseT = 0;
      }
    });
  }

  // ===========================================================================
  // §6 #14 — NUDGE / SPRING-BACK (drop ilegal)
  // ===========================================================================
  // Movimiento ilegal (fuera del tablero): el tile vuelve a su origen con un
  // pequeño overshoot (ease-back ~0.3s).
  function nudgeBack(tile, originX, originY) {
    if (!tile) return;
    tween({
      target: tile,
      props: {
        renderX: originX,
        renderY: originY,
        scale: 1.0,
        opacity: 1.0
      },
      dur: CONFIG.DUR.nudge, // 300ms
      ease: 'backOut',
      onDone: function () {
        tile.lifted = false;
      }
    });
  }

  // ===========================================================================
  // §6 #15 — SOLVE REVEAL
  // ===========================================================================
  // Al completar: las líneas/huecos de la rejilla se desvanecen (~0.3s) para
  // que la cara vuelva a ser entera, y un pulso de escala del tablero 1→1.03→1.
  // Usamos APP.puzzle.revealT (1→0: cantidad de "hueco" restante) y
  // APP.puzzle.boardPulse (escala extra del tablero). Lo invoca
  // Puzzle.revealSolved(onDone).
  function solveReveal(onDone) {
    var pz = APP.puzzle;
    pz.revealT = 1;        // 1 = rejilla visible, 0 = imagen entera
    pz.boardPulse = 1;     // escala del tablero

    // Desvanecer huecos/líneas.
    tween({
      target: pz,
      props: { revealT: [1, 0] },
      dur: CONFIG.DUR.solveGap, // 300ms
      ease: 'inOutSine',
      onDone: function () {
        pz.revealT = 0;
        if (typeof onDone === 'function') onDone();
      }
    });

    // Pulso de escala 1→1.03 y vuelta a 1 (dos tramos).
    tween({
      target: pz,
      props: { boardPulse: [1, 1.03] },
      dur: CONFIG.DUR.solvePulse / 2, // 125ms
      ease: 'outCubic',
      onDone: function () {
        tween({
          target: pz,
          props: { boardPulse: [1.03, 1] },
          dur: CONFIG.DUR.solvePulse / 2,
          ease: 'inOutSine',
          onDone: function () { pz.boardPulse = 1; }
        });
      }
    });
  }

  // ===========================================================================
  // §6 #17 — PAPELES CAYENDO / CONFETI
  // ===========================================================================
  // Partículas (pequeños rectángulos blancos/crema tipo fotos + confeti de
  // color) caen desde arriba con x, rotación y velocidad aleatorias, se atenúan
  // al llegar abajo; dura ~1.5–2s. Early-return si reducedMotion.
  var _confettiPalette = [
    '#ffffff', '#fff3d6', '#ffe9b0', // cremas / blancos tipo foto
    '#00fff7', '#ffcf40', '#1f8b3a'  // toques de color de marca
  ];

  function spawnConfetti() {
    // §6 #27: en movimiento reducido NO generamos confeti (cosmético).
    if (APP && APP.reducedMotion) return;

    var count = CONFIG.CONFETTI_COUNT; // 80
    var arr = APP.fx.confetti;
    arr.length = 0; // reiniciamos la tanda

    // Suponemos un ancho de referencia (CAMERA_W) para repartir x; drawConfetti
    // reescala a las dimensiones reales del canvas al pintar.
    var spawnW = CONFIG.CAMERA_W;

    for (var i = 0; i < count; i++) {
      arr.push({
        x: Math.random() * spawnW,         // posición horizontal (espacio cámara)
        y: -Math.random() * 120 - 10,      // arranca por encima del borde
        vx: (Math.random() - 0.5) * 0.6,   // deriva horizontal (px/ms)
        vy: 0.12 + Math.random() * 0.18,   // caída (px/ms)
        rot: Math.random() * Math.PI * 2,  // rotación inicial
        vr: (Math.random() - 0.5) * 0.01,  // velocidad angular (rad/ms)
        w: 8 + Math.random() * 10,         // ancho del rectángulo
        h: 10 + Math.random() * 14,        // alto del rectángulo
        color: _confettiPalette[(Math.random() * _confettiPalette.length) | 0],
        life: 0,                           // ms vividos
        maxLife: CONFIG.DUR.confetti * (0.7 + Math.random() * 0.5),
        born: 0                            // se fija en el primer paso
      });
    }
  }

  // Integración física de las partículas (la llama tick()). Reloj en `now`.
  var _lastConfettiNow = 0;
  function _stepConfetti(now) {
    var arr = APP.fx.confetti;
    if (!arr.length) {
      _lastConfettiNow = now;
      return;
    }
    // dt acotado para evitar saltos si el frame se atrasa.
    var dt = _lastConfettiNow ? Math.min(48, now - _lastConfettiNow) : 16;
    _lastConfettiNow = now;
    if (dt < 0) dt = 16;

    var spawnW = CONFIG.CAMERA_W;
    var spawnH = CONFIG.CAMERA_H;
    var alive = 0;

    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      p.vy += 0.00012 * dt;         // gravedad muy suave
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life += dt;

      // Rebote suave en los laterales del espacio de referencia.
      if (p.x < -20) p.x = spawnW + 20;
      else if (p.x > spawnW + 20) p.x = -20;

      // Marcamos como muertas las que agotan vida o salen muy abajo.
      if (p.life >= p.maxLife || p.y > spawnH + 60) {
        p.dead = true;
      } else {
        alive++;
      }
    }

    // Purga cuando ya no queda ninguna viva (mantenemos array estable mientras vivan).
    if (alive === 0) {
      arr.length = 0;
    }
  }

  // Dibuja el confeti escalando del espacio de referencia al canvas real.
  // Devuelve true mientras haya partículas vivas (lo usa el bucle para decidir
  // si seguir pintando la capa de SOLVED).
  function drawConfetti(ctx, now) {
    var arr = APP.fx.confetti;
    if (!arr.length) return false;

    var sx = ctx.canvas.width / CONFIG.CAMERA_W;
    var sy = ctx.canvas.height / CONFIG.CAMERA_H;
    var anyAlive = false;

    ctx.save();
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (p.dead) continue;
      anyAlive = true;

      // Atenuación cerca del final de la vida.
      var fade = 1;
      var fadeFrom = p.maxLife * 0.7;
      if (p.life > fadeFrom) {
        fade = 1 - (p.life - fadeFrom) / (p.maxLife - fadeFrom);
        if (fade < 0) fade = 0;
      }

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x * sx, p.y * sy);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      // Rectángulo tipo "papelito de foto".
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.restore();

    return anyAlive;
  }

  // ===========================================================================
  // §6 #18 — CONVERSIÓN A B&N (crossfade color → grises)
  // ===========================================================================
  // La foto en color resuelta hace crossfade a escala de grises (~0.4s) antes
  // de entrar en la tira. Usamos APP.fx.crossfadeT (1→0) que el dibujante puede
  // leer; aquí ofrecemos además un dibujado autónomo por si app lo prefiere.
  // grayCanvas lo provee PhotoStrip.toGrayscale.
  function bwCrossfade(srcCanvas, grayCanvas, onDone) {
    APP.fx.crossfadeT = 1; // 1 = totalmente color, 0 = totalmente gris

    var dur = CONFIG.DUR.bw; // 400ms — funcional: NO se acorta en reducedMotion

    tween({
      target: APP.fx,
      props: { crossfadeT: [1, 0] },
      dur: dur,
      ease: 'inOutSine',
      functional: true, // su duración es feedback funcional; no clamp en reducedMotion
      onDone: function () {
        APP.fx.crossfadeT = 0;
        if (typeof onDone === 'function') onDone();
      }
    });
  }

  // Dibuja el crossfade color→gris en un destino dado (helper opcional).
  // alpha = APP.fx.crossfadeT (1 color · 0 gris).
  function drawBwCrossfade(ctx, srcCanvas, grayCanvas, x, y, w, h) {
    if (!ctx) return;
    var a = APP.fx.crossfadeT;
    if (a < 0) a = 0;
    if (a > 1) a = 1;

    ctx.save();
    // Base en grises.
    if (grayCanvas) ctx.drawImage(grayCanvas, x, y, w, h);
    // Capa de color por encima con opacidad descendente.
    if (srcCanvas && a > 0) {
      ctx.globalAlpha = a;
      ctx.drawImage(srcCanvas, x, y, w, h);
    }
    ctx.restore();
  }

  // ===========================================================================
  // §6 #19 — VUELO DE LA FOTO A LA TIRA (PHOTO-FLY-TO-STRIP)
  // ===========================================================================
  // Una miniatura de la foto B&N viaja del stage a su slot destino: translate +
  // scale-down siguiendo una trayectoria suavizada (~0.6s); al terminar, app
  // rellena el slot (placeholder → foto) con un pequeño bounce (CSS #20).
  //
  // Implementación: creamos un <img>/canvas flotante en el DOM (position:fixed)
  // y lo animamos con un tween manual sobre coords de PANTALLA (fromRect/toRect
  // son DOMRect de viewport). No usamos el canvas porque el destino vive en el
  // rail (fuera del <canvas> del stage). Esto cumple "vuelo a la tira" sin tocar
  // estado ajeno: el elemento es efímero y se autodestruye.
  function flyToStrip(thumbCanvas, fromRect, toRect, onDone) {
    function finish() {
      if (typeof onDone === 'function') onDone();
    }

    // Salvaguarda: si faltan datos, completamos para no bloquear la máquina.
    if (!thumbCanvas || !fromRect || !toRect || typeof document === 'undefined') {
      finish();
      return;
    }

    // Elemento volador: clon visual de la miniatura B&N.
    var flyer = document.createElement('canvas');
    flyer.width = thumbCanvas.width;
    flyer.height = thumbCanvas.height;
    var fctx = flyer.getContext('2d');
    fctx.drawImage(thumbCanvas, 0, 0);

    // Estilo fijo en coords de viewport.
    var fromW = fromRect.width;
    var fromH = fromRect.height;
    flyer.style.position = 'fixed';
    flyer.style.left = '0';
    flyer.style.top = '0';
    flyer.style.margin = '0';
    flyer.style.zIndex = '9999';
    flyer.style.pointerEvents = 'none';
    flyer.style.borderRadius = '6px';
    flyer.style.boxShadow = '0 10px 30px rgba(0,0,0,0.45)';
    flyer.style.width = fromW + 'px';
    flyer.style.height = fromH + 'px';
    document.body.appendChild(flyer);

    // Estado de animación (objeto-objetivo del tween).
    var anim = {
      x: fromRect.left,
      y: fromRect.top,
      w: fromW,
      h: fromH
    };

    function applyTransform() {
      flyer.style.transform =
        'translate(' + anim.x + 'px,' + anim.y + 'px)';
      flyer.style.width = anim.w + 'px';
      flyer.style.height = anim.h + 'px';
    }
    applyTransform();

    var dur = CONFIG.DUR.fly; // 600ms — funcional, no se acorta por reducedMotion

    tween({
      target: anim,
      props: {
        x: toRect.left,
        y: toRect.top,
        w: toRect.width,
        h: toRect.height
      },
      dur: dur,
      ease: 'inOutSine', // trayectoria suave de entrada y salida
      functional: true,  // el vuelo es feedback funcional; no clamp en reducedMotion
      onUpdate: applyTransform,
      onDone: function () {
        // Retiramos el elemento volador y avisamos a app.
        if (flyer && flyer.parentNode) {
          flyer.parentNode.removeChild(flyer);
        }
        finish();
      }
    });
  }

  // ===========================================================================
  // §6 #6 — FLASH DE CAPTURA (lado canvas, opcional)
  // ===========================================================================
  // Rectángulo blanco a pantalla completa. La versión principal es CSS
  // (.flash--fire), pero ofrecemos el dibujado canvas por si se quiere reforzar.
  // `t` ∈ [0,1] es la intensidad (1 = blanco pleno).
  function flash(ctx, t) {
    if (!ctx) return;
    var a = typeof t === 'number' ? t : APP.fx.flash;
    if (a <= 0) return;
    if (a > 1) a = 1;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }

  // Marca de estilo de esqueleto (el dibujo real vive en Gestures.drawSkeleton).
  // Se mantiene por compatibilidad con la firma del contrato (no-op aquí).
  function drawSkeletonStyle() { /* el esqueleto lo dibuja Gestures.drawSkeleton */ }

  // ===========================================================================
  // AYUDANTES DE CLASES DOM (el CSS posee los @keyframes; aquí solo togglamos)
  // ===========================================================================

  // §6 #2 — Pulso del badge de estado. badge--on / badge--off según haya manos.
  // Se llama CADA frame desde app.loop; con un guardado del último estado evitamos
  // tocar el DOM (classList) cuando no hay cambio — menos trabajo por frame.
  var _lastBadgeOn = null;
  function badgePulse(badgeEl, hasHands) {
    if (!badgeEl) return;
    var on = !!hasHands;
    if (on === _lastBadgeOn) return;   // sin cambio de estado -> no tocamos el DOM
    _lastBadgeOn = on;
    if (on) {
      badgeEl.classList.add('badge--on');
      badgeEl.classList.remove('badge--off');
    } else {
      badgeEl.classList.add('badge--off');
      badgeEl.classList.remove('badge--on');
    }
    // El pulso del punto (escala 1→1.25→1) y el fundido de fondo los anima el
    // CSS (@keyframes badge-dot-pulse) al estar la clase badge--on activa.
  }

  // §6 #3 — Prompt de idle "respirando" (opacidad/escala). Solo togglamos la clase.
  function idlePrompt(promptEl, on) {
    if (!promptEl) return;
    if (on) {
      promptEl.classList.remove('is-hidden');
      promptEl.classList.add('prompt--idle'); // @keyframes prompt-breathe (CSS)
    } else {
      promptEl.classList.add('is-hidden');
    }
  }

  // §6 #16 — "¡COMPLETO!" pop (CSS @keyframes complete-pop). Togglamos complete--show.
  function completo(el, show) {
    if (!el) return;
    if (show) {
      el.classList.add('complete--show');
      // Marca de progreso por si el dibujante canvas quisiera acompañar (no usado).
      APP.fx.completoT = 1;
    } else {
      el.classList.remove('complete--show');
      APP.fx.completoT = 0;
    }
  }

  // §6 #21 — Banner "TIRA COMPLETA" (CSS @keyframes banner-in).
  function banner(bannerEl, show) {
    if (!bannerEl) return;
    if (show) bannerEl.classList.add('banner--show');
    else bannerEl.classList.remove('banner--show');
  }

  // §6 #22 — Aparición de botones (CSS @keyframes btn-rise + stagger por CSS).
  function revealButtons(controlsEl, show) {
    if (!controlsEl) return;
    if (show) controlsEl.classList.add('controls--show');
    else controlsEl.classList.remove('controls--show');
  }

  // §6 #23 — Pulso del botón Descargar (CSS @keyframes download-pulse).
  function downloadPulse(btnEl, on) {
    if (!btnEl) return;
    if (on) btnEl.classList.add('btn--pulse');
    else btnEl.classList.remove('btn--pulse');
  }

  // §6 #26 — Spinner de carga (CSS @keyframes loader-spin). Mostramos/ocultamos #loader.
  function spinner(loaderEl, on) {
    if (!loaderEl) return;
    // Usamos is-hidden para el fundido (overlay > * transition .2s, §3 item 25).
    if (on) {
      loaderEl.classList.remove('is-hidden');
      loaderEl.style.display = '';
    } else {
      loaderEl.classList.add('is-hidden');
    }
  }

  // ===========================================================================
  // §6 #27 — MOVIMIENTO REDUCIDO
  // ===========================================================================
  // Fija APP.reducedMotion y añade/quita body.reduced-motion. El resto del
  // código lee APP.reducedMotion (NO la constante congelada CONFIG.REDUCED_MOTION).
  function applyReducedMotion(prefers) {
    var on = !!prefers;
    if (APP) APP.reducedMotion = on;
    if (typeof document !== 'undefined' && document.body) {
      if (on) document.body.classList.add('reduced-motion');
      else document.body.classList.remove('reduced-motion');
    }
  }

  // ===========================================================================
  // EXPORTACIÓN DEL NAMESPACE — window.Anim
  // ===========================================================================
  window.Anim = {
    // motor de tweens
    tween: tween,
    tick: tick,
    cancel: cancel,
    clear: clear,
    clearTweens: clearTweens,
    lerp: lerp,
    ease: ease,

    // fábricas / dibujado en canvas
    drawSkeletonStyle: drawSkeletonStyle,
    drawJoinRing: drawJoinRing,         // §6 #4
    drawCountdown: drawCountdown,       // §6 #5
    shatter: shatter,                   // §6 #7
    scramble: scramble,                 // §6 #8
    setHover: setHover,                 // §6 #9
    grab: grab,                         // §6 #10
    swap: swap,                         // §6 #12
    correctPulse: correctPulse,         // §6 #13
    nudgeBack: nudgeBack,               // §6 #14
    solveReveal: solveReveal,           // §6 #15
    spawnConfetti: spawnConfetti,       // §6 #17
    drawConfetti: drawConfetti,         // §6 #17
    bwCrossfade: bwCrossfade,           // §6 #18
    drawBwCrossfade: drawBwCrossfade,   // §6 #18 (helper de dibujo)
    flyToStrip: flyToStrip,             // §6 #19
    flash: flash,                       // §6 #6 (lado canvas)

    // ayudantes de clases DOM (CSS posee los @keyframes)
    badgePulse: badgePulse,             // §6 #2
    idlePrompt: idlePrompt,             // §6 #3
    completo: completo,                 // §6 #16
    banner: banner,                     // §6 #21
    revealButtons: revealButtons,       // §6 #22
    downloadPulse: downloadPulse,       // §6 #23
    spinner: spinner,                   // §6 #26
    applyReducedMotion: applyReducedMotion // §6 #27
  };
})();
