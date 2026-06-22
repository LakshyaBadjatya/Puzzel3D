# PUZZLE CAM — Build Brief

> A gesture-controlled webcam photo-booth game. The webcam captures your face, shatters it
> into a sliding-tile puzzle, you solve it with your hands (no mouse, no keyboard), and each
> solved photo drops into a vintage black-&-white photo-booth strip you can download.
> Reconstructed from the @mishu.ksv Instagram reel (DZ1YQ4HtCHy). UI language: **Spanish**.

---

## 1. Product summary

A single-page, **frontend-only** web app (no backend, no build step) that runs on a static
server such as VS Code **Live Server** (`127.0.0.1:5500`). It uses **MediaPipe Hands** to track
the player's hands through the webcam and turns hand gestures into the only input device.

Core loop:
1. Camera opens, MediaPipe tracks hands (animated skeletal overlay).
2. Player **joins both hands together** to start a round.
3. A **3 → 2 → 1 countdown** plays over the live face.
4. The app **captures a still** of the face (white flash).
5. The still **shatters into a 3×3 sliding puzzle** and scrambles.
6. Player **pinches** to grab tiles and drags/swaps them to solve the face.
7. On solve: **"¡COMPLETO!"** celebration + falling-papers/confetti.
8. The solved photo is converted to **B&W and dropped into a photo-booth strip** on the right.
9. Repeat until the strip is full (default **4 photos**).
10. **"TIRA COMPLETA"** — player can **download** the strip PNG or **reset** to start over.

---

## 2. Tech stack (hard constraints)

- **Vanilla** HTML + CSS + JavaScript only. No frameworks, no bundler, no npm. Must run by
  opening `index.html` on a static server.
- **MediaPipe Hands** via CDN (jsDelivr):
  - `https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js`
  - `https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js`
  - `https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js`
  - Globals exposed: `Hands`, `HAND_CONNECTIONS`, `Camera`, `drawConnectors`, `drawLandmarks`.
