/* =========================================================================
 * app.js — CONTROLADOR (PUZZLE CAM)
 * -------------------------------------------------------------------------
 * Rol de este archivo (segun CONTRACT.md §9 "app.js — controller"):
 *   - Arranque (secuencia LOADING) y deteccion de fallo de camara (ERROR).
 *   - El UNICO requestAnimationFrame del proyecto (app.loop).
 *   - Encaminar gestos -> maquina de estados -> puzzle/strip/animaciones.
 *   - Orquestar que capa se dibuja en cada fase.
 *
 * Reglas duras (CONTRACT.md §0):
 *   - Es el UNICO modulo que llama a State.set (en boot, updatePhase y los
 *     handlers onEnter registrados via State.onEnter).
 *   - No muta en profundidad los sub-objetos de APP (hands/puzzle/strip/fx):
 *     coordina llamando a los metodos de cada modulo.
 *   - Una sola base de tiempo: State.elapsed() dentro del rAF. Sin setTimeout
 *     para salidas de estado.
 *   - Un solo espacio de coordenadas: pixeles internos de #fx-canvas
 *     (app.stageRect()), compartido por gestos y puzzle.
 *
 * Se adjunta como window.app para que las callbacks (p.ej. onResults) puedan
 * referenciarse de forma estable.
 * ========================================================================= */

