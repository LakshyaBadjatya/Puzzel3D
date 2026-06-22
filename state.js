/* =============================================================================
 * state.js — PUZZLE CAM
 * -----------------------------------------------------------------------------
 * Maquina de estados de un solo dueño. Define:
 *   - window.States : enum congelado con los nombres de las fases.
 *   - window.APP    : unico objeto mutable de estado compartido (singleton).
 *   - window.State  : API de la maquina de estados (set/is/elapsed/onEnter/...).
 *
 * Reglas del contrato (CONTRACT.md §0 / §5):
 *   - No hay bundler, no hay modulos ES. Este archivo adjunta sus globales a
 *     window y se ejecuta con <script defer> en el orden declarado.
 *   - El UNICO mutador de APP.phase es State.set(phase). Solo app.js lo llama.
 *   - state.js es dueño de: phase / prevPhase / phaseEnteredAt / ready /
 *     cameraError / capture / readyRing / countdown / reducedMotion / frame.
 *     (Los sub-objetos hands/puzzle/strip/fx pertenecen a otros modulos; aqui
 *      solo se declaran con su forma inicial.)
 *   - state.js lee CONFIG (para STRIP_SLOTS) y performance.now(). No importa
 *     ningun otro modulo de la app.
 *   - Un solo reloj: todos los tiempos derivan de performance.now() guardado en
 *     APP.phaseEnteredAt; los modulos usan State.elapsed().
 * ===========================================================================*/

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // §5 — Enum de fases (congelado). Los nombres son normativos.
  // ---------------------------------------------------------------------------
  window.States = Object.freeze({
    LOADING: 'LOADING',
    IDLE: 'IDLE',
    READY: 'READY',
    COUNTDOWN: 'COUNTDOWN',
    CAPTURE: 'CAPTURE',
    PUZZLE: 'PUZZLE',
    SOLVED: 'SOLVED',
    STRIP_ADD: 'STRIP_ADD',
    STRIP_COMPLETE: 'STRIP_COMPLETE',
    ERROR: 'ERROR'
  });

  var States = window.States;

  // ---------------------------------------------------------------------------
  // §5 — Tabla de transiciones legales. Se valida dentro de State.set.
  //   key = fase actual ; value = fases destino permitidas.
  // ---------------------------------------------------------------------------
  var TRANSITIONS = {
    LOADING: ['IDLE', 'ERROR'],
    IDLE: ['READY'],
    READY: ['COUNTDOWN', 'IDLE'],         // vuelve a IDLE si las manos se separan antes del hold
    COUNTDOWN: ['CAPTURE', 'IDLE'],       // vuelve a IDLE si se aborta (manos perdidas) [opcional]
    CAPTURE: ['PUZZLE'],
    PUZZLE: ['SOLVED'],
    SOLVED: ['STRIP_ADD'],
    STRIP_ADD: ['IDLE', 'STRIP_COMPLETE'],
    STRIP_COMPLETE: ['IDLE'],             // via Reiniciar
    ERROR: []
  };

  // ---------------------------------------------------------------------------
  // §5 — window.APP : la unica fuente de verdad mutable en tiempo de ejecucion.
  //   Cada sub-objeto tiene un unico modulo escritor (ver CONTRACT §0). Aqui se
  //   declara la forma inicial completa; los demas modulos rellenan lo suyo.
  // ---------------------------------------------------------------------------
  window.APP = {
    phase: States.LOADING,
    prevPhase: null,
    phaseEnteredAt: 0,                 // performance.now() al entrar; base de todas las salidas temporizadas
    frame: 0,                          // tick de rAF monotono creciente
    reducedMotion: false,

    ready: { mediapipe: false, camera: false },   // flags de gating de LOADING
    cameraError: null,                             // string|null -> pantalla de camara denegada

    hands: {                           // escrito SOLO por gestures.js
      count: 0,                        // 0|1|2 (debounced)
      raw: [],                         // multiHandLandmarks crudos de MediaPipe (para dibujar el esqueleto)
      joined: false,                   // ambas munecas dentro de JOIN_THRESHOLD (debounced)
      joinPoint: { x: 0, y: 0 },       // punto medio de las dos munecas en px de stage
      pinch: { active: false, x: 0, y: 0, justDown: false, justUp: false } // mano primaria, px de stage, bordes
    },

    readyRing: { progress: 0 },        // 0..1 relleno del anillo para READY

    countdown: { value: 0, tickStartedAt: 0 },  // numero actual 3..1 y momento de inicio del tick

    capture: { dataURL: null, canvas: null },    // still COLOR capturado de la ronda

    puzzle: {                          // escrito SOLO por puzzle.js
      order: [],                       // longitud GRID*GRID; order[indiceCelda] = tileId en esa celda
      solved: false,
      grabbedTileId: null,
      tiles: [],                       // [{ id, correctCell, cell, renderX, renderY, scale,
                                       //    opacity, lifted, hovered, correctPulseT, img }]
      boardX: 0, boardY: 0, boardSize: 0, cellSize: 0  // geometria del tablero en px de stage
    },

    strip: {                           // escrito SOLO por photostrip.js
      slots: [],                       // longitud STRIP_SLOTS: [{ filled:bool, dataURL:string|null }]
      nextIndex: 0,
      complete: false
    },

    fx: { confetti: [], flash: 0, completoT: 0, crossfadeT: 1 } // escrito SOLO por animations.js
  };

  var APP = window.APP;

  // ---------------------------------------------------------------------------
  // Registros internos de listeners onEnter/onExit, indexados por nombre de fase.
  //   _enter[fase] = [fn(prevPhase), ...]  ;  _exit[fase] = [fn(nextPhase), ...]
  // ---------------------------------------------------------------------------
  var _enter = {};
  var _exit = {};

  // Helpers internos -----------------------------------------------------------

  // now(): unico reloj de la app. Usa performance.now() si esta disponible.
  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  // stripSlots(): numero de slots de la tira leido desde CONFIG (fallback 4).
  function stripSlots() {
    return (window.CONFIG && typeof window.CONFIG.STRIP_SLOTS === 'number')
      ? window.CONFIG.STRIP_SLOTS
      : 4;
  }

  // buildSlots(): construye un arreglo fresco de slots vacios para la tira.
  function buildSlots() {
    var slots = [];
    var n = stripSlots();
    for (var i = 0; i < n; i++) {
      slots.push({ filled: false, dataURL: null });
    }
    return slots;
  }

  // ---------------------------------------------------------------------------
  // §5 — API publica: window.State
  // ---------------------------------------------------------------------------
  var State = {

    // State.init():
    //   pone phase=LOADING, phaseEnteredAt=now(), frame=0 y construye
    //   APP.strip.slots a partir de CONFIG.STRIP_SLOTS.
    init: function () {
      APP.phase = States.LOADING;
      APP.prevPhase = null;
      APP.phaseEnteredAt = now();
      APP.frame = 0;
      APP.strip.slots = buildSlots();
      APP.strip.nextIndex = 0;
      APP.strip.complete = false;
    },

    // State.set(phase):
    //   EL unico mutador de fase. Valida contra TRANSITIONS; en movimiento
    //   ilegal hace console.warn (en espanol) y devuelve false. En movimiento
    //   legal: guarda prevPhase, fija phase, reinicia phaseEnteredAt=now() y
    //   frame=0, luego dispara onExit(prev) seguido de onEnter(phase).
    //   (Los toggles de clases DOM centralizados se cablean en app.js a traves
    //    de State.onEnter, ver CONTRACT §7.)
    set: function (phase, force) {
      var prev = APP.phase;

      // Si ya estamos en esa fase no hacemos nada (evita re-disparar listeners).
      if (phase === prev) {
        return false;
      }

      // Validacion contra la tabla de transiciones. force=true la omite: lo usa
      // el boton Restart, que debe poder volver a IDLE desde CUALQUIER fase.
      if (!force) {
        var allowed = TRANSITIONS[prev] || [];
        if (allowed.indexOf(phase) === -1) {
          console.warn(
            '[State] Transicion ilegal: ' + prev + ' -> ' + phase +
            '. Permitidas desde ' + prev + ': [' + allowed.join(', ') + '].'
          );
          return false;
        }
      }

      // Mutacion oficial de la fase.
      APP.prevPhase = prev;
      APP.phase = phase;
      APP.phaseEnteredAt = now();
      APP.frame = 0;

      // Primero notificamos la salida de la fase anterior...
      _fire(_exit[prev], phase);
      // ...y luego la entrada a la nueva fase.
      _fire(_enter[phase], prev);

      return true;
    },

    // State.is(phase): true si phase coincide con la fase actual.
    is: function (phase) {
      return APP.phase === phase;
    },

    // State.elapsed(): milisegundos transcurridos desde phaseEnteredAt.
    elapsed: function () {
      return now() - APP.phaseEnteredAt;
    },

    // State.onEnter(phase, fn): registra un listener de entrada fn(prevPhase).
    onEnter: function (phase, fn) {
      if (typeof fn !== 'function') { return; }
      (_enter[phase] || (_enter[phase] = [])).push(fn);
    },

    // State.onExit(phase, fn): registra un listener de salida fn(nextPhase).
    onExit: function (phase, fn) {
      if (typeof fn !== 'function') { return; }
      (_exit[phase] || (_exit[phase] = [])).push(fn);
    },

    // State.reset():
    //   limpia los campos por-ronda: puzzle, capture, countdown, readyRing, fx.
    //   NO toca la tira (strip). Se usa entre rondas (STRIP_ADD -> IDLE).
    reset: function () {
      APP.puzzle.order = [];
      APP.puzzle.solved = false;
      APP.puzzle.grabbedTileId = null;
      APP.puzzle.tiles = [];
      APP.puzzle.boardX = 0;
      APP.puzzle.boardY = 0;
      APP.puzzle.boardSize = 0;
      APP.puzzle.cellSize = 0;

      APP.capture.dataURL = null;
      APP.capture.canvas = null;

      APP.countdown.value = 0;
      APP.countdown.tickStartedAt = 0;

      APP.readyRing.progress = 0;

      APP.fx.confetti = [];
      APP.fx.flash = 0;
      APP.fx.completoT = 0;
      APP.fx.crossfadeT = 1;
    },

    // State.hardReset():
    //   State.reset() + limpia la tira (slots vacios, nextIndex 0, complete=false).
    //   Lo usa el boton Reiniciar.
    hardReset: function () {
      State.reset();
      APP.strip.slots = buildSlots();
      APP.strip.nextIndex = 0;
      APP.strip.complete = false;
    }
  };

  // _fire(list, arg): ejecuta de forma segura una lista de listeners.
  function _fire(list, arg) {
    if (!list) { return; }
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](arg);
      } catch (err) {
        // Un listener defectuoso no debe romper la maquina de estados.
        console.warn('[State] Error en listener de fase:', err);
      }
    }
  }

  // Exponer la API.
  window.State = State;

})();