- `<canvas>` for the camera composite, the puzzle board, and the photo-strip compositing.
- All rendering driven by a single `requestAnimationFrame` loop in the app controller.
- Graceful failure if camera permission is denied (show a Spanish message, don't crash).

---

## 3. Screen layout

```
┌───────────────────────────────────────────────────────────┐
│  PUZZLE CAM            [● MANOS EN SEGUIMIENTO]   (top bar) │
├──────────────────────────────────────────┬────────────────┤
│                                           │   TIRA (strip) │
│        STAGE (video + canvas overlay)     │  ┌──────────┐  │
│        - live webcam (mirrored)           │  │ photo 1  │  │
│        - hand skeleton overlay            │  ├──────────┤  │
│        - countdown / puzzle / flash       │  │ photo 2  │  │
│        - prompt text                      │  ├──────────┤  │
│                                           │  │  empty   │  │
│                                           │  ├──────────┤  │
│                                           │  │  empty   │  │
│                                           │  └──────────┘  │
│                                           │ [Descargar]    │
│                                           │ [Reiniciar]    │
└──────────────────────────────────────────┴────────────────┘
```

- **Top bar:** app title "PUZZLE CAM" (left); a **status badge** (right) that reads
  `MANOS EN SEGUIMIENTO` and glows green when ≥1 hand is detected, dims grey when none.
- **Stage:** the webcam video is **mirrored** (selfie view). A transparent canvas sits on top
  for the hand skeleton, countdown, puzzle and effects.
- **Strip rail (right):** the vintage photo-booth strip with N slots (default 4) plus the
  Descargar (Download) and Reiniciar (Reset) buttons.

---

## 4. State machine

States: `LOADING → IDLE → READY → COUNTDOWN → CAPTURE → PUZZLE → SOLVED → STRIP_ADD → (loop to IDLE) → STRIP_COMPLETE`

| State | Meaning | Enter animation | Exit trigger |
|-------|---------|-----------------|--------------|
| `LOADING` | MediaPipe/camera initializing | spinner + "CARGANDO…" | models ready |
| `IDLE` | waiting for hands | dimmed stage, pulsing prompt "JUNTA LAS MANOS PARA EMPEZAR" | hands joined |
| `READY` | hands joined, locking in | prompt swaps, ring fills | 0.6s hold → countdown |
| `COUNTDOWN` | 3-2-1 over face | number zoom-in/out per tick | reaches 0 |
| `CAPTURE` | grab the frame | full-screen white flash | flash done |
| `PUZZLE` | solve the 3×3 | shatter + scramble | all tiles correct |
| `SOLVED` | celebrate | "¡COMPLETO!" pop + confetti | 1.5s |
| `STRIP_ADD` | photo flies to strip | photo flies + B&W fade | strip not full → IDLE |
| `STRIP_COMPLETE` | strip full | "TIRA COMPLETA" + buttons in | Download / Reset |

---

## 5. Gestures (MediaPipe Hands, normalized landmarks 0..1)

- **Join hands (start):** two hands detected AND distance between the two wrists (landmark 0)
  below a threshold (~0.18 of frame width). Triggers `IDLE → READY`.
- **Pinch (grab):** on one hand, distance between thumb tip (4) and index tip (8) below
  threshold (~0.05). Pinch midpoint is the cursor. Pinch-down grabs the tile under the cursor.
- **Drag:** while pinched, the grabbed tile follows the pinch midpoint (smoothed with lerp).
- **Release (drop/swap):** pinch distance rises above threshold → drop the tile; if it overlaps
  another tile's cell, **swap** them; snap to grid.
- Coordinates must be **un-mirrored** to match the mirrored video so the cursor lines up.
- Debounce gesture state changes (a few frames) to avoid jitter/false triggers.

---

## 6. ANIMATIONS — full catalogue (the heart of this brief)

Each must be implemented. Prefer CSS `@keyframes`/transitions for DOM, canvas tweening for
board/effects. Suggested durations/easing in parentheses — tune for feel.

### Tracking & idle
1. **Hand skeleton overlay** — every frame, draw `HAND_CONNECTIONS` connectors + 21 landmark
   dots over the video; lines glow cyan/green, dots slightly larger at fingertips. Real-time,
   follows the hand with no perceptible lag.
2. **Status badge pulse** — when hands present, the `●` dot pulses (scale 1→1.25→1, 1.2s loop)
   and the badge background fades from grey to green (0.3s).
3. **Idle prompt breathing** — "JUNTA LAS MANOS PARA EMPEZAR" text gently pulses opacity
   0.55↔1 and scale 1↔1.04 (1.6s ease-in-out loop). Stage is slightly dimmed (overlay 25%).
4. **Hands-joined ring fill** — when hands come together, a circular progress ring draws around
   the join point over 0.6s; if held, it completes and fires the countdown; if hands separate,
   the ring unwinds.

### Countdown & capture
5. **Countdown numbers** — "3", "2", "1" each: zoom-in from scale 0.3→1 with fade-in (0.25s),
   hold (0.5s), then zoom-out 1→1.6 with fade-out (0.25s). Big, centered, with soft drop shadow.
   Optional thin sweeping ring per second.
6. **Capture flash** — full-stage white rectangle, opacity 0→1 (60ms) then 1→0 (250ms), with a
   subtle shutter "blink" (stage scales 0.98 momentarily). A faint shutter-click is optional.

### Puzzle
7. **Shatter / split-in** — the captured still is drawn whole, then 3×3 grid lines **draw in**
   (stroke dash animation ~0.4s) and each tile gets a thin gap (tiles inset by 2–3px) so the
   image visibly breaks into 9 pieces.
8. **Scramble** — tiles animate from solved positions to shuffled positions; staggered slide
   (each tile eases to its new cell over ~0.35s, 30ms stagger). Guarantee the scramble is
   **solvable** and not already solved.
9. **Tile hover/target highlight** — when the pinch cursor is over a tile, that tile scales to
   1.05 and shows a soft outline glow (0.15s ease).
10. **Tile grab** — on pinch-down the grabbed tile lifts: scale 1.08, raised drop shadow,
    z-order on top, slight opacity 0.95.
11. **Tile drag follow** — grabbed tile center lerps toward the pinch midpoint each frame
    (lerp factor ~0.4) so motion is smooth, not snappy.
12. **Tile swap/snap** — on release, the grabbed tile and the tile in the target cell slide to
    swap cells (ease-out ~0.25s) and snap to grid.
13. **Correct-cell feedback** — when a tile lands in its correct cell, a brief green border
    pulse + soft glow (0.4s), then settles.
14. **Wrong drop nudge** — if a move is illegal (out of board), the tile springs back to its
    origin with a small overshoot (ease-back ~0.3s).

### Solve & strip
15. **Solve reveal** — on completion, grid gaps/lines fade out (0.3s) so the face becomes whole
    again; a quick full-board scale pulse 1→1.03→1.
16. **"¡COMPLETO!" pop** — text pops in: scale 0.5→1.15→1 with fade (0.4s, ease-back), gold
    color + glow, holds ~1s.
17. **Falling papers / confetti** — celebratory particles (small white/cream rectangles like
    little photos, plus optional colored confetti) fall from the top with random x, rotation
    and speed, fading near the bottom; lasts ~1.5–2s. (This is the falling-squares effect seen
    at the end of the reel.)
18. **B&W conversion** — the solved color photo crossfades to grayscale (0.4s) before it goes
    into the strip (the strip is vintage black-&-white).
19. **Photo-fly-to-strip** — a thumbnail of the solved B&W photo animates from the stage to its
    target slot in the strip rail: translate + scale-down along an eased path (~0.6s), then the
    slot "fills" (placeholder → photo) with a small bounce.
20. **Strip slot fill / progress** — empty slots show a dashed placeholder; on fill they get a
    subtle inner shadow + the photo with a thin white border (photo-booth look).

### Strip complete
21. **"TIRA COMPLETA" banner** — slides/fades in over the strip ("TIRA COMPLETA — DESCARGA O
    REINICIA PARA SEGUIR").
22. **Buttons reveal** — "Descargar" and "Reiniciar" buttons fade + rise into place (stagger
    80ms), with hover (lift + shadow) and active (press 0.97) states.
23. **Download pulse** — the Descargar button gently pulses to draw attention until clicked.
24. **Reset transition** — on Reiniciar, the strip photos fade/clear, slots reset to dashed
    placeholders, app returns to `IDLE` with the idle prompt breathing again.

### Global / polish
25. **State crossfades** — switching stage content (countdown → puzzle → solved) crossfades
    (0.2s) rather than hard-cutting.
26. **Loading spinner** — while MediaPipe loads: a rotating ring + "CARGANDO…".
27. **Reduced-motion** — respect `prefers-reduced-motion`: shorten/disable non-essential
    animations (confetti, pulses) but keep functional feedback.

---

## 7. Spanish UI strings

| Key | Text |
|-----|------|
| title | `PUZZLE CAM` |
| tracking | `MANOS EN SEGUIMIENTO` |
| noHands | `MUESTRA TUS MANOS` |
| start | `JUNTA LAS MANOS PARA EMPEZAR` |
| loading | `CARGANDO…` |
| solved | `¡COMPLETO!` |
| stripDone | `TIRA COMPLETA — DESCARGA O REINICIA PARA SEGUIR` |
| download | `Descargar` |
| reset | `Reiniciar` |
| cameraDenied | `NECESITO ACCESO A LA CÁMARA PARA JUGAR` |

---

## 8. Photo-strip output

- Composite an off-screen canvas: vertical strip, N B&W photos stacked with white frames/gaps,
  a header strip ("PUZZLE CAM" + a small caption), rounded corners optional.
- Export via `canvas.toDataURL('image/png')` → download as `puzzlecam_tira_<n>.png`.
- Apply grayscale to each photo when compositing (luminance: 0.299R+0.587G+0.114B).

---

## 9. Tunable config (single source of truth)

`GRID = 3` (3×3), `STRIP_SLOTS = 4`, `PINCH_THRESHOLD = 0.05`, `JOIN_THRESHOLD = 0.18`,
`COUNTDOWN_FROM = 3`, `LERP = 0.4`, gesture debounce frames, animation durations.

---

## 10. Acceptance criteria

- Opens on a static server, no console errors on load (camera-permission failure handled).
- Hand skeleton tracks in real time; status badge reflects hand presence.
- Joining hands starts a round; 3-2-1 countdown plays; flash fires; face is captured.
- Face splits into a scrambled, solvable 3×3 puzzle; tiles are grabbable/draggable/swappable by
  pinch only; solved state is detected.
- Solve triggers ¡COMPLETO!, confetti/falling papers, B&W conversion, and fly-to-strip.
- Strip fills to 4; TIRA COMPLETA shows; Descargar exports a PNG; Reiniciar restarts cleanly.
- Every animation in §6 is present and visibly working.
- Spanish strings throughout. Code commented in Spanish to match the original.
