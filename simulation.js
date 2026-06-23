/* ===========================================================================
 * simulation.js — PUZZLE CAM demo / showcase autopilot
 * ---------------------------------------------------------------------------
 * Loaded ONLY by simulation.html (which sets window.SIM_MODE = true before the
 * app scripts). It lets you screen-record a showcase WITHOUT a real webcam or
 * your face:
 *
 *   1. A synthetic "avatar" face is drawn to a canvas and streamed into the
 *      #cam-video element, so the capture/puzzle uses that face — not yours.
 *   2. An autopilot generates synthetic MediaPipe-style hand landmarks and feeds
 *      them through the REAL gesture pipeline (window.app.onResults). So the demo
 *      drives the actual game logic: show both hands -> 3-2-1 -> capture ->
 *      scramble -> auto-solve tile by tile -> photo strip -> restart, forever.
 *
 * No webcam permission, no MediaPipe download — pure synthetic input. Everything
 * you see (skeleton, cursor, animations) is the genuine app reacting to it.
 * =========================================================================== */

(function () {
  'use strict';
  if (!window.SIM_MODE) { return; }

  var CONFIG = window.CONFIG;
  var video = document.getElementById('cam-video');

  // -------------------------------------------------------------------------
  // 1) Synthetic avatar face -> MediaStream -> #cam-video
  // -------------------------------------------------------------------------
  var av = document.createElement('canvas');
  av.width = 480; av.height = 480;
  var actx = av.getContext('2d');

  function drawAvatar(t) {
    // Fondo
    var g = actx.createLinearGradient(0, 0, 0, 480);
    g.addColorStop(0, '#33485c'); g.addColorStop(1, '#1d2935');
    actx.fillStyle = g; actx.fillRect(0, 0, 480, 480);

    // Hombros
    actx.fillStyle = '#b8543f';
    actx.beginPath(); actx.ellipse(240, 520, 200, 130, 0, 0, Math.PI * 2); actx.fill();

    // Cara
    actx.fillStyle = '#e8c2a0';
    actx.beginPath(); actx.ellipse(240, 250, 118, 150, 0, 0, Math.PI * 2); actx.fill();

    // Pelo
    actx.fillStyle = '#33241c';
    actx.beginPath(); actx.ellipse(240, 150, 132, 96, 0, Math.PI, 2 * Math.PI); actx.fill();
    actx.fillRect(108, 150, 264, 40);

    // Ojos (parpadeo periodico)
    var blink = (Math.sin(t / 760) > 0.94);
    var eyeH = blink ? 2 : 15;
    actx.fillStyle = '#ffffff';
    actx.beginPath();
    actx.ellipse(198, 238, 24, eyeH, 0, 0, Math.PI * 2);
    actx.ellipse(282, 238, 24, eyeH, 0, 0, Math.PI * 2);
    actx.fill();
    if (!blink) {
      actx.fillStyle = '#2a2a2a';
      actx.beginPath();
      actx.arc(198, 238, 8, 0, Math.PI * 2);
      actx.arc(282, 238, 8, 0, Math.PI * 2);
      actx.fill();
    }

    // Cejas
    actx.strokeStyle = '#33241c'; actx.lineWidth = 7; actx.lineCap = 'round';
    actx.beginPath(); actx.moveTo(172, 205); actx.lineTo(224, 200); actx.stroke();
    actx.beginPath(); actx.moveTo(256, 200); actx.lineTo(308, 205); actx.stroke();

    // Nariz + sonrisa
    actx.strokeStyle = '#c69a78'; actx.lineWidth = 5;
    actx.beginPath(); actx.moveTo(240, 250); actx.lineTo(232, 285); actx.lineTo(248, 285); actx.stroke();
    actx.strokeStyle = '#7a4a3a'; actx.lineWidth = 7;
    actx.beginPath(); actx.arc(240, 300, 46, 0.15 * Math.PI, 0.85 * Math.PI); actx.stroke();

    // Etiqueta
    actx.fillStyle = 'rgba(255,255,255,0.55)';
    actx.font = 'bold 20px Inter, sans-serif';
    actx.textAlign = 'center';
    actx.fillText('DEMO AVATAR', 240, 452);
  }
  drawAvatar(0);

  try {
    video.srcObject = av.captureStream(30);
    var pr = video.play();
    if (pr && pr.catch) { pr.catch(function () {}); }
  } catch (e) {
    console.warn('[sim] no se pudo iniciar la pista sintetica:', e);
  }

  // -------------------------------------------------------------------------
  // 2) Synthetic hand: 21 landmarks (normalized, un-mirrored MediaPipe space)
  // -------------------------------------------------------------------------
  // Canonical open right-ish hand, palm to camera, fingers up. Only indices
  // 0 (wrist), 4 (thumb tip) and 8 (index tip) matter for gesture logic; all 21
  // are provided so drawSkeleton renders a full hand.
  var HAND = [
    { x: 0.000, y: 0.100 }, // 0 wrist
    { x: -0.050, y: 0.060 }, // 1 thumb
    { x: -0.080, y: 0.030 }, // 2
    { x: -0.085, y: 0.000 }, // 3
    { x: -0.070, y: -0.020 }, // 4 thumb tip (OPEN)
    { x: -0.025, y: 0.000 }, // 5 index
    { x: -0.028, y: -0.040 }, // 6
    { x: -0.030, y: -0.080 }, // 7
    { x: -0.030, y: -0.115 }, // 8 index tip
    { x: 0.000, y: 0.000 }, // 9 middle
    { x: 0.000, y: -0.050 }, // 10
    { x: 0.000, y: -0.100 }, // 11
    { x: 0.000, y: -0.135 }, // 12
    { x: 0.028, y: 0.005 }, // 13 ring
    { x: 0.030, y: -0.045 }, // 14
    { x: 0.032, y: -0.090 }, // 15
    { x: 0.032, y: -0.120 }, // 16
    { x: 0.055, y: 0.020 }, // 17 pinky
    { x: 0.062, y: -0.020 }, // 18
    { x: 0.064, y: -0.050 }, // 19
    { x: 0.064, y: -0.078 }  // 20
  ];
  var THUMB_PINCH = { x: -0.015, y: -0.100 }; // pt4 near pt8 => pinchDistance < threshold

  // Build a 21-point hand whose pinch midpoint (avg of 4 & 8) sits at the given
  // NORMALIZED point (cx, cy), open or pinched.
  function buildHand(cx, cy, pinch, scale) {
    scale = scale || 1.0;
    var p4 = pinch ? THUMB_PINCH : HAND[4];
    var p8 = HAND[8];
    var midx = (p4.x + p8.x) / 2;
    var midy = (p4.y + p8.y) / 2;
    var out = [];
    for (var i = 0; i < HAND.length; i++) {
      var src = (i === 4) ? p4 : HAND[i];
      out.push({ x: cx + (src.x - midx) * scale, y: cy + (src.y - midy) * scale });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 3) Inverse of Gestures.toStage: stage-pixel point -> normalized landmark.
  //    Lets us place the pinch cursor exactly on a tile/cell.
  // -------------------------------------------------------------------------
  function stageToNorm(sx, sy) {
    var rect = window.app.stageRect();
    // Usamos la MISMA fuente de tamaño de frame que toStage() (Gestures.frameSize)
    // para que el inverso quede perfectamente alineado aunque cambie el aspecto.
    var fs = (window.Gestures && typeof window.Gestures.frameSize === 'function')
      ? window.Gestures.frameSize()
      : { w: CONFIG.CAMERA_W, h: CONFIG.CAMERA_H };
    var camW = fs.w, camH = fs.h;
    var scale = Math.max(rect.width / camW, rect.height / camH);
    var dispW = camW * scale, dispH = camH * scale;
    var offX = (rect.width - dispW) / 2, offY = (rect.height - dispH) / 2;
    var nxM = (sx - rect.x - offX) / dispW;
    var ny = (sy - rect.y - offY) / dispH;
    return { x: 1 - nxM, y: ny }; // un-mirror X
  }

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  // -------------------------------------------------------------------------
  // 4) Autopilot
  // -------------------------------------------------------------------------
  var sim = {
    prevPhase: null,
    step: 'idle',     // idle | move | grab | drag | release | settle
    stepStart: 0,
    fromCell: 0,
    toCell: 0,
    startSx: 0, startSy: 0, // cursor start for the 'move' tween (stage px)
    lastSx: 0, lastSy: 0,   // last cursor (stage px)
    restartAt: 0
  };
  var DUR = { move: 520, grab: 300, drag: 680, release: 320, settle: 360 };

  function cellCenter(c) { return window.Puzzle.cellCenter(c); }

  // Smallest cell index whose tile is not the one that belongs there.
  function nextWrongCell() {
    var order = window.APP.puzzle.order;
    for (var c = 0; c < order.length; c++) {
      if (order[c] !== c) { return c; }
    }
    return -1;
  }

  // Returns the synthetic results for the PUZZLE phase (one solving hand).
  function solveStep(t) {
    var p = window.APP.puzzle;
    if (!p.tiles || p.tiles.length === 0) {
      return oneHand(0.5, 0.55, false); // waiting for scramble
    }

    if (sim.step === 'idle') {
      var c = nextWrongCell();
      if (c === -1) {
        // Solved (or about to transition). Idle hand near the board.
        return oneHand(0.5, 0.55, false);
      }
      sim.toCell = c;
      sim.fromCell = p.order.indexOf(c); // where the tile that belongs at c lives
      sim.step = 'move';
      sim.stepStart = t;
      sim.startSx = sim.lastSx || cellCenter(sim.fromCell).x;
      sim.startSy = sim.lastSy || cellCenter(sim.fromCell).y;
    }

    var src = cellCenter(sim.fromCell);
    var dst = cellCenter(sim.toCell);
    var el = t - sim.stepStart;
    var sx, sy, pinch;

    if (sim.step === 'move') {
      var k = easeInOut(clamp01(el / DUR.move));
      sx = sim.startSx + (src.x - sim.startSx) * k;
      sy = sim.startSy + (src.y - sim.startSy) * k;
      pinch = false;
      if (el >= DUR.move) { sim.step = 'grab'; sim.stepStart = t; }
    } else if (sim.step === 'grab') {
      sx = src.x; sy = src.y; pinch = true;
      if (el >= DUR.grab) { sim.step = 'drag'; sim.stepStart = t; }
    } else if (sim.step === 'drag') {
      var k2 = easeInOut(clamp01(el / DUR.drag));
      sx = src.x + (dst.x - src.x) * k2;
      sy = src.y + (dst.y - src.y) * k2;
      pinch = true;
      if (el >= DUR.drag) { sim.step = 'release'; sim.stepStart = t; }
    } else if (sim.step === 'release') {
      sx = dst.x; sy = dst.y; pinch = false; // opening => justUp => swap
      if (el >= DUR.release) { sim.step = 'settle'; sim.stepStart = t; }
    } else { // settle
      sx = dst.x; sy = dst.y; pinch = false;
      if (el >= DUR.settle) { sim.step = 'idle'; }
    }

    sim.lastSx = sx; sim.lastSy = sy;
    var n = stageToNorm(sx, sy);
    return oneHand(n.x, n.y, pinch);
  }

  function oneHand(nx, ny, pinch) {
    return {
      multiHandLandmarks: [buildHand(nx, ny, pinch, 1.0)],
      multiHandedness: [{ label: 'Right', score: 1 }]
    };
  }

  function twoHands(t) {
    var bob = Math.sin(t / 480) * 0.02;
    return {
      multiHandLandmarks: [
        buildHand(0.34, 0.50 + bob, false, 1.0),
        buildHand(0.66, 0.50 - bob, false, 1.0)
      ],
      multiHandedness: [{ label: 'Left', score: 1 }, { label: 'Right', score: 1 }]
    };
  }

  function noHands() { return { multiHandLandmarks: [], multiHandedness: [] }; }

  function maybeRestart(t) {
    if (!sim.restartAt) {
      sim.restartAt = t + 2600; // admire the finished strip, then loop
    } else if (t >= sim.restartAt) {
      sim.restartAt = 0;
      var b = document.getElementById('btn-restart');
      if (b) { b.click(); }
    }
  }

  // Main autopilot loop: synth input every frame -> real gesture pipeline.
  function tick(t) {
    drawAvatar(t);

    var phase = window.APP.phase;
    if (phase !== sim.prevPhase) {
      if (phase === 'PUZZLE') { sim.step = 'idle'; sim.lastSx = 0; sim.lastSy = 0; }
      if (phase !== 'STRIP_COMPLETE') { sim.restartAt = 0; }
      sim.prevPhase = phase;
    }

    var results;
    switch (phase) {
      case 'PUZZLE':
        results = solveStep(t);
        break;
      case 'SOLVED':
      case 'STRIP_ADD':
        results = noHands(); // hands away while it celebrates / files the photo
        break;
      case 'STRIP_COMPLETE':
        maybeRestart(t);
        results = noHands();
        break;
      default: // LOADING / IDLE / READY / COUNTDOWN / CAPTURE -> present both hands
        results = twoHands(t);
        break;
    }

    if (window.app && typeof window.app.onResults === 'function') {
      window.app.onResults(results);
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
