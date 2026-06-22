/* =============================================================================
 * puzzle.js — PUZZLE CAM
 * -----------------------------------------------------------------------------
 * Rompecabezas deslizante 3x3.
 *
 * Responsabilidades (segun CONTRACT.md §9):
 *   - Modelo de fichas (tiles) y geometria del tablero.
 *   - Corte de la captura en GRID*GRID sub-canvas.
 *   - Mezcla (scramble) SOLUBLE y nunca ya resuelta.
 *   - Agarre / arrastre (lerp follow) / intercambio (swap) / encaje (snap).
 *   - Deteccion de resuelto + ganchos de feedback (celda correcta / drop invalido).
 *   - Render por frame de las fichas con separaciones (gaps).
 *
 * Reglas de propiedad (CONTRACT.md §0):
 *   - Este modulo es el UNICO que ESCRIBE en APP.puzzle.
 *   - Lee CONFIG y APP.hands. Nunca cambia la fase (eso lo hace app.js via State.set).
 *   - Delega las animaciones de canvas a las fabricas de Anim.* (animations.js),
 *     que se carga ANTES que puzzle? -> NO: el orden es puzzle ANTES de animations.
 *     Por eso solo invocamos Anim.* en tiempo de ejecucion (dentro de funciones),
 *     nunca en el cuerpo de carga del modulo. Para mayor robustez comprobamos su
 *     existencia (window.Anim) antes de usarlo.
 *
 * Sin frameworks. Sin build. Vanilla JS. Comentarios en espanol.
 * ===========================================================================*/

