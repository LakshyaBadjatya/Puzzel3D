/* =============================================================================
 * photostrip.js — PUZZLE CAM
 * -----------------------------------------------------------------------------
 * Rol de este módulo: conversión a blanco y negro, gestión de la tira (huecos),
 * compositado de la tira de fotomatón vertical en un canvas fuera de pantalla y
 * exportación a PNG (puzzlecam_tira_<n>.png).
 *
 * Reglas de propiedad (ver CONTRACT §0):
 *   - Este es el ÚNICO escritor de APP.strip.
 *   - Lee CONFIG y STRINGS.
 *   - NO toca APP.phase ni otros sub-objetos del estado.
 *
 * El vuelo de la foto a la tira (§6 #19) lo dispara app.js mediante
 * Anim.flyToStrip usando slotRect(i) como destino; aquí sólo exponemos la
 * geometría del hueco y la lógica de relleno/compositado.
 * ========================================================================== */

(function (window) {
  'use strict';

  // Atajos a configuración y textos (congelados en config.js).
  var CONFIG = window.CONFIG;
  var STRINGS = window.STRINGS;

  // Referencia cacheada al contenedor raíz de la tira (#strip) y a los
  // elementos .slot generados. Se rellenan en init().
  var stripRootEl = null;
  var slotEls = []; // length === CONFIG.STRIP_SLOTS

  // Cache de los canvas B&N ya rasterizados por hueco (mismo orden que slots).
  // Los canvas se dibujan de forma SÍNCRONA en composite(), evitando el
  // round-trip por un Image/dataURL (que decodifica de forma asíncrona y
  // produciría celdas en blanco en el PNG exportado).
  var slotCanvases = []; // length === CONFIG.STRIP_SLOTS, cada uno HTMLCanvasElement|null

  // ---------------------------------------------------------------------------
  // Utilidad: acceso seguro a APP.strip (lo crea state.init, pero por robustez
  // garantizamos la forma esperada antes de escribir).
  // ---------------------------------------------------------------------------
  function strip() {
    return window.APP.strip;
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.init(stripRootEl)
  //   Construye STRIP_SLOTS placeholders punteados (#20) dentro de #strip y
  //   refleja la forma de APP.strip.slots. Markup canónico por hueco (CONTRACT
  //   §2): <div class="slot slot--empty" data-index="i"><div class="slot__inner"></div></div>
  // ---------------------------------------------------------------------------
  function init(rootEl) {
    stripRootEl = rootEl;
    slotEls = [];

    if (!stripRootEl) return;

    // Limpiamos cualquier contenido previo del contenedor.
    stripRootEl.innerHTML = '';

    var n = CONFIG.STRIP_SLOTS;
    var st = strip();

    // Aseguramos el array de slots del estado con la longitud correcta.
    st.slots = [];
    st.nextIndex = 0;
    st.complete = false;

    // Reiniciamos la cache de canvas B&N (uno por hueco).
    slotCanvases = [];

    for (var i = 0; i < n; i++) {
      // Estado lógico del hueco (espejo de la UI).
      st.slots.push({ filled: false, dataURL: null });
      // Aún sin canvas B&N para este hueco.
      slotCanvases.push(null);

      // Markup del hueco vacío con su placeholder interno punteado.
      var slot = document.createElement('div');
      slot.className = 'slot slot--empty';
      slot.setAttribute('data-index', String(i));

      var inner = document.createElement('div');
      inner.className = 'slot__inner';
      slot.appendChild(inner);

      stripRootEl.appendChild(slot);
      slotEls.push(slot);
    }
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.toGrayscale(srcCanvas) -> HTMLCanvasElement (#18)
  //   Devuelve un NUEVO canvas en escala de grises por luminancia
  //   (0.299R + 0.587G + 0.114B). No modifica el canvas de origen.
  // ---------------------------------------------------------------------------
  function toGrayscale(srcCanvas) {
    var w = srcCanvas.width;
    var h = srcCanvas.height;

    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    var ctx = out.getContext('2d');

    // Copiamos el original y luego procesamos los píxeles.
    ctx.drawImage(srcCanvas, 0, 0, w, h);

    var img = ctx.getImageData(0, 0, w, h);
    var data = img.data;

    for (var p = 0; p < data.length; p += 4) {
      // Luminancia perceptual (Rec. 601).
      var lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      var g = lum | 0; // truncamos a entero
      data[p] = g;
      data[p + 1] = g;
      data[p + 2] = g;
      // alpha (data[p + 3]) se conserva
    }

    ctx.putImageData(img, 0, 0);
    return out;
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.nextIndex() -> number
  //   Índice del próximo hueco a rellenar (APP.strip.nextIndex).
  // ---------------------------------------------------------------------------
  function nextIndex() {
    return strip().nextIndex;
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.slotRect(index) -> DOMRect
  //   Rectángulo en coordenadas de viewport del hueco indicado, usado por
  //   app.js como destino del vuelo de la foto (Anim.flyToStrip). Si el índice
  //   queda fuera de rango (p.ej. tira completa), devolvemos el último hueco.
  // ---------------------------------------------------------------------------
  function slotRect(index) {
    if (!slotEls.length) {
      // Sin huecos construidos todavía: devolvemos un rect vacío seguro.
      return new DOMRect(0, 0, 0, 0);
    }
    var i = index;
    if (i < 0) i = 0;
    if (i >= slotEls.length) i = slotEls.length - 1;
    return slotEls[i].getBoundingClientRect();
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.addPhoto(bwCanvas) -> { slotIndex, slotEl }
  //   Rellena APP.strip.slots[nextIndex] con la foto B&W (como dataURL),
  //   cambia .slot--empty -> .slot--filled (rebote #20), inserta la <img> con
  //   borde blanco (look de fotomatón) y avanza nextIndex.
  // ---------------------------------------------------------------------------
  function addPhoto(bwCanvas) {
    var st = strip();
    var i = st.nextIndex;

    // Salvaguarda: si la tira ya está llena, no hacemos nada destructivo.
    if (i >= CONFIG.STRIP_SLOTS) {
      st.complete = true;
      return { slotIndex: CONFIG.STRIP_SLOTS - 1, slotEl: slotEls[CONFIG.STRIP_SLOTS - 1] || null };
    }

    // Serializamos la foto B&W a dataURL para el estado y el compositado.
    var dataURL = bwCanvas.toDataURL('image/png');

    // Actualizamos el estado lógico (único escritor de APP.strip).
    st.slots[i] = { filled: true, dataURL: dataURL };

    // Guardamos el canvas B&N ya rasterizado para el compositado síncrono del
    // PNG (evita decodificar un Image/dataURL de forma asíncrona al exportar).
    slotCanvases[i] = bwCanvas;

    // Actualizamos la UI del hueco correspondiente.
    var slotEl = slotEls[i];
    if (slotEl) {
      // Reemplazamos el contenido interno por la imagen con borde blanco.
      var inner = slotEl.querySelector('.slot__inner');
      if (inner) {
        inner.innerHTML = '';
        var img = document.createElement('img');
        img.src = dataURL;
        img.alt = ''; // decorativa
        img.className = 'slot__photo';
        inner.appendChild(img);
      }
      // Disparamos el cambio de clase: el rebote (#20) lo define
      // @keyframes slot-bounce sobre .slot--filled .slot__inner en styles.css.
      slotEl.classList.remove('slot--empty');
      slotEl.classList.add('slot--filled');
    }

    // Avanzamos el puntero al siguiente hueco libre.
    st.nextIndex = i + 1;

    return { slotIndex: i, slotEl: slotEl || null };
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.isComplete() -> boolean
  //   true cuando nextIndex >= STRIP_SLOTS. Refleja el resultado en
  //   APP.strip.complete.
  // ---------------------------------------------------------------------------
  function isComplete() {
    var st = strip();
    st.complete = st.nextIndex >= CONFIG.STRIP_SLOTS;
    return st.complete;
  }

  // ---------------------------------------------------------------------------
  // Utilidad interna: número de huecos efectivamente rellenados.
  // ---------------------------------------------------------------------------
  function filledCount() {
    var st = strip();
    var c = 0;
    for (var i = 0; i < st.slots.length; i++) {
      if (st.slots[i] && st.slots[i].filled) c++;
    }
    return c;
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.composite() -> HTMLCanvasElement
  //   Construye la tira vertical de fotomatón fuera de pantalla sobre
  //   #export-canvas (CONTRACT §11 / BRIEF §8):
  //     - banda de cabecera (STRIP_HEADER_PX de alto): "PUZZLE CAM" + caption.
  //     - N fotos en escala de grises, cada una STRIP_PHOTO_W x STRIP_PHOTO_H,
  //       con marcos/separaciones blancas de STRIP_FRAME_PX.
  //   Las fotos ya están en B&W (se guardaron grises); reaplicamos la
  //   luminancia por seguridad para garantizar el look vintage uniforme.
  // ---------------------------------------------------------------------------
  function composite() {
    var n = CONFIG.STRIP_SLOTS;
    var photoW = CONFIG.STRIP_PHOTO_W;
    var photoH = CONFIG.STRIP_PHOTO_H;
    var frame = CONFIG.STRIP_FRAME_PX;
    var header = CONFIG.STRIP_HEADER_PX;

    // Ancho total = foto + marco a cada lado.
    var totalW = photoW + frame * 2;
    // Alto total = cabecera + (marco superior + foto) por cada hueco + marco final.
    var totalH = header + frame + n * (photoH + frame);

    // Reutilizamos el canvas fuera de pantalla #export-canvas (CONTRACT §2).
    var canvas = document.getElementById('export-canvas');
    if (!canvas) {
      // Fallback robusto: si no existe en el DOM, lo creamos en memoria.
      canvas = document.createElement('canvas');
    }
    canvas.width = totalW;
    canvas.height = totalH;

    var ctx = canvas.getContext('2d');

    // --- Fondo de la tira (papel blanco/crema del fotomatón) ---
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    // --- Banda de cabecera (oscura) con título + caption ---
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, totalW, header);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Título principal "PUZZLE CAM".
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 26px Inter, Arial, sans-serif';
    ctx.fillText(STRINGS.title, totalW / 2, header * 0.42);

    // Caption pequeño debajo del título.
    ctx.fillStyle = CONFIG.COLORS.gold;
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.fillText('photo booth', totalW / 2, header * 0.74);

    // --- Fotos en escala de grises, apiladas verticalmente ---
    var st = strip();
    for (var i = 0; i < n; i++) {
      var x = frame;
      var y = header + frame + i * (photoH + frame);
      var slot = st.slots[i];

      if (slot && slot.filled && slotCanvases[i]) {
        // Hueco relleno: dibujamos el canvas B&N cacheado de forma SÍNCRONA
        // (los canvas se pintan al instante, sin decodificación asíncrona).
        drawPhotoFromCanvas(ctx, slotCanvases[i], x, y, photoW, photoH);
      } else if (slot && slot.filled && slot.dataURL) {
        // Respaldo: si no tenemos el canvas cacheado, rasterizamos el dataURL.
        drawPhotoFromDataURL(ctx, slot.dataURL, x, y, photoW, photoH);
      } else {
        // Hueco vacío: marco gris claro con borde punteado (placeholder).
        drawEmptyPlaceholder(ctx, x, y, photoW, photoH);
      }
    }

    return canvas;
  }

  // ---------------------------------------------------------------------------
  // Dibuja una foto desde un canvas YA rasterizado (B&N) dentro de (x,y,w,h).
  // Los canvas se dibujan de forma síncrona, por lo que el PNG exportado
  // contiene siempre los píxeles correctos (sin celdas en blanco). Reaplicamos
  // la luminancia por seguridad para garantizar el look vintage uniforme.
  // ---------------------------------------------------------------------------
  function drawPhotoFromCanvas(ctx, srcCanvas, x, y, w, h) {
    // Canvas intermedio para escalar y forzar grises sin alterar el original.
    var tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    var tctx = tmp.getContext('2d');

    try {
      tctx.drawImage(srcCanvas, 0, 0, w, h);
      var px = tctx.getImageData(0, 0, w, h);
      var d = px.data;
      for (var p = 0; p < d.length; p += 4) {
        var lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        var g = lum | 0;
        d[p] = g;
        d[p + 1] = g;
        d[p + 2] = g;
      }
      tctx.putImageData(px, 0, 0);
      ctx.drawImage(tmp, x, y, w, h);
    } catch (e) {
      // Respaldo: dibujamos el canvas tal cual.
      try { ctx.drawImage(srcCanvas, x, y, w, h); } catch (e2) { /* no-op */ }
    }

    // Borde interior sutil (look de foto enmarcada).
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // ---------------------------------------------------------------------------
  // Dibuja una foto desde un dataURL dentro de (x,y,w,h), forzando escala de
  // grises por luminancia para mantener el look vintage uniforme.
  //
  // Nota: el dataURL proviene de un canvas ya generado (mismo origen), por lo
  // que la imagen carga de forma síncrona-equivalente; aun así protegemos con
  // try/catch por si el navegador marcara el canvas como "tainted".
  // ---------------------------------------------------------------------------
  function drawPhotoFromDataURL(ctx, dataURL, x, y, w, h) {
    // Canvas intermedio para rasterizar el dataURL y aplicarle grises.
    var tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    var tctx = tmp.getContext('2d');

    var img = new Image();
    img.src = dataURL;

    // Como el src es un dataURL del mismo documento, ya está decodificado;
    // dibujamos inmediatamente. (decode() no es necesario para data: URIs.)
    try {
      tctx.drawImage(img, 0, 0, w, h);
      var px = tctx.getImageData(0, 0, w, h);
      var d = px.data;
      for (var p = 0; p < d.length; p += 4) {
        var lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        var g = lum | 0;
        d[p] = g;
        d[p + 1] = g;
        d[p + 2] = g;
      }
      tctx.putImageData(px, 0, 0);
      ctx.drawImage(tmp, x, y, w, h);
    } catch (e) {
      // Si algo falla, dibujamos la imagen tal cual como respaldo.
      try { ctx.drawImage(img, x, y, w, h); } catch (e2) { /* no-op */ }
    }

    // Borde interior sutil (look de foto enmarcada).
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // ---------------------------------------------------------------------------
  // Dibuja un placeholder vacío (marco gris con borde punteado) en el
  // compositado para huecos no rellenados.
  // ---------------------------------------------------------------------------
  function drawEmptyPlaceholder(ctx, x, y, w, h) {
    ctx.fillStyle = '#ececec';
    ctx.fillRect(x, y, w, h);

    ctx.save();
    ctx.strokeStyle = '#b8b8b8';
    ctx.lineWidth = 2;
    if (ctx.setLineDash) ctx.setLineDash([8, 6]);
    ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.exportPNG() -> void
  //   Composita la tira y dispara la descarga del PNG con el nombre
  //   puzzlecam_tira_<n>.png, donde <n> es el número de huecos rellenados.
  // ---------------------------------------------------------------------------
  function exportPNG() {
    var canvas = composite();
    var n = filledCount();
    var dataURL = canvas.toDataURL('image/png');

    // Creamos un enlace temporal para forzar la descarga del archivo.
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = 'puzzlecam_tira_' + n + '.png';

    // Algunos navegadores requieren que el ancla esté en el DOM para el click.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------------------------------------------------------------------------
  // PhotoStrip.clear() -> void
  //   Restablece todos los huecos a su estado punteado (transición #24 vía
  //   .slot--clearing) y reinicia APP.strip (slots vacíos, nextIndex 0,
  //   complete false). Usado por "Reiniciar".
  // ---------------------------------------------------------------------------
  function clear() {
    var st = strip();

    // Reiniciamos el estado lógico de la tira.
    for (var i = 0; i < st.slots.length; i++) {
      st.slots[i] = { filled: false, dataURL: null };
      slotCanvases[i] = null; // soltamos los canvas B&N cacheados
    }
    st.nextIndex = 0;
    st.complete = false;

    // Reiniciamos la UI hueco por hueco con la animación de limpieza (#24).
    for (var j = 0; j < slotEls.length; j++) {
      (function (slotEl) {
        if (!slotEl) return;

        var wasFilled = slotEl.classList.contains('slot--filled');

        if (wasFilled && !window.APP.reducedMotion) {
          // Marcamos como "clearing" para que @keyframes slot-clear se ejecute,
          // y al terminar restauramos el placeholder vacío.
          slotEl.classList.remove('slot--filled');
          slotEl.classList.add('slot--clearing');

          var onEnd = function () {
            slotEl.removeEventListener('animationend', onEnd);
            resetSlotToEmpty(slotEl);
          };
          slotEl.addEventListener('animationend', onEnd);

          // Salvaguarda por si animationend no dispara (animación deshabilitada).
          window.setTimeout(function () {
            if (slotEl.classList.contains('slot--clearing')) {
              slotEl.removeEventListener('animationend', onEnd);
              resetSlotToEmpty(slotEl);
            }
          }, (CONFIG.DUR && CONFIG.DUR.slotBounce ? CONFIG.DUR.slotBounce : 350) + 120);
        } else {
          // Movimiento reducido o hueco ya vacío: reset inmediato.
          slotEl.classList.remove('slot--filled');
          slotEl.classList.remove('slot--clearing');
          resetSlotToEmpty(slotEl);
        }
      })(slotEls[j]);
    }
  }

  // ---------------------------------------------------------------------------
  // Utilidad interna: devuelve un hueco a su estado vacío punteado, eliminando
  // la <img> y restaurando .slot--empty con su .slot__inner limpio.
  // ---------------------------------------------------------------------------
  function resetSlotToEmpty(slotEl) {
    slotEl.classList.remove('slot--filled');
    slotEl.classList.remove('slot--clearing');
    slotEl.classList.add('slot--empty');

    var inner = slotEl.querySelector('.slot__inner');
    if (inner) {
      inner.innerHTML = '';
    } else {
      // Si por algún motivo no existe el inner, lo recreamos.
      var newInner = document.createElement('div');
      newInner.className = 'slot__inner';
      slotEl.appendChild(newInner);
    }
  }

  // ---------------------------------------------------------------------------
  // Exposición pública del módulo (CONTRACT §9).
  // ---------------------------------------------------------------------------
  window.PhotoStrip = {
    init: init,
    toGrayscale: toGrayscale,
    nextIndex: nextIndex,
    slotRect: slotRect,
    addPhoto: addPhoto,
    isComplete: isComplete,
    composite: composite,
    exportPNG: exportPNG,
    clear: clear
  };

})(window);
