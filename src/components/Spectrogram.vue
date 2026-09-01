<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { LANE_DEFS } from '../lib/txMeta.js'
import FlapCounter from './FlapCounter.vue'

const props = defineProps({
  flagWindow: { type: Boolean, default: false },
})

const wrapRef = ref(null)
const propWrap = ref(null)
const closedWrap = ref(null)
const propCanvas = ref(null)
const closedCanvas = ref(null)
const ledgerShiftPx = ref(0)

const laneIndex = Object.fromEntries(LANE_DEFS.map((l, i) => [l.id, i]))
const CLOSED_DEFS = LANE_DEFS.filter((l) => l.id !== 'proposed')
const closedY0 = Math.min(...CLOSED_DEFS.map((l) => l.y0))
const closedY1 = Math.max(...CLOSED_DEFS.map((l) => l.y1))
const closedYSpan = closedY1 - closedY0 || 1

const closedLaneLabels = CLOSED_DEFS.filter((l) => l.label).map((l) => ({
  ...l,
  top: ((l.y0 - closedY0) / closedYSpan) * 100 + 0.6,
}))

const LEVELS = [
  LANE_DEFS.map((l) => l.color + '00'),
  LANE_DEFS.map((l) => l.color + '55'),
  LANE_DEFS.map((l) => l.color + '99'),
  LANE_DEFS.map((l) => l.color + 'cc'),
  LANE_DEFS.map((l) => l.color),
]

const CELL = 3
const GAP = 1
const PITCH = CELL + GAP
const SHIFT_MS = 55
const TYPICAL_CLOSE_MS = 3800
const LEDGER_COLS = Math.round(TYPICAL_CLOSE_MS / SHIFT_MS)

const proposed = {
  ctx: null,
  w: 0,
  h: 0,
  rows: 0,
  heat: null,
  tint: null,
}
const closed = {
  ctx: null,
  w: 0,
  h: 0,
  rows: 0,
  heat: null,
  tint: null,
}

let dpr = 1
let cols = 0
let raf = 0
let lastShift = 0
let ro = null
let closedBands = []
let flapId = 0
const flaps = ref([])
let lastLedgerIndex = 0
let lastLedgerPerf = 0

function idx(layer, c, r) {
  return c * layer.rows + r
}

function light(layer, c, r, lane, amt = 2) {
  if (!layer.heat || c < 0 || c >= cols || r < 0 || r >= layer.rows) return
  const i = idx(layer, c, r)
  const next = Math.min(4, layer.heat[i] + amt)
  if (next >= layer.heat[i]) layer.tint[i] = lane
  layer.heat[i] = next
}

function paintDot(layer, lane, amt) {
  const c = cols - 1
  const b = closedBands[lane]
  let r0 = 0
  let r1 = layer.rows
  if (layer === closed && b) {
    r0 = b.r0
    r1 = b.r1
  }
  const span = Math.max(1, r1 - r0)
  const r = r0 + ((Math.random() * span) | 0)
  light(layer, c, r, lane, amt)
  if (Math.random() < 0.45) {
    light(layer, c, r + (Math.random() < 0.5 ? -1 : 1), lane, 1)
  }
}

function layoutClosedBands() {
  closedBands = LANE_DEFS.map((l) => {
    if (l.id === 'proposed') return { r0: 0, r1: 1 }
    const a = (l.y0 - closedY0) / closedYSpan
    const b = (l.y1 - closedY0) / closedYSpan
    const r0 = Math.floor(a * closed.rows)
    const r1 = Math.max(r0 + 1, Math.floor(b * closed.rows))
    return { r0, r1 }
  })
}