(function () {
  'use strict';

  // Atajos a los singletons globales declarados por los modulos previos
  // (orden de carga: config -> state -> camera -> gestures -> puzzle ->
  //  animations -> photostrip -> app).
  var States = window.States;

  // Cache de elementos del DOM (se rellena en app.boot tras DOMContentLoaded).
  var dom = {
    app: null,
    badge: null,            // #status-badge (pulso de badge cada frame)
    badgeLabel: null,       // #badge-label
    video: null,            // #cam-video (origen de captura y de MediaPipe)
    camCanvas: null,        // #cam-canvas (capa del esqueleto)
    fxCanvas: null,         // #fx-canvas (capa puzzle + efectos; espacio de coords)
    overlay: null,          // #stage-overlay
    idlePrompt: null,       // #idle-prompt
    countdown: null,        // #countdown
    countdownNum: null,     // #countdown-num
    flash: null,            // #flash
    complete: null,         // #complete
    dim: null,              // #dim
    stage: null,            // #stage (blink de obturador)
    strip: null,            // #strip
    stripBanner: null,      // #strip-banner
    controls: null,         // #controls
    btnDownload: null,      // #btn-download
    btnReset: null,         // #btn-reset
    loader: null,           // #loader
    cameraError: null       // #camera-error
  };

  // Contextos 2D cacheados de las dos capas de canvas.
  var camCtx = null;        // contexto de #cam-canvas (esqueleto)
  var fxCtx = null;         // contexto de #fx-canvas (puzzle/efectos)

  // Identificador del rAF en curso (para evitar arranques duplicados).
  var rafId = 0;

  // Contador de fotogramas consecutivos SIN manos durante COUNTDOWN. MediaPipe
  // pierde la deteccion uno o dos fotogramas con frecuencia (motion blur, mano
  // en el borde), asi que solo abortamos la cuenta atras tras varios fotogramas
  // seguidos sin manos (debounce, espejo de CONFIG.DEBOUNCE_FRAMES).
  var countdownMissedFrames = 0;

  // ---------------------------------------------------------------------
  // app.boot() -> Promise<void>
  // Secuencia de arranque (CONTRACT.md §9). Cachea DOM, aplica reduced-motion,
  // construye la tira, inicializa el estado, registra handlers onEnter/onExit,
  // ata botones, inicializa la camara/MediaPipe y arranca el rAF.
  // ---------------------------------------------------------------------
  function boot() {
    // 1. Cachear todos los elementos del DOM por su id canonico (CONTRACT.md §2).
    cacheDom();

    // 2. Contextos de dibujo + dimensionar los canvas a su tamano interno.
    camCtx = dom.camCanvas.getContext('2d');
    fxCtx = dom.fxCanvas.getContext('2d');
    resizeCanvases();
    // Re-dimensionar si cambia el viewport (mantiene el espacio de coords sano).
    window.addEventListener('resize', resizeCanvases);

    // 3. Reduced-motion: lee matchMedia y fija APP.reducedMotion + body.reduced-motion.
    var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    window.Anim.applyReducedMotion(mql.matches);
    // Mantener APP.reducedMotion sincronizado si el usuario cambia la preferencia
    // del SO con la app abierta (los guardas JS leen APP.reducedMotion en vivo).
    var onMotionChange = function (e) {
      window.Anim.applyReducedMotion(e.matches);
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onMotionChange);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onMotionChange); // navegadores antiguos
    }

    // 4. Construir las ranuras de la tira (genera N x .slot y espeja APP.strip.slots).
    window.PhotoStrip.init(dom.strip);

    // 5. Inicializar la maquina de estados (phase=LOADING, slots de strip, etc.).
    window.State.init();

    // 6. Registrar TODOS los handlers de entrada/salida de fase.
    registerStateHandlers();

    // 7. Atar los botones (Descargar / Reiniciar).
    bindButtons();

    // Modo SIMULACION (simulation.html): SIN camara real ni MediaPipe. El script
    // simulation.js coloca una pista de video sintetica (avatar) en #cam-video y
    // alimenta app.onResults con manos sinteticas. Arrancamos directo en IDLE.
    if (window.SIM_MODE) {
      window.Anim.spinner(dom.loader, false);
      window.APP.ready.camera = true;
      window.APP.ready.mediapipe = true;
      startLoop();
      window.State.set(States.IDLE);
      return;
    }

    // 8. Mostrar el spinner de carga (§6 #26) mientras inicializa MediaPipe.
    window.Anim.spinner(dom.loader, true);

    // 9. Inicializar camara + MediaPipe. Camera.init NUNCA lanza: ante un
    //    rechazo de getUserMedia fija APP.cameraError y resuelve igualmente.
    return window.Camera.init({ videoEl: dom.video, onResults: onResults })
      .then(function () {
        if (window.APP.cameraError) {
          // Fallo de permisos -> ruta LOADING -> ERROR (pantalla en espanol).
          window.State.set(States.ERROR);
        } else {
          // Camara OK: arrancar el bucle de captura de MediaPipe.
          return window.Camera.start();
        }
      })
      .catch(function (err) {
        // Defensa extra: cualquier error inesperado degrada a ERROR sin romper.
        console.warn('Fallo inesperado al iniciar la camara:', err);
        if (!window.APP.cameraError) {
          window.APP.cameraError = window.STRINGS.cameraDenied;
        }
        if (!window.State.is(States.ERROR)) {
          window.State.set(States.ERROR);
        }
      })
      .then(function () {
        // 10. Arrancar el UNICO requestAnimationFrame del proyecto.
        startLoop();
      });
  }

  // Cachea los elementos del DOM una sola vez.
  function cacheDom() {
    dom.app = document.getElementById('app');
    dom.badge = document.getElementById('status-badge');
    dom.badgeLabel = document.getElementById('badge-label');
    dom.video = document.getElementById('cam-video');
    dom.camCanvas = document.getElementById('cam-canvas');
    dom.fxCanvas = document.getElementById('fx-canvas');
    dom.overlay = document.getElementById('stage-overlay');
    dom.idlePrompt = document.getElementById('idle-prompt');
    dom.countdown = document.getElementById('countdown');
    dom.countdownNum = document.getElementById('countdown-num');
    dom.flash = document.getElementById('flash');
    dom.complete = document.getElementById('complete');
    dom.dim = document.getElementById('dim');
    dom.stage = document.getElementById('stage');
    dom.strip = document.getElementById('strip');
    dom.stripBanner = document.getElementById('strip-banner');
    dom.controls = document.getElementById('controls');
    dom.btnDownload = document.getElementById('btn-download');
    dom.btnReset = document.getElementById('btn-reset');
    dom.loader = document.getElementById('loader');
    dom.cameraError = document.getElementById('camera-error');
    // Controles flotantes siempre visibles (Restart + ocultar tira/barra).
    dom.btnRestart = document.getElementById('btn-restart');
    dom.toggleRail = document.getElementById('toggle-rail');
    dom.toggleTopbar = document.getElementById('toggle-topbar');
  }

  // Ajusta el tamano INTERNO de pixeles de ambos canvas al tamano CSS del stage.
  // Este tamano interno es el espacio de coordenadas compartido (CONTRACT.md §8).
  function resizeCanvases() {
    var rect = dom.stage.getBoundingClientRect();
    // Fallback de seguridad si el layout aun no tiene tamano medible.
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    if (dom.camCanvas.width !== w || dom.camCanvas.height !== h) {
      dom.camCanvas.width = w;
      dom.camCanvas.height = h;
    }
    if (dom.fxCanvas.width !== w || dom.fxCanvas.height !== h) {
      dom.fxCanvas.width = w;
      dom.fxCanvas.height = h;
    }
  }

  // ---------------------------------------------------------------------
  // app.stageRect() -> {x,y,width,height}
  // Rect en PIXELES INTERNOS de #fx-canvas. Es el unico espacio de coords
  // que comparten el cursor de pinza, el hit-test de fichas y la geometria
  // del tablero (CONTRACT.md §8).
  // ---------------------------------------------------------------------
  function stageRect() {
    return { x: 0, y: 0, width: dom.fxCanvas.width, height: dom.fxCanvas.height };
  }

  // Rect (centrado y cuadrado) que sirve de origen para el vuelo a la tira
  // (§6 #19). Tomamos el lado del tablero del puzzle si esta disponible; si no,
  // usamos un cuadrado centrado en el stage. Devuelve un rect en pixeles de
  // pantalla (coords de viewport) para encajar con PhotoStrip.slotRect (DOMRect).
  function stageCenterRect() {
    var stageBox = dom.stage.getBoundingClientRect();
    var p = window.APP.puzzle;
    var sr = stageRect();
    // Escala entre pixeles internos del canvas y pixeles CSS del stage.
    var scaleX = sr.width ? stageBox.width / sr.width : 1;
    var scaleY = sr.height ? stageBox.height / sr.height : 1;

    var sizeInternal = (p && p.boardSize) ? p.boardSize
      : Math.min(sr.width, sr.height) * 0.8;
    var xInternal = (p && p.boardSize) ? p.boardX : (sr.width - sizeInternal) / 2;
    var yInternal = (p && p.boardSize) ? p.boardY : (sr.height - sizeInternal) / 2;

    return {
      left: stageBox.left + xInternal * scaleX,
      top: stageBox.top + yInternal * scaleY,
      width: sizeInternal * scaleX,
      height: sizeInternal * scaleY
    };
  }

  // ---------------------------------------------------------------------
  // app.onResults(results) -> void
  // Callback de MediaPipe. Procesa gestos (unico escritor de APP.hands via
  // Gestures.process), marca mediapipe listo y, si seguimos en LOADING con la
  // camara lista, transiciona a IDLE. NO dibuja nada aqui (eso es del rAF).
  // ---------------------------------------------------------------------
  function onResults(results) {
    // Gestures es el UNICO escritor de APP.hands; le pasamos el espacio de coords.
    window.Gestures.process(results, stageRect());

    // Primer resultado valido => MediaPipe listo.
    window.APP.ready.mediapipe = true;

    // Compuerta de arranque: ambos listos y aun en LOADING -> IDLE.
    if (window.State.is(States.LOADING) && window.APP.ready.camera) {
      window.State.set(States.IDLE);
    }
  }

  // ---------------------------------------------------------------------
  // Arranque del bucle (idempotente).
  // ---------------------------------------------------------------------
  function startLoop() {
    if (rafId) {
      return;
    }
    rafId = window.requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------
  // app.loop(now) -> void
  // EL unico requestAnimationFrame. Orden EXACTO por frame (CONTRACT.md §9):
  //   1. APP.frame++
  //   2. Anim.badgePulse(badge, hands.count>0)
  //   3. app.updatePhase(now)   -> chequeos de transicion + State.set
  //   4. Anim.tick(now)         -> avanza tweens/particulas/cuenta atras
  //   5. limpiar #cam-canvas; Gestures.drawSkeleton(camCtx, hands.raw)
  //   6. limpiar #fx-canvas; dibujo por fase (ring/cuenta/puzzle/flash/confeti)
  //   7. requestAnimationFrame(app.loop)
  // ---------------------------------------------------------------------
  function loop(now) {
    var APP = window.APP;

    // 1. Tick monotono del frame.
    APP.frame++;

    // 2. Pulso del badge segun haya o no manos (independiente de la fase, §6 #2).
    var hasHands = APP.hands.count > 0;
    window.Anim.badgePulse(dom.badge, hasHands);
    // Etiqueta del badge refleja la presencia de manos (BRIEF §7): muestra
    // "MUESTRA TUS MANOS" cuando no hay manos y "MANOS EN SEGUIMIENTO" cuando si.
    if (dom.badgeLabel) {
      var label = hasHands ? window.STRINGS.tracking : window.STRINGS.noHands;
      if (dom.badgeLabel.textContent !== label) {
        dom.badgeLabel.textContent = label;
      }
    }

    // 3. Comprobaciones de transicion de fase (tiempo/gestos) + entrada de pinza.
    updatePhase(now);

    // 4. Avanzar TODOS los tweens, particulas y la cuenta atras (una sola vez).
    window.Anim.tick(now);

    // 5. Capa esqueleto: limpiar y redibujar la mano en tiempo real (§6 #1).
    camCtx.clearRect(0, 0, dom.camCanvas.width, dom.camCanvas.height);
    window.Gestures.drawSkeleton(camCtx, APP.hands.raw);

    // 6. Capa fx: limpiar y dibujar lo que corresponda a la fase actual.
    fxCtx.clearRect(0, 0, dom.fxCanvas.width, dom.fxCanvas.height);
    renderPhase(now);
    // 6b. Cursor de pinza: marcador visible de donde apunta la mano (feedback).
    drawCursor();

    // 7. Re-agendar el siguiente frame.
    rafId = window.requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------
  // app.updatePhase(now) -> void
  // switch(APP.phase): chequeos de salida por tiempo/gesto (tabla §6).
  // Es el lugar (junto con los onEnter) donde se llama a State.set.
  // ---------------------------------------------------------------------
  function updatePhase(now) {
    var APP = window.APP;
    var C = window.CONFIG;

    switch (APP.phase) {
      case States.IDLE:
        // IDLE -> READY: gestos marcaron manos juntas (debounced).
        if (APP.hands.joined === true) {
          window.State.set(States.READY);
        }
        break;

      case States.READY:
        // READY -> IDLE: si las manos se separan antes de completar el hold.
        if (APP.hands.joined === false) {
          window.State.set(States.IDLE);
          break;
        }
        // Avanzar / desenrollar el anillo de progreso (§6 #4).
        // Si las manos siguen juntas, el anillo se llena en READY_HOLD_MS;
        // (si no, ya habriamos vuelto a IDLE en la rama anterior).
        APP.readyRing.progress = Math.min(
          1,
          window.State.elapsed() / C.READY_HOLD_MS
        );
        // READY -> COUNTDOWN: anillo lleno (mantenido READY_HOLD_MS).
        if (APP.readyRing.progress >= 1) {
          window.State.set(States.COUNTDOWN);
        }
        break;

      case States.COUNTDOWN:
        // Si se pierden las manos, ruta de aborto COUNTDOWN -> IDLE, pero
        // DEBOUNCED: un unico fotograma sin deteccion no debe cancelar la ronda.
        if (APP.hands.count === 0) {
          countdownMissedFrames++;
          if (countdownMissedFrames >= C.DEBOUNCE_FRAMES) {
            countdownMissedFrames = 0;
            window.State.set(States.IDLE);
            break;
          }
        } else {
          // Las manos volvieron a verse: reiniciamos el contador de fallos.
          countdownMissedFrames = 0;
        }
        // Actualizar el numero visible 3..1 segun el tiempo transcurrido.
        updateCountdownValue(now);
        // COUNTDOWN -> CAPTURE: agotada la cuenta completa (FROM * TICK_MS).
        if (window.State.elapsed() >= C.COUNTDOWN_FROM * C.COUNTDOWN_TICK_MS) {
          window.State.set(States.CAPTURE);
        }
        break;

      case States.CAPTURE:
        // CAPTURE -> PUZZLE: terminado el flash de captura (§6 #6).
        if (window.State.elapsed() >= C.DUR.flash) {
          window.State.set(States.PUZZLE);
        }
        break;

      case States.PUZZLE:
        // Toda la interaccion de pinza (grab/drag/release + chequeo de resuelto)
        // ocurre en handlePinchInput; el paso a SOLVED se dispara alli.
        handlePinchInput();
        break;

      case States.SOLVED:
        // SOLVED -> STRIP_ADD: tras el dwell de celebracion.
        if (window.State.elapsed() >= C.SOLVED_HOLD_MS) {
          window.State.set(States.STRIP_ADD);
        }
        break;

      // LOADING/CAPTURE-flash/STRIP_ADD/STRIP_COMPLETE/ERROR no tienen
      // salidas controladas por tiempo aqui:
      //   - LOADING sale via onResults / boot.
      //   - STRIP_ADD sale dentro de la callback de fly-to-strip (onEnter).
      //   - STRIP_COMPLETE sale por click de Reiniciar (bindButtons).
      //   - ERROR es terminal.
      default:
        break;
    }
  }

  // Calcula el numero de cuenta atras visible (3,2,1) y su tiempo de inicio de
  // tick, para que Anim.drawCountdown pueda animar el zoom in/out por numero.
  function updateCountdownValue(now) {
    var APP = window.APP;
    var C = window.CONFIG;
    var elapsed = window.State.elapsed();
    // tick 0 => "3", tick 1 => "2", tick 2 => "1".
    var tick = Math.floor(elapsed / C.COUNTDOWN_TICK_MS);
    if (tick > C.COUNTDOWN_FROM - 1) {
      tick = C.COUNTDOWN_FROM - 1;
    }
    var value = C.COUNTDOWN_FROM - tick;
    if (value !== APP.countdown.value) {
      APP.countdown.value = value;
      // Momento (en reloj rAF) en que empezo este numero, base del tween visual.
      APP.countdown.tickStartedAt = now;
    }
  }

  // ---------------------------------------------------------------------
  // app.handlePinchInput() -> void
  // En PUZZLE: lee los flancos de la pinza (justDown/justUp) y la posicion del
  // cursor para grab/drag/release; aplica hover; y si el puzzle queda resuelto
  // tras una suelta, transiciona a SOLVED.
  // ---------------------------------------------------------------------
  function handlePinchInput() {
    var APP = window.APP;
    var pinch = APP.hands.pinch;
    var puzzle = window.Puzzle;

    if (pinch.justDown) {
      // Flanco de bajada: intentar agarrar la ficha bajo el cursor (§6 #10).
      var tileId = puzzle.tileAtPoint(pinch.x, pinch.y);
      if (tileId !== null && tileId !== undefined) {
        puzzle.grab(tileId);
      }
    }

    if (pinch.active && APP.puzzle.grabbedTileId !== null &&
        APP.puzzle.grabbedTileId !== undefined) {
      // Mientras se mantiene la pinza con ficha agarrada: arrastre con lerp (§6 #11).
      puzzle.dragTo(pinch.x, pinch.y);
    } else {
      // Sin ficha agarrada: resaltar (hover) la ficha bajo el cursor (§6 #9).
      // El hover debe aparecer SIEMPRE que haya cursor/mano (no solo durante una
      // pinza activa), de lo contrario el resalte de objetivo seria invisible en
      // el uso normal. Lo conducimos por la presencia de mano, no por pinch.active.
      var hasCursor = APP.hands.count > 0;
      updateHover(hasCursor ? pinch.x : null,
                  hasCursor ? pinch.y : null);
    }

    if (pinch.justUp && APP.puzzle.grabbedTileId !== null &&
        APP.puzzle.grabbedTileId !== undefined) {
      if (APP.hands.count === 0) {
        // Suelta forzada por PERDIDA de la mano: las coordenadas de pinza estan
        // obsoletas (la ultima posicion de arrastre). Tratarla como una suelta
        // real podria provocar un swap no intencionado, asi que cancelamos el
        // agarre y la ficha vuelve a su celda de origen (§6 #14).
        puzzle.cancelGrab();
      } else {
        // Flanco de subida con mano presente: soltar -> swap o spring-back (§6 #12/#14).
        puzzle.release(pinch.x, pinch.y);
        // Tras una suelta, comprobar si el puzzle quedo resuelto.
        if (puzzle.checkSolved()) {
          window.State.set(States.SOLVED);
        }
      }
    }
  }

  // Aplica el resaltado de hover: marca la ficha bajo el cursor y limpia el
  // resto. Si no hay cursor valido, apaga todos los hovers.
  function updateHover(x, y) {
    var tiles = window.APP.puzzle.tiles;
    if (!tiles || !tiles.length) {
      return;
    }
    var hoverId = null;
    if (x !== null && y !== null) {
      hoverId = window.Puzzle.tileAtPoint(x, y);
    }
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var shouldHover = (hoverId !== null && t.id === hoverId);
      if (shouldHover && !t.hovered) {
        window.Anim.setHover(t, true);
      } else if (!shouldHover && t.hovered) {
        window.Anim.setHover(t, false);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Dibujo por fase (paso 6 del loop). El #fx-canvas ya viene limpio.
  // Orquesta QUE capa de canvas se pinta en cada estado.
  // ---------------------------------------------------------------------
  function renderPhase(now) {
    var APP = window.APP;

    switch (APP.phase) {
      case States.READY:
        // Anillo de progreso de "manos juntas" alrededor del punto de union (§6 #4).
        window.Anim.drawJoinRing(
          fxCtx,
          APP.hands.joinPoint.x,
          APP.hands.joinPoint.y,
          APP.readyRing.progress
        );
        break;

      case States.COUNTDOWN:
        // Numeros de cuenta atras (§6 #5): zoom-in/out por tick.
        window.Anim.drawCountdown(
          fxCtx,
          APP.countdown.value,
          now - APP.countdown.tickStartedAt
        );
        break;

      case States.CAPTURE:
        // El flash de captura es CSS (#flash.flash--fire); el lado canvas es
        // opcional. Lo pintamos si Anim.flash esta disponible (no rompe si no).
        if (typeof window.Anim.flash === 'function') {
          window.Anim.flash(fxCtx, APP.fx.flash);
        }
        break;

      case States.PUZZLE:
        // Tablero del puzzle: todas las fichas cada frame (§6 #7-#14).
        window.Puzzle.draw(fxCtx);
        break;

      case States.SOLVED:
        // Cara recompuesta + pulso de revelado, mas confeti encima (§6 #15/#17).
        window.Puzzle.draw(fxCtx);
        window.Anim.drawConfetti(fxCtx, now);
        break;

      case States.STRIP_ADD:
        // Durante el paso a la tira mostramos la cara recompuesta haciendo
        // crossfade de color a gris (§6 #18) sobre la region del tablero, en
        // lugar del tablero a color, para que la desaturacion sea visible antes
        // del vuelo (§6 #19). El confeti puede seguir vivo unos frames.
        var cap = APP.capture;
        var pz = APP.puzzle;
        if (cap && cap.canvas && cap.gray && pz && pz.boardSize > 0 &&
            typeof window.Anim.drawBwCrossfade === 'function') {
          window.Anim.drawBwCrossfade(
            fxCtx, cap.canvas, cap.gray,
            pz.boardX, pz.boardY, pz.boardSize, pz.boardSize
          );
        } else {
          // Respaldo si no tenemos la geometria/canvas: mostramos el tablero.
          window.Puzzle.draw(fxCtx);
        }
        window.Anim.drawConfetti(fxCtx, now);
        break;

      // LOADING / IDLE / STRIP_COMPLETE / ERROR: nada que dibujar en #fx-canvas
      // (la cromatica es DOM/CSS). El esqueleto se sigue pintando en #cam-canvas.
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // drawCursor(): visible pinch-cursor marker so the player can SEE where the
  // hand is aiming. Open cyan ring while tracking; tighter gold ring + dot when
  // pinching (grabbing). Drawn on #fx-canvas on top of the phase render.
  // ---------------------------------------------------------------------
  function drawCursor() {
    var APP = window.APP;
    if (APP.hands.count <= 0) return;
    var pinch = APP.hands.pinch;
    if (typeof pinch.x !== 'number' || typeof pinch.y !== 'number') return;
    var C = window.CONFIG;
    var active = pinch.active;
    fxCtx.save();
    fxCtx.shadowColor = C.COLORS.glowCyan;
    fxCtx.shadowBlur = 10;
    fxCtx.beginPath();
    fxCtx.arc(pinch.x, pinch.y, active ? 13 : 20, 0, Math.PI * 2);
    fxCtx.lineWidth = active ? 5 : 3;
    fxCtx.strokeStyle = active ? C.COLORS.gold : C.COLORS.glowCyan;
    fxCtx.stroke();
    fxCtx.beginPath();
    fxCtx.arc(pinch.x, pinch.y, active ? 4 : 3, 0, Math.PI * 2);
    fxCtx.fillStyle = active ? C.COLORS.gold : C.COLORS.glowCyan;
    fxCtx.fill();
    fxCtx.restore();
  }

  // ---------------------------------------------------------------------
  // Registro de handlers de entrada/salida de fase (CONTRACT.md §9).
  // Aqui vive la cromatica DOM por fase (§7) y las acciones onEnter.
  // ---------------------------------------------------------------------
  function registerStateHandlers() {
    var State = window.State;

    // LOADING: spinner visible, sin pantalla de error.
    State.onEnter(States.LOADING, function () {
      window.Anim.spinner(dom.loader, true);
      dom.cameraError.setAttribute('hidden', '');
    });

    // ERROR: ocultar loader y mostrar la pantalla de camara denegada (espanol).
    State.onEnter(States.ERROR, function () {
      window.Anim.spinner(dom.loader, false);
      dom.cameraError.removeAttribute('hidden');
    });

    // IDLE: loader oculto; prompt respirando; stage atenuado; limpiar cromos
    // de fases de celebracion/tira (§7).
    State.onEnter(States.IDLE, function () {
      window.Anim.spinner(dom.loader, false);
      window.Anim.idlePrompt(dom.idlePrompt, true);
      dom.idlePrompt.classList.remove('is-hidden');
      dom.dim.classList.add('dim--show');
      window.Anim.completo(dom.complete, false);
      window.Anim.banner(dom.stripBanner, false);
      window.Anim.revealButtons(dom.controls, false);
      window.Anim.downloadPulse(dom.btnDownload, false);
    });

    // READY: quitar la atenuacion (el anillo se dibuja en canvas). El prompt
    // puede mantenerse; reiniciamos el progreso del anillo en onEnterREADY.
    State.onEnter(States.READY, function () {
      dom.dim.classList.remove('dim--show');
      // El juego empieza al mostrar las manos: ocultar el prompt de inicio ya.
      window.Anim.idlePrompt(dom.idlePrompt, false);
      dom.idlePrompt.classList.add('is-hidden');
      onEnterREADY();
    });

    // COUNTDOWN: ocultar el prompt de idle.
    State.onEnter(States.COUNTDOWN, function () {
      window.Anim.idlePrompt(dom.idlePrompt, false);
      dom.idlePrompt.classList.add('is-hidden');
      onEnterCOUNTDOWN();
    });

    // CAPTURE: capturar el still y disparar el flash + blink de obturador (§7).
    State.onEnter(States.CAPTURE, function () {
      onEnterCAPTURE();
    });

    // PUZZLE: ocultar textos de overlay; crear y desordenar el puzzle.
    State.onEnter(States.PUZZLE, function () {
      dom.idlePrompt.classList.add('is-hidden');
      onEnterPUZZLE();
    });

    // SOLVED: revelado de cara + "COMPLETO" + confeti (§7 / §6 #15/#16/#17).
    State.onEnter(States.SOLVED, function () {
      onEnterSOLVED();
    });

    // STRIP_ADD: quitar el "COMPLETO" y lanzar B/N -> vuelo -> relleno de slot.
    State.onEnter(States.STRIP_ADD, function () {
      window.Anim.completo(dom.complete, false);
      onEnterSTRIP_ADD();
    });

    // STRIP_COMPLETE: banner + botones + pulso de descarga (§7 / §6 #21/#22/#23).
    State.onEnter(States.STRIP_COMPLETE, function () {
      onEnterSTRIP_COMPLETE();
    });
  }

  // ---------------------------------------------------------------------
  // Handlers onEnter (firmas segun CONTRACT.md §9).
  // ---------------------------------------------------------------------

  // app.onEnterREADY(): reiniciar el progreso del anillo.
  function onEnterREADY() {
    window.APP.readyRing.progress = 0;
  }

  // app.onEnterCOUNTDOWN(): fijar el valor inicial y el inicio de tick.
  function onEnterCOUNTDOWN() {
    var APP = window.APP;
    APP.countdown.value = window.CONFIG.COUNTDOWN_FROM;
    APP.countdown.tickStartedAt = window.performance.now();
    // Reiniciamos el debounce de aborto por perdida de manos al entrar.
    countdownMissedFrames = 0;
  }

  // app.onEnterCAPTURE(): capturar el still en color y disparar el flash (§7).
  function onEnterCAPTURE() {
    var APP = window.APP;
    // Still cuadrado en color (center-crop, espejado) almacenado en APP.capture.
    APP.capture = window.Camera.captureStill(dom.video);
    // Clases CSS del flash y del blink de obturador (se quitan en animationend).
    dom.flash.classList.add('flash--fire');
    dom.stage.classList.add('stage--blink');
    // Auto-limpieza al terminar las animaciones CSS (no controla la fase).
    onceAnimationEnd(dom.flash, function () {
      dom.flash.classList.remove('flash--fire');
    }, 'capture-flash');
    onceAnimationEnd(dom.stage, function () {
      dom.stage.classList.remove('stage--blink');
    }, 'stage-blink');
  }

  // app.onEnterPUZZLE(): crear el puzzle desde el still, animar shatter y luego
  // desordenar de forma resoluble (CONTRACT.md §9).
  function onEnterPUZZLE() {
    // Limpiamos el estado de debounce de gestos para que una pinza confirmada
    // en una ronda previa no se arrastre a la nueva (evita un grab fantasma al
    // entrar al puzzle). Gestures es el unico escritor de APP.hands.
    if (window.Gestures && typeof window.Gestures.resetDebounce === 'function') {
      window.Gestures.resetDebounce();
    }
    var geom = window.Puzzle.layout(stageRect());
    window.Puzzle.create(window.APP.capture.canvas, geom);
    window.Puzzle.shatterIn(function () {
      window.Puzzle.scramble();
    });
  }

  // app.onEnterSOLVED(): revelado de cara, pop de "COMPLETO" y confeti.
  function onEnterSOLVED() {
    window.Puzzle.revealSolved();
    window.Anim.completo(dom.complete, true);
    window.Anim.spawnConfetti();
  }

  // app.onEnterSTRIP_ADD(): conversion B/N -> vuelo a la tira -> relleno de slot,
  // y despues decidir STRIP_COMPLETE o volver a IDLE (cadena de callbacks §9).
  function onEnterSTRIP_ADD() {
    var gray = window.PhotoStrip.toGrayscale(window.APP.capture.canvas);
    // Guardamos el canvas gris en APP.capture para que renderPhase pueda dibujar
    // el crossfade color->gris sobre el tablero (§6 #18) usando APP.fx.crossfadeT.
    window.APP.capture.gray = gray;
    window.Anim.bwCrossfade(window.APP.capture.canvas, gray, function () {
      var i = window.PhotoStrip.nextIndex();
      window.Anim.flyToStrip(
        gray,
        stageCenterRect(),
        window.PhotoStrip.slotRect(i),
        function () {
          // Rellenar la ranura (swap a .slot--filled con rebote, §6 #20).
          window.PhotoStrip.addPhoto(gray);
          // Decidir destino: tira completa -> STRIP_COMPLETE; si no -> IDLE.
          window.State.set(
            window.PhotoStrip.isComplete()
              ? States.STRIP_COMPLETE
              : States.IDLE
          );
        }
      );
    });
  }

  // app.onEnterSTRIP_COMPLETE(): banner + revelado de botones + pulso de descarga.
  function onEnterSTRIP_COMPLETE() {
    window.Anim.banner(dom.stripBanner, true);
    window.Anim.revealButtons(dom.controls, true);
    window.Anim.downloadPulse(dom.btnDownload, true);
  }

  // ---------------------------------------------------------------------
  // app.bindButtons() -> void
  // Descargar: exporta el PNG de la tira. Reiniciar: limpia la tira, hace
  // hardReset y vuelve a IDLE (CONTRACT.md §9 / §6 tabla STRIP_COMPLETE -> IDLE).
  // ---------------------------------------------------------------------
  // Full restart usable from ANY phase: clears strip, tweens, puzzle and gesture
  // state, then FORCE-returns to IDLE (bypassing the transition table).
  function restartAll() {
    window.PhotoStrip.clear();
    if (window.Anim && typeof window.Anim.clear === 'function') {
      window.Anim.clear();
    }
    if (window.Puzzle && typeof window.Puzzle.clear === 'function') {
      window.Puzzle.clear();
    }
    window.State.hardReset();
    if (window.Gestures && typeof window.Gestures.resetDebounce === 'function') {
      window.Gestures.resetDebounce();
    }
    window.State.set(States.IDLE, true);   // force: legal desde cualquier fase
  }

  // Toggling the rail/navbar changes the stage box; re-fit the canvases by
  // re-using the existing window-resize handler.
  function reflowStage() {
    window.dispatchEvent(new Event('resize'));
  }

  function bindButtons() {
    dom.btnDownload.addEventListener('click', function () {
      window.PhotoStrip.exportPNG();
    });

    // Reiniciar de la tira (STRIP_COMPLETE) y Restart flotante: mismo efecto.
    dom.btnReset.addEventListener('click', restartAll);
    if (dom.btnRestart) {
      dom.btnRestart.addEventListener('click', restartAll);
    }

    // Toggles de vista: ocultar/mostrar la tira (historial) y la barra superior.
    if (dom.toggleRail) {
      dom.toggleRail.addEventListener('click', function () {
        dom.app.classList.toggle('hide-rail');
        reflowStage();
      });
    }
    if (dom.toggleTopbar) {
      dom.toggleTopbar.addEventListener('click', function () {
        dom.app.classList.toggle('hide-topbar');
        reflowStage();
      });
    }

    // Selector de dificultad (tamano de rejilla). Escribe APP.gridSize y reinicia
    // para que el nuevo tamano se aplique al crear el siguiente puzzle.
    var gridBtns = document.querySelectorAll('.sbtn--grid');
    Array.prototype.forEach.call(gridBtns, function (btn) {
      btn.addEventListener('click', function () {
        var n = parseInt(btn.getAttribute('data-grid'), 10);
        if (!n) { return; }
        window.APP.gridSize = n;
        Array.prototype.forEach.call(gridBtns, function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        restartAll();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Utilidad: ejecutar fn una sola vez al terminar una animacion CSS del
  // elemento, con desregistro automatico. Si reduced-motion suprime la
  // animacion (no se dispara animationend), un fallback por tiempo limpia igual.
  // ---------------------------------------------------------------------
  // animationName (opcional): si se pasa, solo reaccionamos al animationend de
  // ESA animacion disparada por el PROPIO elemento. 'animationend' burbujea, asi
  // que sin este filtro una animacion finita de un descendiente (p.ej.
  // capture-flash en #flash, descendiente de #stage) podria disparar el handler
  // antes de tiempo y quitar la clase prematuramente.
  function onceAnimationEnd(el, fn, animationName) {
    var done = false;
    function handler(e) {
      if (done) {
        return;
      }
      // Ignorar eventos burbujeados de descendientes o de otra animacion.
      if (e && (e.target !== el ||
          (animationName && e.animationName !== animationName))) {
        return;
      }
      done = true;
      el.removeEventListener('animationend', handler);
      fn();
    }
    el.addEventListener('animationend', handler);
    // Red de seguridad: si no hay animacion (reduced-motion), limpiar pronto.
    if (window.APP.reducedMotion) {
      handler();
    }
  }

  // ---------------------------------------------------------------------
  // Exponer el controlador como window.app (sin namespace de modulo formal,
  // pero accesible para que las callbacks se referencien de forma estable).
  // ---------------------------------------------------------------------
  window.app = {
    boot: boot,
    onResults: onResults,
    stageRect: stageRect,
    stageCenterRect: stageCenterRect,
    loop: loop,
    updatePhase: updatePhase,
    handlePinchInput: handlePinchInput,
    bindButtons: bindButtons,
    onEnterREADY: onEnterREADY,
    onEnterCOUNTDOWN: onEnterCOUNTDOWN,
    onEnterCAPTURE: onEnterCAPTURE,
    onEnterPUZZLE: onEnterPUZZLE,
    onEnterSOLVED: onEnterSOLVED,
    onEnterSTRIP_ADD: onEnterSTRIP_ADD,
    onEnterSTRIP_COMPLETE: onEnterSTRIP_COMPLETE
  };

  // Arranque tras DOMContentLoaded. Como los scripts usan defer, el DOM ya
  // suele estar listo; cubrimos ambos casos para no perder el evento.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
