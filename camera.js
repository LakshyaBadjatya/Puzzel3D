/* ===========================================================================
 * camera.js — PUZZLE CAM
 * ---------------------------------------------------------------------------
 * Rol de este archivo (Contrato §9):
 *   - Inicializar MediaPipe Hands + la utilidad Camera desde los globales del CDN.
 *   - Conectar el callback onResults (NO dibuja aquí: solo procesa resultados).
 *   - Capturar el fotograma actual del video como una imagen fija cuadrada
 *     (recorte centrado), reflejada para igualar la vista selfie.
 *   - Manejar con elegancia la denegación del permiso de cámara mostrando el
 *     mensaje en español (STRINGS.cameraDenied) SIN lanzar ni romper la app.
 *
 * Convenciones globales (Contrato §0):
 *   - Sin bundler, sin npm, sin módulos ES. Este archivo adjunta UN solo
 *     namespace global: window.Camera.
 *   - Escribe únicamente en APP.ready.* y APP.cameraError; lee CONFIG y STRINGS.
 *   - Usa los globales de MediaPipe: Hands, Camera (camera_utils).
 *
 * Orden de carga (Contrato §1): config → state → camera → ...
 *   Los <script> del CDN de MediaPipe van ANTES que cualquier script de la app,
 *   por lo que CONFIG, STRINGS, APP y los globales Hands/Camera ya existen.
 * =========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Colisión de nombres: el global del CDN camera_utils se llama "Camera" y este
  // módulo expone window.Camera. Capturamos el constructor REAL del CDN AHORA,
  // al inicio del IIFE, ANTES de reasignar window.Camera más abajo. En este
  // instante window.Camera todavía apunta al constructor de MediaPipe.
  // ---------------------------------------------------------------------------
  var MPCamera = (typeof window.Camera === 'function') ? window.Camera : null;

  // --- Estado interno del módulo (no expuesto fuera de este IIFE) ------------
  var mpHands = null;   // instancia de MediaPipe Hands (modelo de manos)
  var mpCamera = null;  // instancia de la utilidad Camera (bombea fotogramas)
  var videoEl = null;   // referencia al <video> #cam-video con el que trabajamos

  /**
   * Resuelve la URL de cada archivo auxiliar que MediaPipe Hands necesita cargar
   * en tiempo de ejecución (wasm, binarios del modelo, etc.). Apunta al mismo
   * paquete del CDN de jsDelivr que cargan los <script> de index.html, para
   * garantizar coherencia de versión.
   * @param {string} file - nombre del archivo solicitado por MediaPipe.
   * @returns {string} URL absoluta del archivo en el CDN.
   */
  function locateFile(file) {
    return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file;
  }

  window.Camera = {
    /**
     * Inicializa MediaPipe Hands y la cámara (Contrato §9 / §6 tabla LOADING).
     *   - new Hands({ locateFile }); setOptions { maxNumHands:2, modelComplexity:1,
     *     minDetectionConfidence:0.6, minTrackingConfidence:0.6 }
     *   - hands.onResults(onResults)
     *   - new Camera(videoEl, { onFrame, width:CAMERA_W, height:CAMERA_H })
     *
     * APP.ready.mediapipe lo fija app.onResults en los PRIMEROS resultados (no aquí).
     * APP.ready.camera se confirma en Camera.start() (cuando getUserMedia tiene éxito).
     *
     * NUNCA lanza: cualquier fallo de construcción se reporta vía APP.cameraError
     * y la promesa se resuelve igualmente, para que app.boot enrute LOADING → ERROR.
     *
     * @param {{ videoEl: HTMLVideoElement, onResults: Function }} opts
     * @returns {Promise<void>}
     */
    init: function (opts) {
      return new Promise(function (resolve) {
        try {
          videoEl = (opts && opts.videoEl) ? opts.videoEl : null;
          var onResults = (opts && opts.onResults) ? opts.onResults : function () {};

          // --- 1) Modelo Hands --------------------------------------------
          // Hands es un global del CDN (@mediapipe/hands).
          mpHands = new Hands({ locateFile: locateFile });
          mpHands.setOptions({
            maxNumHands: 2,            // dos manos: necesario para "juntar manos"
            modelComplexity: 1,        // 1 = mayor precisión que 0
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.6
          });
          // Registrar el callback de resultados (app.onResults).
          mpHands.onResults(onResults);

          // --- 2) Cámara de MediaPipe -------------------------------------
          // Usamos el constructor del CDN capturado al inicio (MPCamera).
          if (typeof MPCamera !== 'function') {
            throw new Error('El constructor Camera de MediaPipe (camera_utils) no está disponible.');
          }

          mpCamera = new MPCamera(videoEl, {
            // Cada fotograma del video se envía al modelo Hands.
            onFrame: function () {
              // Solo enviamos cuando el video ya tiene datos suficientes
              // (readyState >= 2 = HAVE_CURRENT_DATA), evitando ruido en arranque.
              if (mpHands && videoEl && videoEl.readyState >= 2) {
                return mpHands.send({ image: videoEl });
              }
            },
            width: CONFIG.CAMERA_W,
            height: CONFIG.CAMERA_H
          });

          // Construcción correcta. El acceso real a la webcam (getUserMedia)
          // ocurre en Camera.start(); allí se confirmará o se marcará el error.
          resolve();
        } catch (err) {
          // Globales del CDN ausentes u otro fallo de init: tratamos como fallo
          // de cámara, sin romper la app.
          console.warn('Camera.init: fallo al inicializar MediaPipe/cámara:', err);
          APP.ready.camera = false;
          APP.cameraError = STRINGS.cameraDenied;
          resolve();
        }
      });
    },

    /**
     * Arranca el flujo de la cámara (mpCamera.start()). Aquí el navegador pide
     * el permiso de webcam (getUserMedia). Si se deniega (o no hay dispositivo),
     * fija APP.cameraError = STRINGS.cameraDenied y RESUELVE sin lanzar, para que
     * app.boot enrute LOADING → ERROR y muestre el mensaje en español.
     * @returns {Promise<void>}
     */
    start: function () {
      return new Promise(function (resolve) {
        if (!mpCamera) {
          // No se pudo construir la cámara en init(): lo tratamos como denegado.
          APP.ready.camera = false;
          APP.cameraError = STRINGS.cameraDenied;
          resolve();
          return;
        }
        // mpCamera.start() devuelve una promesa que rechaza si getUserMedia falla.
        Promise.resolve()
          .then(function () {
            return mpCamera.start();
          })
          .then(function () {
            // Permiso concedido y flujo iniciado: cámara lista.
            APP.ready.camera = true;
            resolve();
          })
          .catch(function (err) {
            // Permiso denegado / sin cámara / dispositivo en uso, etc.
            console.warn('Camera.start: acceso a la cámara denegado o no disponible:', err);
            APP.ready.camera = false;
            APP.cameraError = STRINGS.cameraDenied;
            // Resolvemos igualmente: el enrutado del error lo decide app.boot.
            resolve();
          });
      });
    },

    /**
     * Detiene el flujo de la cámara y libera el bucle de fotogramas.
     * Seguro de llamar aunque la cámara nunca se haya iniciado.
     * @returns {void}
     */
    stop: function () {
      try {
        if (mpCamera && typeof mpCamera.stop === 'function') {
          mpCamera.stop();
        }
      } catch (err) {
        // Detener nunca debe romper la app.
        console.warn('Camera.stop: error al detener la cámara:', err);
      }
    },

    /**
     * Captura el fotograma actual del video como imagen fija EN COLOR.
     * Contrato §9 / CONFIG: lienzo offscreen CAPTURE_W x CAPTURE_H (cuadrado),
     * recorte centrado del video y REFLEJADO horizontalmente para coincidir con
     * la vista selfie (el <video> se muestra con transform: scaleX(-1)).
     *
     * El resultado lo guarda en APP.capture el llamador (app.onEnterCAPTURE);
     * este método solo lo construye y lo devuelve.
     *
     * @param {HTMLVideoElement} vEl - elemento <video> de origen.
     * @returns {{ dataURL: (string|null), canvas: HTMLCanvasElement }}
     */
    captureStill: function (vEl) {
      var source = vEl || videoEl;

      var outW = CONFIG.CAPTURE_W;
      var outH = CONFIG.CAPTURE_H;

      // Lienzo de salida cuadrado (offscreen: nunca se inserta en el DOM).
      var canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext('2d');

      // Dimensiones reales del video (caemos a CONFIG si aún no hay metadatos).
      var vw = (source && source.videoWidth) ? source.videoWidth : CONFIG.CAMERA_W;
      var vh = (source && source.videoHeight) ? source.videoHeight : CONFIG.CAMERA_H;

      // --- Recorte centrado al cuadrado más grande posible del video --------
      // Tomamos un cuadrado de lado = min(ancho, alto) centrado en el frame.
      var side = Math.min(vw, vh);
      var sx = (vw - side) / 2;  // desplazamiento X del recorte
      var sy = (vh - side) / 2;  // desplazamiento Y del recorte

      // Fondo por si el video aún no tiene fotograma (evita zonas transparentes).
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);

      // --- Reflejo horizontal (selfie) --------------------------------------
      // Espejamos el eje X una sola vez para que la foto coincida con lo que el
      // usuario ve en pantalla (el video va con scaleX(-1) por CSS).
      ctx.save();
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);

      if (source) {
        try {
          // Dibuja el recorte cuadrado del video escalado al lienzo de salida.
          ctx.drawImage(source, sx, sy, side, side, 0, 0, outW, outH);
        } catch (err) {
          // drawImage puede fallar si el video no está listo; no rompemos nada.
          console.warn('Camera.captureStill: no se pudo dibujar el video:', err);
        }
      }

      ctx.restore();

      // dataURL en color (PNG) como conveniencia; el canvas es la fuente real.
      var dataURL = null;
      try {
        dataURL = canvas.toDataURL('image/png');
      } catch (err) {
        // toDataURL puede lanzar por "tainted canvas"; degradamos con elegancia.
        console.warn('Camera.captureStill: no se pudo serializar a dataURL:', err);
        dataURL = null;
      }

      return { dataURL: dataURL, canvas: canvas };
    },

    /**
     * Utilidad opcional (Contrato §9): dibuja el fotograma actual del video,
     * REFLEJADO, dentro del contexto 2D indicado, llenando todo su lienzo.
     * No la usa el bucle principal (el <video> se muestra por CSS), pero queda
     * disponible para composiciones que necesiten el frame en un canvas.
     *
     * @param {CanvasRenderingContext2D} ctx - contexto 2D destino.
     * @returns {void}
     */
    drawVideoMirrored: function (ctx) {
      if (!ctx || !videoEl) {
        return;
      }
      var canvas = ctx.canvas;
      ctx.save();
      // Espejamos horizontalmente para igualar la vista selfie.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      try {
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        // Si el video no está listo, no hacemos nada (no rompemos el frame).
      }
      ctx.restore();
    },

    /**
     * Indica si la cámara y MediaPipe están listos.
     * Contrato §9: APP.ready.mediapipe && APP.ready.camera.
     * @returns {boolean}
     */
    isReady: function () {
      return !!(APP.ready.mediapipe && APP.ready.camera);
    }
  };

})();