function setupCanvas(canvas, wrap, layer) {
  if (!canvas || !wrap) return
  const nw = Math.max(320, Math.floor(wrap.clientWidth))
  const nh = Math.max(48, Math.floor(wrap.clientHeight))
  const nextRows = Math.max(8, Math.floor(nh / PITCH))
  const same =
    nw === layer.w &&
    nh === layer.h &&
    nextRows === layer.rows &&
    layer.heat &&
    layer.heat.length === cols * nextRows
  layer.w = nw
  layer.h = nh
  canvas.width = Math.floor(nw * dpr)
  canvas.height = Math.floor(nh * dpr)
  canvas.style.width = `${nw}px`
  canvas.style.height = `${nh}px`
  layer.ctx = canvas.getContext('2d', { alpha: false })
  layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  layer.ctx.imageSmoothingEnabled = false
  if (same) return false
  layer.rows = nextRows
  layer.heat = new Uint8Array(cols * layer.rows)
  layer.tint = new Uint8Array(cols * layer.rows)
  return true
}

function resize() {
  const wrap = wrapRef.value
  if (!wrap) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  const nw = Math.max(320, Math.floor(wrap.clientWidth))
  const nextCols = Math.max(8, Math.floor(nw / PITCH))
  const colsChanged = nextCols !== cols
  cols = nextCols
  ledgerShiftPx.value = LEDGER_COLS * PITCH
  const propReset = setupCanvas(propCanvas.value, propWrap.value, proposed)
  const closedReset = setupCanvas(closedCanvas.value, closedWrap.value, closed)
  if (colsChanged || closedReset) layoutClosedBands()
  if (propReset || closedReset || colsChanged) flaps.value = []
  paint()
}

function catchUp(now = performance.now()) {
  if (!lastShift) lastShift = now
  let n = 0
  while (now - lastShift >= SHIFT_MS && n < cols) {
    shift()
    lastShift += SHIFT_MS
    n++
  }
}

function pulse(p) {
  if (!proposed.heat || !closed.heat) return
  const now = performance.now()
  catchUp(now)
  if (p.kind === 'dropped') return
  if (p.kind === 'ledger') {
    const index = Number(p.index || 0)
    if (lastLedgerIndex && index > lastLedgerIndex) {
      const jumped = index - lastLedgerIndex
      const had = now - lastLedgerPerf
      if (had < TYPICAL_CLOSE_MS * 0.35 * jumped) {
        const missing = jumped * TYPICAL_CLOSE_MS - had
        const steps = Math.min(cols, Math.round(missing / SHIFT_MS))
        for (let i = 0; i < steps; i++) shift()
        lastShift += steps * SHIFT_MS
      }
    }
    lastLedgerIndex = index
    lastLedgerPerf = now
    const c = cols - 1
    const v = p.flag ? 2 : 1
    for (let r = 0; r < closed.rows; r++) {
      if (r % 2 === 0) light(closed, c, r, closed.tint[idx(closed, c, r)] || 0, v)
    }
    flaps.value = [
      ...flaps.value,
      { id: ++flapId, col: c, n: Number(p.txnCount || 0), flag: !!p.flag },
    ]
    return
  }
  const name =
    p.lane ||
    (p.kind === 'validation' ? (p.trusted ? 'validation-unl' : 'validation-other') : 'other')
  const li = laneIndex[name] ?? 4
  if (p.kind === 'validation') {
    paintDot(closed, li, 2)
    return
  }
  if (p.kind === 'tx' && !p.proposed) {
    paintDot(closed, li, 2)
    return
  }
  if (p.kind === 'tx' && p.proposed) {
    paintDot(proposed, laneIndex.proposed ?? 0, 1)
  }
}

function paintLayer(layer) {
  const ctx = layer.ctx
  if (!ctx || !layer.heat) return
  ctx.fillStyle = '#0a121c'
  ctx.fillRect(0, 0, layer.w, layer.h)
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < layer.rows; r++) {
      const v = layer.heat[idx(layer, c, r)]
      if (!v) continue
      const lane = layer.tint[idx(layer, c, r)]
      ctx.fillStyle = LEVELS[v][lane] || LEVELS[v][0]
      ctx.fillRect(c * PITCH, r * PITCH, CELL, CELL)
    }
  }
}

