/* =============================================================================
 * gestures.js — Detección de gestos a partir de los landmarks de MediaPipe Hands
 * -----------------------------------------------------------------------------
 * Rol (según CONTRACT.md §8 y §9):
 *   - Consume los resultados por fotograma de MediaPipe + CONFIG.
 *   - Es el ÚNICO escritor de APP.hands (count, raw, joined, joinPoint, pinch).
 *   - Detecta: manos juntas (join), pinza (down/hold/up) y calcula la posición
 *     del cursor de pinza YA des-espejada en píxeles del lienzo del escenario.
 *   - Aplica debounce (CONFIG.DEBOUNCE_FRAMES) a los gestos booleanos y marca
 *     pinch.justDown / pinch.justUp durante EXACTAMENTE un fotograma en el flanco.
 *
 * Convenciones (CONTRACT.md §0 §8):
 *   - Un solo espacio de coordenadas: píxeles internos del lienzo #fx-canvas.
 *   - El des-espejado (x' = 1 - x) se aplica UNA sola vez, dentro de toStage().
 *   - NUNCA cambia la fase: las hojas solo leen el estado con State.is(...).
 *
 * Expone el namespace global window.Gestures. No usa módulos ES, sin bundler.
 * Globales de MediaPipe usadas aquí: HAND_CONNECTIONS, drawConnectors, drawLandmarks.
 * ========================================================================== */

