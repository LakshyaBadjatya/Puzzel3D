/* =============================================================================
 * PUZZLE CAM — config.js
 * -----------------------------------------------------------------------------
 * Única fuente de verdad para los valores ajustables (tunables) y para las
 * cadenas de texto en español de la interfaz.
 *
 * Este archivo adjunta DOS objetos congelados (Object.freeze) a window:
 *   - window.CONFIG  -> constantes de juego, umbrales de gestos, duraciones,
 *                       geometría de lienzo, colores, fuentes, etc.
 *   - window.STRINGS -> tabla de cadenas en español (brief §7).
 *
 * Convenciones globales (ver CONTRACT.md §0):
 *   - Sin empaquetador (bundler), sin npm, sin módulos ES. Cada archivo JS
 *     adjunta UN espacio de nombres global a window.
 *   - Los scripts usan "defer" y se ejecutan en el orden declarado:
 *       config -> state -> camera -> gestures -> puzzle -> animations
 *       -> photostrip -> app
 *   - config.js es el PRIMER script de la app: no depende de ningún otro
 *     módulo y no lee window.APP (que aún no existe en este punto).
 *
 * IMPORTANTE sobre REDUCED_MOTION:
 *   CONFIG.REDUCED_MOTION es solo el valor literal por defecto (false). La
 *   bandera de tiempo de ejecución que el resto del código DEBE leer es
 *   APP.reducedMotion, fijada una sola vez en el arranque por
 *   Anim.applyReducedMotion(matchMedia('(prefers-reduced-motion: reduce)').matches).
 *   No leer el literal congelado CONFIG.REDUCED_MOTION para decisiones en vivo.
 * =============================================================================
 */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * window.CONFIG — constantes ajustables (todas normativas según CONTRACT §4)
   * ------------------------------------------------------------------------- */
  window.CONFIG = Object.freeze({
    // --- puzzle / tira ---
    GRID: 3,                  // rompecabezas 3x3
    STRIP_SLOTS: 4,           // número de fotos en la tira

    // --- umbrales de gestos (landmarks normalizados 0..1) ---
    PINCH_THRESHOLD: 0.055,   // distancia pulgar(4)-índice(8) por debajo => pellizco
                              // (algo más tolerante para webcams ruidosas / baja resolución)
    JOIN_THRESHOLD:  0.18,    // distancia muñeca(0)-muñeca(0) por debajo => manos juntas
    DEBOUNCE_FRAMES: 3,       // fotogramas consecutivos antes de cambiar un gesto booleano
    LERP:            0.4,     // suavizado del seguimiento de la pieza agarrada al arrastrar
    CURSOR_LERP:     0.5,     // suavizado base del cursor (a 60 fps; ver CURSOR_SNAP_PX)
    // Por encima de esta distancia (px de stage) el cursor "engancha" más rápido al
    // objetivo para no quedar rezagado en movimientos rápidos; por debajo se suaviza
    // al máximo para matar el jitter de cámaras de baja calidad. Gestures lo usa para
    // un suavizado adaptativo e independiente de los FPS (clave para equipos lentos).
    CURSOR_SNAP_PX:  90,

    // --- cámara / MediaPipe Hands (afinado para webcams de baja calidad) ---
    // modelComplexity 0 (lite) ~ el doble de rápido que 1 en equipos lentos; los
    // gestos aquí (pellizco / dos manos) son toscos y funcionan bien con 0.
    //   'auto' => 0 en equipos de pocos núcleos (<=4) o móviles, 1 en el resto.
    // Confianzas algo más bajas para adquirir la mano en poca luz / baja resolución.
    CAMERA: Object.freeze({
      MODEL_COMPLEXITY: 'auto',       // 0 | 1 | 'auto'
      MIN_DETECTION_CONFIDENCE: 0.5,
      MIN_TRACKING_CONFIDENCE: 0.5,
      FACING_MODE: 'user'             // cámara frontal (selfie) en móviles
    }),

    // --- temporización (ms) ---
    READY_HOLD_MS:   600,     // duración del llenado del anillo manos-juntas (READY -> COUNTDOWN)
    RING_UNWIND_MS:  300,     // velocidad de decaimiento del anillo cuando las manos se separan
    COUNTDOWN_FROM:  3,       // cuenta atrás desde 3
    COUNTDOWN_TICK_MS: 1000,  // duración por número
    SOLVED_HOLD_MS:  1500,    // permanencia en SOLVED antes de STRIP_ADD

    // --- geometría de lienzo ---
    CAMERA_W: 640, CAMERA_H: 480,
    CAPTURE_W: 480, CAPTURE_H: 480,   // foto cuadrada (recorte centrado)
    TILE_GAP_PX: 3,                   // separación entre piezas del rompecabezas

    // --- salida de la tira de fotos ---
    STRIP_PHOTO_W: 220, STRIP_PHOTO_H: 220, STRIP_FRAME_PX: 12, STRIP_HEADER_PX: 60,

    // --- partículas ---
    CONFETTI_COUNT: 80,

    // --- duraciones de las animaciones por lienzo (ms) ---
    DUR: Object.freeze({
      shatter: 400, scramble: 350, scrambleStagger: 30,
      hover: 150, grab: 120, drag: 0, swap: 250,
      correct: 400, nudge: 300,
      solveGap: 300, solvePulse: 250,
      flash: 310, countdownTick: 1000,
      confetti: 1800, bw: 400, fly: 600, crossfade: 200,
      slotBounce: 350, btnRise: 350, btnStagger: 80, banner: 400
    }),

    // --- suavizados (cadenas CSS) ---
    EASES: Object.freeze({
      back:  'cubic-bezier(.34,1.56,.64,1)',
      out:   'cubic-bezier(.16,1,.3,1)',
      inout: 'ease-in-out',
      linear:'linear'
    }),

    // --- colores / fuentes ---
    COLORS: Object.freeze({
      glowCyan: '#00fff7', skeleton: '#39ff14', gold: '#ffcf40',
      green: '#1f8b3a', badgeOff: '#4a4a4a'
    }),
    FINGERTIPS: Object.freeze([4, 8, 12, 16, 20]),   // landmarks de las yemas de los dedos
    FONT_COUNTDOWN: '900 220px Inter, sans-serif',

    // --- fijado en tiempo de ejecución desde matchMedia; ver Anim.applyReducedMotion ---
    // (Solo valor por defecto. El código vivo lee APP.reducedMotion, NO este literal.)
    REDUCED_MOTION: false
  });

  /* ---------------------------------------------------------------------------
   * window.STRINGS — cadenas en español de la interfaz (brief §7)
   * ------------------------------------------------------------------------- */
  window.STRINGS = Object.freeze({
    title:        'PUZZLE CAM',
    tracking:     'TRACKING HANDS',
    noHands:      'SHOW YOUR HANDS',
    start:        'SHOW BOTH HANDS TO START',
    loading:      'LOADING…',
    solved:       'COMPLETE!',
    stripDone:    'STRIP COMPLETE — DOWNLOAD OR RESET TO CONTINUE',
    download:     'Download',
    reset:        'Reset',
    cameraDenied: 'I NEED CAMERA ACCESS TO PLAY'
  });

})();