function paint() {
  paintLayer(proposed)
  paintLayer(closed)
  if (props.flagWindow && closed.ctx) {
    closed.ctx.fillStyle = 'rgba(255,209,102,0.12)'
    closed.ctx.fillRect((cols - 1) * PITCH, 0, CELL, closed.h)
  }
}

function shiftLayer(layer) {
  if (!layer.heat) return
  layer.heat.copyWithin(0, layer.rows)
  layer.tint.copyWithin(0, layer.rows)
  layer.heat.fill(0, (cols - 1) * layer.rows)
  layer.tint.fill(0, (cols - 1) * layer.rows)
}

function shift() {
  shiftLayer(proposed)
  shiftLayer(closed)
  if (flaps.value.length) {
    flaps.value = flaps.value
      .map((m) => ({ ...m, col: m.col - 1 }))
      .filter((m) => m.col >= 0)
  }
}

function tick(ts) {
  catchUp(ts)
  paint()
  raf = requestAnimationFrame(tick)
}

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  if (typeof ResizeObserver !== 'undefined' && wrapRef.value) {
    ro = new ResizeObserver(() => resize())
    ro.observe(wrapRef.value)
  }
  raf = requestAnimationFrame(tick)
})
onUnmounted(() => {
  window.removeEventListener('resize', resize)
  ro?.disconnect()
  cancelAnimationFrame(raf)
})

defineExpose({ pulse })
</script>

<template>
  <div ref="wrapRef" class="spec">
    <div ref="propWrap" class="pane proposed">
      <span class="pane-label" style="color: #64748b">proposed</span>
      <canvas ref="propCanvas" />
    </div>
    <div ref="closedWrap" class="pane closed">
      <div class="lanes">
        <span
          v-for="l in closedLaneLabels"
          :key="l.id"
          :style="{ color: l.color, top: l.top + '%' }"
        >
          <template v-if="l.labelParts">
            <em
              v-for="(p, i) in l.labelParts"
              :key="i"
              :style="{ color: p.color, fontStyle: 'normal' }"
            >{{ p.text }}</em>
          </template>
          <template v-else>{{ l.label }}</template>
        </span>
      </div>
      <div class="shifted" :style="{ transform: `translateX(-${ledgerShiftPx}px)` }">
        <canvas ref="closedCanvas" />
        <div class="flaps">
          <div
            v-for="m in flaps"
            :key="m.id"
            class="flap-pos"
            :style="{ left: m.col * PITCH + 'px' }"
          >
            <FlapCounter :value="m.n" :flag="m.flag" />
          </div>
        </div>
      </div>
    </div>
    <div class="legend">
      <span>top = proposed (slate)</span>
      <span>bottom = closed ledger (type color)</span>
      <span>closed is shifted ~1 ledger so it sits under its proposed window</span>
    </div>
  </div>
</template>

<style scoped>
.spec {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #0a121c;
}
.pane {
  position: relative;
  min-width: 0;
  overflow: hidden;
}
.pane.proposed {
  flex: 0 0 18%;
  min-height: 64px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.pane.closed {
  flex: 1 1 0;
  min-height: 0;
}
.pane-label {
  position: absolute;
  left: 10px;
  top: 6px;
  z-index: 3;
  font-size: 10px;
  letter-spacing: 0.08em;
  opacity: 0.55;
  font-family: 'IBM Plex Mono', monospace;
  pointer-events: none;
}
.shifted {
  position: absolute;
  inset: 0;
  will-change: transform;
}
canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.flaps {
  position: absolute;
  inset: 4px 0 auto 0;
  height: 26px;
  pointer-events: none;
  z-index: 2;
}
.flap-pos {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
}
.lanes {
  position: absolute;
  inset: 6px 0 6px 10px;
  pointer-events: none;
  z-index: 3;
}
.lanes span {
  position: absolute;
  font-size: 10px;
  letter-spacing: 0.08em;
  opacity: 0.55;
  font-family: 'IBM Plex Mono', monospace;
}
.legend {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  color: #8b9cb3;
  pointer-events: none;
  opacity: 0.75;
  z-index: 3;
}
</style>