(function () {
  'use strict';

  // --- Atajos a los singletons globales ------------------------------------
  var CONFIG = window.CONFIG;
  var APP = window.APP;

  // Referencia perezosa a Anim: como puzzle.js se carga ANTES que animations.js,
  // window.Anim aun no existe en tiempo de carga; lo resolvemos en cada llamada.
  function anim() {
    return window.Anim || null;
  }

  // ---------------------------------------------------------------------------
  // Utilidades internas
  // ---------------------------------------------------------------------------

  // Interpolacion lineal local (espejo de Anim.lerp para no depender del orden de carga).
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Tamano de rejilla ACTIVO. CONFIG.GRID esta congelado (Object.freeze), asi que
  // el selector de dificultad escribe APP.gridSize; aqui lo leemos en vivo (con
  // respaldo a CONFIG.GRID). El cambio se aplica al crear el SIGUIENTE puzzle.
  function gridN() {
    return (window.APP && APP.gridSize) ? APP.gridSize : CONFIG.GRID;
  }

  // Fila/columna de una celda lineal (0..N*N-1) en una rejilla N x N.
  function cellRow(cellIndex) {
    return Math.floor(cellIndex / gridN());
  }
  function cellCol(cellIndex) {
    return cellIndex % gridN();
  }

  // Devuelve la ficha (objeto) cuyo id coincide, o null.
  function tileById(tileId) {
    var tiles = APP.puzzle.tiles;
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].id === tileId) return tiles[i];
    }
    return null;
  }

  // Devuelve el indice de celda en el que vive ahora una ficha (su posicion en order[]).
  function cellOfTile(tileId) {
    var order = APP.puzzle.order;
    for (var c = 0; c < order.length; c++) {
      if (order[c] === tileId) return c;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Geometria del tablero
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.layout(stageRect) -> {boardX, boardY, boardSize, cellSize}
   * Fuente UNICA de la geometria del tablero. El tablero es un cuadrado centrado
   * dentro del rect del escenario (pixeles del canvas #fx-canvas).
   * No escribe en APP aqui (Puzzle.create se encarga de persistirla), solo calcula.
   */
  function layout(stageRect) {
    var w = stageRect.width;
    var h = stageRect.height;

    // Lado del tablero: cuadrado que cabe en el escenario con un pequeno margen.
    var minSide = Math.min(w, h);
    var boardSize = Math.round(minSide * 0.86);

    // Centrado dentro del escenario.
    var boardX = Math.round(stageRect.x + (w - boardSize) / 2);
    var boardY = Math.round(stageRect.y + (h - boardSize) / 2);

    // Tamano de celda (incluye su parte de gap; el gap se descuenta al dibujar).
    var cellSize = boardSize / gridN();

    return {
      boardX: boardX,
      boardY: boardY,
      boardSize: boardSize,
      cellSize: cellSize
    };
  }

  /**
   * Puzzle.cellCenter(cellIndex) -> {x, y}
   * Centro (pixeles de escenario) de la celda indicada, usando la geometria
   * actualmente guardada en APP.puzzle.
   */
  function cellCenter(cellIndex) {
    var p = APP.puzzle;
    var row = cellRow(cellIndex);
    var col = cellCol(cellIndex);
    return {
      x: p.boardX + (col + 0.5) * p.cellSize,
      y: p.boardY + (row + 0.5) * p.cellSize
    };
  }

  // ---------------------------------------------------------------------------
  // Creacion del rompecabezas (corte de la imagen)
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.create(captureCanvas, boardGeom) -> void
   * Corta el canvas de captura en GRID*GRID sub-canvas (uno por ficha) y rellena
   * APP.puzzle.tiles en orden RESUELTO (solved=true antes de mezclar).
   * Guarda boardGeom dentro de APP.puzzle.
   */
  function create(captureCanvas, boardGeom) {
    var GRID = gridN();
    var p = APP.puzzle;

    // Geometria del tablero -> APP.puzzle (fuente unica).
    p.boardX = boardGeom.boardX;
    p.boardY = boardGeom.boardY;
    p.boardSize = boardGeom.boardSize;
    p.cellSize = boardGeom.cellSize;

    // Reinicio del estado de fichas.
    p.tiles = [];
    p.order = [];
    p.solved = true;
    p.grabbedTileId = null;

    // Tamano de cada pieza de la imagen fuente (la captura es cuadrada CAPTURE_W x H,
    // pero usamos sus dimensiones reales para ser robustos).
    var srcW = captureCanvas.width;
    var srcH = captureCanvas.height;
    var pieceW = srcW / GRID;
    var pieceH = srcH / GRID;

    // Para nitidez en pantallas HiDPI, renderizamos cada sub-canvas al tamano
    // logico de la pieza fuente (suficiente; el escalado al tablero lo hace draw()).
    for (var cell = 0; cell < GRID * GRID; cell++) {
      var row = cellRow(cell);
      var col = cellCol(cell);

      // Sub-canvas de la pieza correspondiente a su CELDA CORRECTA.
      var sub = document.createElement('canvas');
      sub.width = Math.max(1, Math.round(pieceW));
      sub.height = Math.max(1, Math.round(pieceH));
      var sctx = sub.getContext('2d');
      sctx.drawImage(
        captureCanvas,
        col * pieceW, row * pieceH, pieceW, pieceH, // origen en la captura
        0, 0, sub.width, sub.height                  // destino en el sub-canvas
      );

      // Ficha en estado RESUELTO: vive en su celda correcta.
      var center = {
        x: p.boardX + (col + 0.5) * p.cellSize,
        y: p.boardY + (row + 0.5) * p.cellSize
      };

      p.tiles.push({
        id: cell,                 // id estable = celda correcta inicial
        correctCell: cell,        // a donde pertenece la ficha
        cell: cell,               // celda actual (se mantiene sincronizada con order[])
        renderX: center.x,        // centro de render actual (px escenario)
        renderY: center.y,
        scale: 1,                 // escala visual (hover/grab/pulse la modifican via Anim)
        opacity: 1,               // opacidad visual
        lifted: false,            // true mientras esta agarrada (z-top + sombra)
        hovered: false,           // true cuando el cursor pinch esta encima
        correctPulseT: 0,         // 0..1 progreso del pulso verde de celda correcta
        img: sub                  // sub-canvas con la porcion de imagen
      });

      // order[celda] = id de ficha en esa celda. En resuelto: identidad.
      p.order.push(cell);
    }
  }

  // ---------------------------------------------------------------------------
  // Shatter (split-in) — §6 #7
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.shatterIn(onDone) -> void
   * Anima la aparicion de las lineas de la rejilla y los gaps (la cara "se parte"
   * en 9 piezas). Delega el cronometraje a Anim.shatter; al terminar, llama onDone.
   */
  function shatterIn(onDone) {
    var A = anim();
    if (A && typeof A.shatter === 'function') {
      A.shatter(function () {
        if (typeof onDone === 'function') onDone();
      });
    } else {
      // Fallback sin animacion: continuamos de inmediato.
      if (typeof onDone === 'function') onDone();
    }
  }

  // ---------------------------------------------------------------------------
  // Solubilidad y mezcla (scramble) — §6 #8
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.isSolvable(order) -> boolean
   * Para un rompecabezas de intercambio puro (sin hueco vacio) de 3x3, cualquier
   * permutacion es alcanzable mediante intercambios; pero para ofrecer una mezcla
   * "agradable" usamos la paridad de inversiones como criterio canonico (numero
   * PAR de inversiones => soluble por intercambios desde la identidad de forma
   * consistente). Contamos inversiones sobre order[] (valores = ids = celda correcta).
   */
  function isSolvable(order) {
    var inversions = 0;
    for (var i = 0; i < order.length; i++) {
      for (var j = i + 1; j < order.length; j++) {
        if (order[i] > order[j]) inversions++;
      }
    }
    // Paridad par => consideramos la disposicion como "soluble"/valida.
    return inversions % 2 === 0;
  }

  /**
   * Puzzle.checkSolved() -> boolean
   * Resuelto si para toda celda i, la ficha en order[i] tiene correctCell === i.
   * Actualiza APP.puzzle.solved.
   */
  function checkSolved() {
    var p = APP.puzzle;
    var order = p.order;
    if (!order || order.length === 0) {
      p.solved = false;
      return false;
    }
    for (var i = 0; i < order.length; i++) {
      var tile = tileById(order[i]);
      if (!tile || tile.correctCell !== i) {
        p.solved = false;
        return false;
      }
    }
    p.solved = true;
    return true;
  }

  // Mezcla Fisher-Yates sobre una copia del array de ids.
  function shuffledOrder(baseIds) {
    var arr = baseIds.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // Comprueba si una disposicion candidata coincide con la solucion (identidad).
  function isSolvedOrder(order) {
    for (var i = 0; i < order.length; i++) {
      // order[i] es un id; la ficha es correcta si su correctCell === i.
      // Como id === correctCell por construccion, basta comparar order[i] === i.
      if (order[i] !== i) return false;
    }
    return true;
  }

  /**
   * Puzzle.scramble() -> void
   * Genera una permutacion SOLUBLE y NO ya resuelta, sincroniza tile.cell y lanza
   * deslizamientos escalonados (staggered slides) hacia las nuevas celdas.
   */
  function scramble() {
    var p = APP.puzzle;
    var n = p.tiles.length;
    if (n === 0) return;

    // Ids base en orden resuelto (0..n-1).
    var baseIds = [];
    for (var i = 0; i < n; i++) baseIds.push(p.tiles[i].id);

    // Re-tiramos hasta obtener una mezcla soluble y distinta de la resuelta.
    var candidate;
    var guard = 0;
    do {
      candidate = shuffledOrder(baseIds);
      guard++;
      // Salida de seguridad: tras muchos intentos, forzamos un swap valido.
      if (guard > 200) {
        candidate = baseIds.slice();
        var a = candidate[0];
        candidate[0] = candidate[1];
        candidate[1] = a;
        // Garantizamos paridad par con un segundo swap si hiciera falta.
        if (!isSolvable(candidate)) {
          var b = candidate[2];
          candidate[2] = candidate[3];
          candidate[3] = b;
        }
        break;
      }
    } while (isSolvedOrder(candidate) || !isSolvable(candidate));

    // Aplicamos la nueva disposicion al estado.
    p.order = candidate;
    p.solved = false;
    p.grabbedTileId = null;

    // Sincronizamos la celda actual de cada ficha con order[] y fijamos el
    // destino (targetX/targetY = centro de la nueva celda) que Anim.scramble
    // usara para los deslizamientos escalonados (§6 #8). Sin esto, los tweens
    // no tendrian a donde deslizar y las fichas se quedarian en su sitio.
    for (var c = 0; c < p.order.length; c++) {
      var t = tileById(p.order[c]);
      if (t) {
        t.cell = c;
        t.lifted = false;
        t.hovered = false;
        var ctrScr = cellCenter(c);
        t.targetX = ctrScr.x;
        t.targetY = ctrScr.y;
      }
    }

    // Deslizamientos escalonados hacia el nuevo destino (§6 #8).
    var A = anim();
    if (A && typeof A.scramble === 'function') {
      A.scramble(p.tiles);
    } else {
      // Fallback: colocamos las fichas directamente en su centro de celda.
      for (var k = 0; k < p.tiles.length; k++) {
        var tk = p.tiles[k];
        var ctr = cellCenter(tk.cell);
        tk.renderX = ctr.x;
        tk.renderY = ctr.y;
        tk.scale = 1;
        tk.opacity = 1;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Hit-testing (pruebas de impacto en pixeles de escenario)
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.cellAtPoint(x, y) -> cellIndex|null
   * Devuelve el indice de celda bajo el punto (px escenario), o null si esta fuera
   * del tablero.
   */
  function cellAtPoint(x, y) {
    var p = APP.puzzle;
    if (p.boardSize <= 0) return null;

    var localX = x - p.boardX;
    var localY = y - p.boardY;
    if (localX < 0 || localY < 0 || localX >= p.boardSize || localY >= p.boardSize) {
      return null; // fuera del tablero
    }

    var col = Math.floor(localX / p.cellSize);
    var row = Math.floor(localY / p.cellSize);
    if (col < 0) col = 0;
    if (row < 0) row = 0;
    if (col >= gridN()) col = gridN() - 1;
    if (row >= gridN()) row = gridN() - 1;

    return row * gridN() + col;
  }

  /**
   * nearestCell(x, y) -> cellIndex   (never null)
   * Like cellAtPoint but CLAMPS the point into the board instead of returning
   * null when it falls outside a cell / in a gap. This lets a released tile
   * always SNAP to the nearest grid cell (and swap), so dropping feels solid
   * and precise rather than springing back on a near-miss. Used by release().
   */
  function nearestCell(x, y) {
    var p = APP.puzzle;
    if (p.boardSize <= 0) return 0;
    var col = Math.floor((x - p.boardX) / p.cellSize);
    var row = Math.floor((y - p.boardY) / p.cellSize);
    if (col < 0) col = 0;
    if (row < 0) row = 0;
    if (col >= gridN()) col = gridN() - 1;
    if (row >= gridN()) row = gridN() - 1;
    return row * gridN() + col;
  }

  /**
   * Puzzle.tileAtPoint(x, y) -> tileId|null
   * Devuelve el id de la ficha que ocupa la celda bajo el punto, o null.
   */
  function tileAtPoint(x, y) {
    var cell = cellAtPoint(x, y);
    if (cell === null) return null;
    var id = APP.puzzle.order[cell];
    return (typeof id === 'number') ? id : null;
  }

  // ---------------------------------------------------------------------------
  // Interaccion: grab / drag / release — §6 #10, #11, #12, #13, #14
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.grab(tileId) -> void
   * Levanta la ficha indicada: la marca como agarrada (z-top) y delega el efecto
   * visual (escala 1.08, sombra, opacidad) a Anim.grab.
   */
  function grab(tileId) {
    var p = APP.puzzle;
    var tile = tileById(tileId);
    if (!tile) return;

    p.grabbedTileId = tileId;
    tile.lifted = true;
    tile.hovered = false; // el hover deja de aplicar mientras esta agarrada

    var A = anim();
    if (A && typeof A.grab === 'function') {
      A.grab(tile);
    } else {
      // Fallback visual.
      tile.scale = 1.08;
      tile.opacity = 0.95;
    }
  }

  /**
   * Puzzle.dragTo(x, y) -> void
   * El centro de la ficha agarrada hace lerp hacia (x, y) con factor CONFIG.LERP.
   * No mueve nada si no hay ficha agarrada.
   */
  function dragTo(x, y) {
    var p = APP.puzzle;
    if (p.grabbedTileId === null) return;
    var tile = tileById(p.grabbedTileId);
    if (!tile) return;

    var f = CONFIG.LERP; // 0.4 por contrato
    tile.renderX = lerp(tile.renderX, x, f);
    tile.renderY = lerp(tile.renderY, y, f);
  }

  /**
   * Puzzle.release(x, y) -> { swapped:boolean, targetCell:number|null }
   * Suelta la ficha agarrada en (x, y):
   *   - Si cae sobre una celda valida del tablero -> intercambia en order[] y lanza
   *     el tween de swap (§6 #12). Si alguna ficha queda en su celda correcta tras
   *     el swap, dispara el pulso de celda correcta (§6 #13).
   *   - Si cae fuera del tablero -> retroceso elastico a su origen (§6 #14).
   * En todos los casos limpia lifted/grabbedTileId.
   */
  function release(x, y) {
    var p = APP.puzzle;
    var result = { swapped: false, targetCell: null };

    if (p.grabbedTileId === null) {
      return result;
    }

    var grabbedId = p.grabbedTileId;
    var grabbedTile = tileById(grabbedId);
    var fromCell = cellOfTile(grabbedId);

    // Soltamos el estado de agarre cuanto antes (a nivel de modelo).
    p.grabbedTileId = null;

    var A = anim();
    // Snap to the NEAREST cell (clamped to the board) so a drop always lands on
    // the grid and swaps — no spring-back on a near-miss outside a cell / in a gap.
    var targetCell = nearestCell(x, y);

    if (targetCell === fromCell) {
      // --- Sin movimiento (misma celda): retroceso elastico al origen (#14) ---
      if (grabbedTile) {
        var origin = cellCenter(fromCell);
        grabbedTile.lifted = false;
        if (A && typeof A.nudgeBack === 'function') {
          A.nudgeBack(grabbedTile, origin.x, origin.y);
        } else {
          grabbedTile.renderX = origin.x;
          grabbedTile.renderY = origin.y;
          grabbedTile.scale = 1;
          grabbedTile.opacity = 1;
        }
      }
      return result; // swapped:false, targetCell:null
    }

    // --- Drop valido sobre otra celda: intercambio (#12) ----------------------
    var otherId = p.order[targetCell];
    var otherTile = tileById(otherId);

    // Intercambio en el modelo: order[] y tile.cell.
    p.order[fromCell] = otherId;
    p.order[targetCell] = grabbedId;
    if (grabbedTile) grabbedTile.cell = targetCell;
    if (otherTile) otherTile.cell = fromCell;

    // Destino de cada ficha (targetX/targetY = centro de su nueva celda) que
    // Anim.swap usara para deslizarlas y encajarlas (§6 #12). Sin esto, el
    // tween de swap no sabria a donde mover las fichas.
    if (grabbedTile) {
      var gCtr = cellCenter(grabbedTile.cell);
      grabbedTile.targetX = gCtr.x;
      grabbedTile.targetY = gCtr.y;
    }
    if (otherTile) {
      var oCtr = cellCenter(otherTile.cell);
      otherTile.targetX = oCtr.x;
      otherTile.targetY = oCtr.y;
    }

    // Estado de agarre: la ficha agarrada vuelve a apoyarse.
    if (grabbedTile) grabbedTile.lifted = false;

    result.swapped = true;
    result.targetCell = targetCell;

    // Tween de intercambio (ambas fichas deslizan a su nueva celda y encajan).
    if (A && typeof A.swap === 'function') {
      A.swap(grabbedTile, otherTile, function () {
        triggerCorrectPulses(A, grabbedTile, otherTile);
      });
    } else {
      // Fallback: encaje inmediato.
      if (grabbedTile) {
        var gc = cellCenter(grabbedTile.cell);
        grabbedTile.renderX = gc.x;
        grabbedTile.renderY = gc.y;
        grabbedTile.scale = 1;
        grabbedTile.opacity = 1;
      }
      if (otherTile) {
        var oc = cellCenter(otherTile.cell);
        otherTile.renderX = oc.x;
        otherTile.renderY = oc.y;
        otherTile.scale = 1;
        otherTile.opacity = 1;
      }
      triggerCorrectPulses(A, grabbedTile, otherTile);
    }

    return result;
  }

  /**
   * Puzzle.cancelGrab() -> void
   * Cancela el agarre actual SIN intercambiar: la ficha agarrada vuelve a su
   * celda de origen con un retroceso elastico (#14). Se usa cuando la suelta no
   * es intencional (p. ej. se pierde la mano del frame), evitando un swap
   * accidental con coordenadas obsoletas.
   */
  function cancelGrab() {
    var p = APP.puzzle;
    if (p.grabbedTileId === null || p.grabbedTileId === undefined) return;

    var grabbedId = p.grabbedTileId;
    var grabbedTile = tileById(grabbedId);
    var fromCell = cellOfTile(grabbedId);

    p.grabbedTileId = null;

    if (grabbedTile) {
      grabbedTile.lifted = false;
      var origin = cellCenter(fromCell);
      var A = anim();
      if (A && typeof A.nudgeBack === 'function') {
        A.nudgeBack(grabbedTile, origin.x, origin.y);
      } else {
        grabbedTile.renderX = origin.x;
        grabbedTile.renderY = origin.y;
        grabbedTile.scale = 1;
        grabbedTile.opacity = 1;
      }
    }
  }

  // Dispara el pulso de celda correcta (#13) para las fichas que hayan quedado bien.
  function triggerCorrectPulses(A, tileA, tileB) {
    [tileA, tileB].forEach(function (t) {
      if (t && t.cell === t.correctCell) {
        if (A && typeof A.correctPulse === 'function') {
          A.correctPulse(t);
        } else {
          t.correctPulseT = 1; // marca visual minima sin motor de animacion
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Revelado al resolver — §6 #15
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.revealSolved(onDone) -> void
   * Funde los gaps/lineas (la cara vuelve a ser entera) y hace un pulso de escala
   * del tablero. Delega a Anim.solveReveal; al terminar, onDone.
   */
  function revealSolved(onDone) {
    var A = anim();
    if (A && typeof A.solveReveal === 'function') {
      A.solveReveal(function () {
        if (typeof onDone === 'function') onDone();
      });
    } else {
      if (typeof onDone === 'function') onDone();
    }
  }

  // ---------------------------------------------------------------------------
  // Render — §6 (lado canvas de #7, #9..#15)
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.draw(ctx) -> void
   * Dibuja todas las fichas cada frame (fases PUZZLE/SOLVED) en pixeles de escenario.
   * Respeta los gaps (TILE_GAP_PX), el orden z (la ficha agarrada se dibuja al final)
   * y los efectos visuales aplicados sobre cada ficha (scale, opacity, lifted,
   * hovered, correctPulseT).
   */
  function draw(ctx) {
    var p = APP.puzzle;
    var tiles = p.tiles;
    if (!tiles || tiles.length === 0) return;

    var fullGap = CONFIG.TILE_GAP_PX || 0;

    // Progreso de "shatter" (§6 #7): 0 = imagen entera (sin gap), 1 = piezas
    // separadas con el gap completo. Por defecto 1 (sin animacion activa).
    var shatterT = (typeof p.shatterT === 'number') ? p.shatterT : 1;
    if (shatterT < 0) shatterT = 0; else if (shatterT > 1) shatterT = 1;

    // Progreso de "solve reveal" (§6 #15): revealT 1 = rejilla visible,
    // 0 = cara entera (los gaps/lineas se funden). Por defecto 1.
    var revealT = (typeof p.revealT === 'number') ? p.revealT : 1;
    if (revealT < 0) revealT = 0; else if (revealT > 1) revealT = 1;

    // El gap efectivo crece con shatterT (split-in) y decae con revealT (cierre
    // al resolver). Combinamos ambos factores 0..1.
    var gapFactor = shatterT * revealT;
    var gap = fullGap * gapFactor;

    // Lado base de la pieza dibujada (celda menos el gap por ambos lados).
    var baseSide = p.cellSize - gap * 2;
    if (baseSide < 1) baseSide = p.cellSize;

    // Pulso de escala del tablero al resolver (§6 #15). Por defecto 1.
    var boardPulse = (typeof p.boardPulse === 'number') ? p.boardPulse : 1;

    ctx.save();
    // Escalamos el tablero alrededor de su centro para el pulso de revelado.
    if (boardPulse !== 1 && p.boardSize > 0) {
      var bcx = p.boardX + p.boardSize / 2;
      var bcy = p.boardY + p.boardSize / 2;
      ctx.translate(bcx, bcy);
      ctx.scale(boardPulse, boardPulse);
      ctx.translate(-bcx, -bcy);
    }

    // Orden de dibujo: primero todas las no agarradas, luego la agarrada (z-top).
    var grabbedId = p.grabbedTileId;

    // Pasada 1: fichas normales.
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].id === grabbedId) continue;
      drawTile(ctx, tiles[i], baseSide);
    }
    // Pasada 2: ficha agarrada (encima de todo).
    if (grabbedId !== null) {
      var gt = tileById(grabbedId);
      if (gt) drawTile(ctx, gt, baseSide);
    }

    // Lineas de la rejilla 3x3 (§6 #7 "draw-in" / §6 #15 fundido). Se dibujan
    // sobre el rect del tablero con un trazo discontinuo cuyo offset depende de
    // shatterT (efecto "dibujarse"), y su alpha decae con gapFactor para fundirse
    // al resolver. Solo si hay separacion visible.
    drawGridLines(ctx, p, shatterT, gapFactor);

    ctx.restore();
  }

  // Dibuja las lineas de la rejilla 3x3 que delimitan las celdas del tablero.
  //   - shatterT controla el "draw-in" (lineDashOffset basado en (1-shatterT)).
  //   - alpha = gapFactor para que se fundan al resolver (revealT -> 0).
  function drawGridLines(ctx, p, shatterT, alpha) {
    if (alpha <= 0.001 || p.boardSize <= 0) return;
    var GLOW = (CONFIG.COLORS && CONFIG.COLORS.glowCyan) || '#00fff7';
    var GRID = gridN();
    var step = p.boardSize / GRID;

    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha) * 0.85;
    ctx.strokeStyle = GLOW;
    ctx.lineWidth = 2;
    ctx.shadowColor = GLOW;
    ctx.shadowBlur = 8;

    // Trazo discontinuo que "se dibuja" segun avanza shatterT.
    if (ctx.setLineDash) {
      var dash = Math.max(8, step * 0.5);
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = (1 - shatterT) * dash * 2;
    }

    // Lineas internas verticales y horizontales (1..GRID-1).
    for (var k = 1; k < GRID; k++) {
      var gx = p.boardX + k * step;
      var gy = p.boardY + k * step;
      ctx.beginPath();
      ctx.moveTo(gx, p.boardY);
      ctx.lineTo(gx, p.boardY + p.boardSize);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.boardX, gy);
      ctx.lineTo(p.boardX + p.boardSize, gy);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Dibuja una unica ficha aplicando escala, opacidad, sombra de levantado y
  // pulso de celda correcta. Centrada en (renderX, renderY).
  function drawTile(ctx, tile, baseSide) {
    var GLOW = (CONFIG.COLORS && CONFIG.COLORS.glowCyan) || '#00fff7';
    var GOLD = (CONFIG.COLORS && CONFIG.COLORS.gold) || '#ffcf40';
    var GREEN = (CONFIG.COLORS && CONFIG.COLORS.green) || '#1f8b3a';

    var scale = tile.scale || 1;
    var side = baseSide * scale;
    var half = side / 2;

    var cx = tile.renderX;
    var cy = tile.renderY;

    ctx.save();
    ctx.globalAlpha = (typeof tile.opacity === 'number') ? tile.opacity : 1;

    // Sombra de levantado cuando la ficha esta agarrada (#10).
    if (tile.lifted) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 22;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 10;
    }

    // Imagen de la ficha (sub-canvas) escalada al lado actual.
    if (tile.img) {
      ctx.drawImage(tile.img, cx - half, cy - half, side, side);
    } else {
      // Fallback: rectangulo solido si por alguna razon falta la imagen.
      ctx.fillStyle = '#222';
      ctx.fillRect(cx - half, cy - half, side, side);
    }

    // Quitamos sombra antes de dibujar contornos.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Contorno por hover (#9): brillo suave cian.
    if (tile.hovered && !tile.lifted) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = GLOW;
      ctx.shadowColor = GLOW;
      ctx.shadowBlur = 14;
      ctx.strokeRect(cx - half, cy - half, side, side);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    // Borde dorado tenue para la ficha agarrada (acompana al lift).
    if (tile.lifted) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = GOLD;
      ctx.strokeRect(cx - half, cy - half, side, side);
    }

    // Pulso de celda correcta (#13): borde verde + glow que decae con correctPulseT.
    var pulse = tile.correctPulseT || 0;
    if (pulse > 0) {
      ctx.globalAlpha = Math.min(1, (tile.opacity || 1)) * Math.min(1, pulse);
      ctx.lineWidth = 4;
      ctx.strokeStyle = GREEN;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 18 * pulse;
      ctx.strokeRect(cx - half, cy - half, side, side);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Limpieza
  // ---------------------------------------------------------------------------

  /**
   * Puzzle.clear() -> void
   * Vacia el estado del rompecabezas (entre rondas o en reset).
   */
  function clear() {
    var p = APP.puzzle;
    p.order = [];
    p.tiles = [];
    p.solved = false;
    p.grabbedTileId = null;
    p.boardX = 0;
    p.boardY = 0;
    p.boardSize = 0;
    p.cellSize = 0;
  }

  // ---------------------------------------------------------------------------
  // Exportacion del namespace (CONTRACT.md §9)
  // ---------------------------------------------------------------------------

  window.Puzzle = {
    layout: layout,
    create: create,
    shatterIn: shatterIn,
    scramble: scramble,
    tileAtPoint: tileAtPoint,
    cellAtPoint: cellAtPoint,
    grab: grab,
    dragTo: dragTo,
    release: release,
    cancelGrab: cancelGrab,
    checkSolved: checkSolved,
    isSolvable: isSolvable,
    cellCenter: cellCenter,
    draw: draw,
    revealSolved: revealSolved,
    clear: clear
  };
})();