(function (window) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Índices de landmarks de MediaPipe Hands que nos interesan (0..20).
  // ---------------------------------------------------------------------------
  var WRIST = 0;        // muñeca (para distancia entre manos y punto de unión)
  var THUMB_TIP = 4;    // punta del pulgar (para la pinza)
  var INDEX_TIP = 8;    // punta del índice (para la pinza)

  // ---------------------------------------------------------------------------
  // Tamaño REAL del fotograma de la cámara (px). Es la fuente de verdad para la
  // transformación "cover" de toStage(). Antes se usaba CONFIG.CAMERA_W/H fijo
  // (640x480 = 4:3), lo que DESALINEABA el cursor y el esqueleto en cualquier
  // webcam que no fuese 4:3 (la mayoría de portátiles entregan 16:9, p. ej.
  // 1280x720). Lo que importa para "cover" es la RELACIÓN de aspecto, así que
  // medimos el frame real en process() (results.image) y lo usamos aquí.
  // Arranca con los valores de CONFIG hasta el primer fotograma; en SIM_MODE no
  // hay results.image, por lo que se mantiene en CONFIG (coincide con el inverso
  // que usa simulation.js).
  var srcW = (window.CONFIG && CONFIG.CAMERA_W) ? CONFIG.CAMERA_W : 640;
  var srcH = (window.CONFIG && CONFIG.CAMERA_H) ? CONFIG.CAMERA_H : 480;

  // ---------------------------------------------------------------------------
  // Estado interno de debounce (privado del módulo).
  //   - joinCounter / pinchCounter cuentan fotogramas CONSECUTIVOS en los que la
  //     condición instantánea difiere del estado estable ya confirmado.
  //   - Cuando el contador alcanza CONFIG.DEBOUNCE_FRAMES, el estado estable se
  //     invierte y el contador se reinicia.
  //   - cursorInit indica si ya tenemos una posición de cursor previa para el
  //     suavizado (lerp); evita un "salto" inicial desde (0,0).
  // ---------------------------------------------------------------------------
  var debounce = {
    joinRaw: false,        // condición instantánea de "manos juntas" este fotograma
    joinStable: false,     // estado de "manos juntas" ya confirmado (debounced)
    joinCounter: 0,        // fotogramas consecutivos con joinRaw != joinStable

    pinchRaw: false,       // condición instantánea de "pinza" este fotograma
    pinchStable: false,    // estado de "pinza" ya confirmado (debounced)
    pinchCounter: 0,       // fotogramas consecutivos con pinchRaw != pinchStable

    cursorX: 0,            // última X suavizada del cursor (px del escenario)
    cursorY: 0,            // última Y suavizada del cursor (px del escenario)
    cursorInit: false,     // ¿ya hay una posición previa válida para el lerp?
    cursorTime: 0          // timestamp del último suavizado (para dt indep. de FPS)
  };

  // Reloj monótono para el suavizado independiente de FPS.
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  // ---------------------------------------------------------------------------
  // Utilidad interna: distancia euclídea entre dos puntos {x,y}.
  // ---------------------------------------------------------------------------
  function distance(ax, ay, bx, by) {
    var dx = ax - bx;
    var dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------------------------------------------------------------------------
  // Suavizado lineal (lerp). Devuelve a + (b - a) * t.
  // Se usa para el cursor de pinza con factor CONFIG.CURSOR_LERP (0.5).
  // ---------------------------------------------------------------------------
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // ---------------------------------------------------------------------------
  // Proyección normalizado -> px de stage ESCRIBIENDO en `out` (sin asignar un
  // objeto nuevo). Misma transformación "cover" que toStage(). La usa
  // drawSkeleton con un pool reutilizable para NO generar basura (GC) por frame:
  // antes cada frame creaba ~21 objetos {x,y} por mano, lo que provocaba micro-
  // tirones en equipos lentos. toStage() delega aquí pasando un objeto nuevo, así
  // su contrato (devolver objeto nuevo) se mantiene para el resto de llamadores.
  // ---------------------------------------------------------------------------
  function projectInto(normPoint, stageRect, mirrored, out) {
    var nx = mirrored ? (1 - normPoint.x) : normPoint.x;
    var ny = normPoint.y;
    var camW = srcW;
    var camH = srcH;
    var scale = Math.max(stageRect.width / camW, stageRect.height / camH);
    var displayedW = camW * scale;
    var displayedH = camH * scale;
    var offsetX = (stageRect.width - displayedW) / 2;
    var offsetY = (stageRect.height - displayedH) / 2;
    out.x = stageRect.x + offsetX + nx * displayedW;
    out.y = stageRect.y + offsetY + ny * displayedH;
    return out;
  }

  // Pool de puntos {x,y} reutilizados entre frames por drawSkeleton (una mano a
  // la vez se dibuja, así que 21 ranuras bastan; crecen si hiciera falta).
  var _skelPool = [];
  function skelPoint(i) {
    var o = _skelPool[i];
    if (!o) {
      o = { x: 0, y: 0 };
      _skelPool[i] = o;
    }
    return o;
  }

  var Gestures = {

    /* -------------------------------------------------------------------------
     * Gestures.wristDistance(landmarksA, landmarksB) -> number (normalizado 0..1)
     *   Distancia entre las muñecas (landmark 0) de dos manos, en coordenadas
     *   normalizadas de MediaPipe (sin des-espejar: la distancia es invariante
     *   al espejado, así que da igual el lado). Si falta alguna mano -> Infinity
     *   para que NUNCA se interprete como "juntas".
     * ---------------------------------------------------------------------- */
    wristDistance: function (landmarksA, landmarksB) {
      if (!landmarksA || !landmarksB) return Infinity;
      var a = landmarksA[WRIST];
      var b = landmarksB[WRIST];
      if (!a || !b) return Infinity;
      return distance(a.x, a.y, b.x, b.y);
    },

    /* -------------------------------------------------------------------------
     * Gestures.pinchDistance(landmarks) -> number (normalizado 0..1)
     *   Distancia entre la punta del pulgar (4) y la del índice (8) de una mano.
     *   Si faltan landmarks -> Infinity (no hay pinza posible).
     * ---------------------------------------------------------------------- */
    pinchDistance: function (landmarks) {
      if (!landmarks) return Infinity;
      var t = landmarks[THUMB_TIP];
      var i = landmarks[INDEX_TIP];
      if (!t || !i) return Infinity;
      return distance(t.x, t.y, i.x, i.y);
    },

    /* -------------------------------------------------------------------------
     * Gestures.isPinching(landmarks) -> boolean
     *   Condición INSTANTÁNEA de pinza: distancia 4<->8 por debajo del umbral
     *   CONFIG.PINCH_THRESHOLD (0.05). No aplica debounce (eso lo hace process()).
     * ---------------------------------------------------------------------- */
    isPinching: function (landmarks) {
      return this.pinchDistance(landmarks) < CONFIG.PINCH_THRESHOLD;
    },

    /* -------------------------------------------------------------------------
     * Gestures.handsJoined(multiLandmarks) -> boolean
     *   Condición INSTANTÁNEA de manos juntas: exactamente (al menos) 2 manos y
     *   distancia entre muñecas < CONFIG.JOIN_THRESHOLD (0.18). Sin debounce.
     * ---------------------------------------------------------------------- */
    handsJoined: function (multiLandmarks) {
      if (!multiLandmarks || multiLandmarks.length < 2) return false;
      // Both hands visible is enough to start — players expect "show both hands",
      // not "touch your wrists together". The READY hold (READY_HOLD_MS) prevents
      // accidental starts, so we no longer gate on wrist distance.
      return true;
    },

    /* -------------------------------------------------------------------------
     * Gestures.toStage(normPoint, stageRect, mirrored=true) -> {x, y}
     *   Convierte un punto normalizado de MediaPipe (0..1) a PÍXELES del lienzo
     *   del escenario (#fx-canvas), des-espejando la X UNA sola vez.
     *
     *   - El <video> está espejado por CSS (transform: scaleX(-1)), por lo que la
     *     X del landmark se des-espeja con x' = 1 - x cuando mirrored === true.
     *   - Se mapea usando el MISMO stageRect que usa puzzle.js para la geometría
     *     del tablero, de modo que cursor y hit-tests comparten un único espacio.
     *   - stageRect tiene la forma {x, y, width, height} (px internos del lienzo).
     * ---------------------------------------------------------------------- */
    toStage: function (normPoint, stageRect, mirrored) {
      if (mirrored === undefined) mirrored = true;        // por defecto, espejado
      // Misma transformación "cover" que projectInto, pero devolviendo un objeto
      // nuevo (contrato público de toStage). El <video> usa object-fit: cover, así
      // que el frame de cámara se escala para LLENAR el stage recortando el eje
      // sobrante; usamos el tamaño REAL del frame (srcW/srcH, medido en process
      // desde results.image) para alinear bien también en webcams no 4:3 (16:9).
      return projectInto(normPoint, stageRect, mirrored, { x: 0, y: 0 });
    },

    /* -------------------------------------------------------------------------
     * Gestures.primaryHand(results) -> landmarks | null
     *   Elige la mano "principal" para la pinza. Preferimos la mano derecha del
     *   usuario si MediaPipe la clasifica; si no, la primera mano detectada.
     *   Devuelve los landmarks normalizados de esa mano, o null si no hay manos.
     * ---------------------------------------------------------------------- */
    primaryHand: function (results) {
      if (!results) return null;
      var hands = results.multiHandLandmarks;
      if (!hands || hands.length === 0) return null;

      // results.multiHandedness[i].label es 'Left' / 'Right' (etiqueta de MediaPipe).
      // Nota: MediaPipe etiqueta respecto a la imagen sin espejar; aun así, basta
      // con una elección estable. Preferimos 'Right' si está disponible.
      var handedness = results.multiHandedness;
      if (handedness && handedness.length === hands.length) {
        for (var i = 0; i < handedness.length; i++) {
          var label = handedness[i] && handedness[i].label;
          if (label === 'Right') return hands[i];
        }
      }
      // Sin clasificación válida: usamos la primera mano detectada.
      return hands[0];
    },

    /* -------------------------------------------------------------------------
     * Gestures.process(results, stageRect) -> void
     *   Punto de entrada por fotograma (llamado desde app.onResults). Actualiza
     *   APP.hands.{count, raw, joined, joinPoint, pinch} aplicando debounce y
     *   marcando pinch.justDown / pinch.justUp durante exactamente un fotograma.
     *
     *   No dibuja nada (el dibujo del esqueleto vive en drawSkeleton, llamado
     *   desde el bucle rAF de app.js).
     * ---------------------------------------------------------------------- */
    process: function (results, stageRect) {
      var hands = APP.hands;
      var multi = (results && results.multiHandLandmarks) ? results.multiHandLandmarks : [];

      // --- 0) Tamaño real del fotograma -------------------------------------
      // MediaPipe adjunta el frame de entrada en results.image. Medimos su tamaño
      // real para que toStage() use el aspecto verdadero de ESTA webcam (corrige
      // la desalineación en cámaras 16:9). En SIM_MODE no hay image -> mantenemos
      // los valores de CONFIG (coinciden con el inverso de simulation.js).
      if (results && results.image &&
          results.image.width > 0 && results.image.height > 0) {
        srcW = results.image.width;
        srcH = results.image.height;
      }

      // --- 1) Manos crudas y conteo -----------------------------------------
      // raw alimenta el dibujo del esqueleto; count es 0|1|2.
      hands.raw = multi;
      hands.count = Math.min(multi.length, 2);

      // --- 2) Manos juntas (debounced) --------------------------------------
      // Condición instantánea de este fotograma.
      debounce.joinRaw = this.handsJoined(multi);
      if (debounce.joinRaw !== debounce.joinStable) {
        // La condición difiere del estado confirmado: acumulamos fotogramas.
        debounce.joinCounter++;
        if (debounce.joinCounter >= CONFIG.DEBOUNCE_FRAMES) {
          debounce.joinStable = debounce.joinRaw;   // se confirma el cambio
          debounce.joinCounter = 0;
        }
      } else {
        // Coincide con el estado confirmado: reseteamos el contador.
        debounce.joinCounter = 0;
      }
      hands.joined = debounce.joinStable;

      // --- 3) Punto de unión (midpoint de las dos muñecas, en px) -----------
      // Solo tiene sentido con 2 manos; se calcula des-espejado para alinear
      // con el vídeo en espejo. Usado por Anim.drawJoinRing en la fase READY.
      if (multi.length >= 2 && multi[0][WRIST] && multi[1][WRIST]) {
        var wA = this.toStage(multi[0][WRIST], stageRect, true);
        var wB = this.toStage(multi[1][WRIST], stageRect, true);
        hands.joinPoint.x = (wA.x + wB.x) / 2;
        hands.joinPoint.y = (wA.y + wB.y) / 2;
      }
      // Si no hay 2 manos, conservamos el último joinPoint (no estorba: la fase
      // READY solo se alcanza con manos juntas, donde sí se actualiza).

      // --- 4) Pinza de la mano principal (debounced + cursor suavizado) -----
      var primary = this.primaryHand(results);
      var pinch = hands.pinch;

      // Reseteamos los flancos: por defecto, este fotograma no es flanco.
      pinch.justDown = false;
      pinch.justUp = false;

      if (primary) {
        // Condición instantánea de pinza para la mano principal.
        debounce.pinchRaw = this.isPinching(primary);
        if (debounce.pinchRaw !== debounce.pinchStable) {
          debounce.pinchCounter++;
          if (debounce.pinchCounter >= CONFIG.DEBOUNCE_FRAMES) {
            // Se confirma el cambio de estado: detectamos el flanco AQUÍ, para
            // que justDown/justUp duren exactamente un fotograma.
            var prevStable = debounce.pinchStable;
            debounce.pinchStable = debounce.pinchRaw;
            debounce.pinchCounter = 0;
            if (debounce.pinchStable && !prevStable) {
              pinch.justDown = true;   // flanco de subida: pinza cerrada (grab)
            } else if (!debounce.pinchStable && prevStable) {
              pinch.justUp = true;     // flanco de bajada: pinza abierta (drop/swap)
            }
          }
        } else {
          debounce.pinchCounter = 0;
        }
        pinch.active = debounce.pinchStable;

        // Cursor de pinza: midpoint entre pulgar (4) e índice (8), des-espejado
        // y mapeado a px del escenario, suavizado con CONFIG.CURSOR_LERP (0.5).
        var t = primary[THUMB_TIP];
        var i = primary[INDEX_TIP];
        if (t && i) {
          var mid = { x: (t.x + i.x) / 2, y: (t.y + i.y) / 2 };
          var target = this.toStage(mid, stageRect, true);
          var ts = nowMs();
          if (!debounce.cursorInit) {
            // Primera muestra válida: colocamos el cursor sin suavizar para
            // evitar un salto desde (0,0).
            debounce.cursorX = target.x;
            debounce.cursorY = target.y;
            debounce.cursorInit = true;
          } else {
            // Suavizado EXPONENCIAL independiente de los FPS: el "feel" es el mismo
            // a 60 fps o a 24 fps (en equipos lentos el cursor ya no se arrastra).
            // alpha base equivale a CURSOR_LERP por frame de ~16.67ms.
            var dt = debounce.cursorTime ? (ts - debounce.cursorTime) : 16.67;
            if (dt < 1) dt = 1; else if (dt > 64) dt = 64;
            var base = (typeof CONFIG.CURSOR_LERP === 'number') ? CONFIG.CURSOR_LERP : 0.5;
            var alpha = 1 - Math.pow(1 - base, dt / 16.6667);
            // Adaptativo por velocidad: en movimientos amplios "engancha" más rápido
            // (sin lag); cuando la mano está casi quieta se suaviza al máximo, lo que
            // elimina el jitter típico de webcams de baja calidad.
            var dx = target.x - debounce.cursorX;
            var dy = target.y - debounce.cursorY;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var snapPx = (typeof CONFIG.CURSOR_SNAP_PX === 'number') ? CONFIG.CURSOR_SNAP_PX : 90;
            var boost = snapPx > 0 ? (dist / snapPx) : 0;
            if (boost > 1) boost = 1;
            alpha = alpha + (1 - alpha) * boost;
            if (alpha > 1) alpha = 1;
            debounce.cursorX += dx * alpha;
            debounce.cursorY += dy * alpha;
          }
          debounce.cursorTime = ts;
          pinch.x = debounce.cursorX;
          pinch.y = debounce.cursorY;
        }
      } else {
        // No hay mano principal: la pinza no puede estar activa. Si veníamos de
        // una pinza confirmada, emitimos un justUp para no dejar tiles colgadas.
        debounce.pinchRaw = false;
        debounce.pinchCounter = 0;
        if (debounce.pinchStable) {
          debounce.pinchStable = false;
          pinch.justUp = true;       // soltamos al perder la mano (un fotograma)
        }
        pinch.active = false;
        // Olvidamos la posición previa del cursor para no suavizar contra una
        // posición obsoleta cuando la mano reaparezca.
        debounce.cursorInit = false;
        debounce.cursorTime = 0;   // evita un dt enorme al reaparecer la mano
      }
    },

    /* -------------------------------------------------------------------------
     * Gestures.drawSkeleton(ctx, multiHandLandmarks) -> void
     *   §6 #1: draws the hand skeleton every frame onto #cam-canvas.
     *
     *   IMPORTANT: every landmark is projected through toStage() — the SAME
     *   transform the pinch cursor uses — which un-mirrors X and applies the
     *   object-fit:cover crop. This makes the skeleton land exactly on the
     *   visible hand of the mirrored selfie video (and exactly where the cursor
     *   hit-tests). MediaPipe's drawConnectors/drawLandmarks are NOT used because
     *   they map raw landmarks linearly (no mirror, no cover), which drew the
     *   skeleton on the opposite side and wrong scale. CONTRACT §8.
     *
     *   - Connectors (HAND_CONNECTIONS) in green (COLORS.skeleton) with a cyan
     *     glow (shadowColor = COLORS.glowCyan, shadowBlur = 8).
     *   - Landmark dots: radius 7 on fingertips (CONFIG.FINGERTIPS), 4 elsewhere.
     * ---------------------------------------------------------------------- */
    drawSkeleton: function (ctx, multiHandLandmarks) {
      if (!ctx || !multiHandLandmarks || multiHandLandmarks.length === 0) return;

      // Coordinate space shared with the cursor/hit-test: cam-canvas is sized to
      // the stage exactly like fx-canvas, so we derive stageRect from the canvas.
      var stageRect = { x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height };
      var hasConnections = (typeof HAND_CONNECTIONS !== 'undefined') &&
                           HAND_CONNECTIONS && HAND_CONNECTIONS.length;

      ctx.save();
      // Cyan glow around the green stroke ("neon" look).
      ctx.shadowColor = CONFIG.COLORS.glowCyan;
      ctx.shadowBlur = 8;
      ctx.lineCap = 'round';

      for (var h = 0; h < multiHandLandmarks.length; h++) {
        var landmarks = multiHandLandmarks[h];
        if (!landmarks || !landmarks.length) continue;

        // Project all landmarks into stage space (mirror + cover) using the
        // reusable pool — NO per-frame allocation (zero GC pressure on weak
        // devices). One hand is fully drawn before the next, so the pool can be
        // refilled per hand.
        var n = landmarks.length;
        for (var i = 0; i < n; i++) {
          projectInto(landmarks[i], stageRect, true, skelPoint(i));
        }

        // Bones (connectors).
        if (hasConnections) {
          ctx.strokeStyle = CONFIG.COLORS.skeleton;
          ctx.lineWidth = 4;
          for (var c = 0; c < HAND_CONNECTIONS.length; c++) {
            var conn = HAND_CONNECTIONS[c];
            var a = (conn[0] < n) ? _skelPool[conn[0]] : null;
            var b = (conn[1] < n) ? _skelPool[conn[1]] : null;
            if (!a || !b) continue;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }

        // Joints: bigger dots on the fingertips.
        for (var j = 0; j < n; j++) {
          var p = _skelPool[j];
          var r = (CONFIG.FINGERTIPS.indexOf(j) !== -1) ? 7 : 4;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = CONFIG.COLORS.glowCyan;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = CONFIG.COLORS.skeleton;
          ctx.stroke();
        }
      }

      ctx.restore();
    },

    /* -------------------------------------------------------------------------
     * Gestures.resetDebounce() -> void
     *   Reinicia TODO el estado interno de gestos: contadores de debounce,
     *   estados estables y el suavizado del cursor. Lo invoca app.js entre
     *   rondas / al reiniciar para que los gestos no arrastren estado previo
     *   (p. ej. una pinza confirmada de la ronda anterior).
     * ---------------------------------------------------------------------- */
    resetDebounce: function () {
      debounce.joinRaw = false;
      debounce.joinStable = false;
      debounce.joinCounter = 0;

      debounce.pinchRaw = false;
      debounce.pinchStable = false;
      debounce.pinchCounter = 0;

      debounce.cursorX = 0;
      debounce.cursorY = 0;
      debounce.cursorInit = false;
      debounce.cursorTime = 0;

      // Limpiamos también los reflejos en APP.hands (único escritor: este módulo).
      if (window.APP && APP.hands) {
        APP.hands.joined = false;
        APP.hands.pinch.active = false;
        APP.hands.pinch.justDown = false;
        APP.hands.pinch.justUp = false;
      }
    },

    /* -------------------------------------------------------------------------
     * Gestures.frameSize() -> { w, h }
     *   Tamaño real del fotograma de la cámara medido en el último process()
     *   (results.image). Es la MISMA fuente que usa toStage() para el mapeo
     *   "cover". simulation.js la usa para invertir el mapeo con coherencia.
     * ---------------------------------------------------------------------- */
    frameSize: function () {
      return { w: srcW, h: srcH };
    }
  };

  // Exponemos el namespace global (sin módulos ES, según CONTRACT.md §0).
  window.Gestures = Gestures;

})(window);
