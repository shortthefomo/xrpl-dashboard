<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { LANE_DEFS } from '../lib/txMeta.js'
import FlapCounter from './FlapCounter.vue'

const props = defineProps({
  flagWindow: { type: Boolean, default: false },
})

const canvasRef = ref(null)
const wrapRef = ref(null)

const laneIndex = Object.fromEntries(LANE_DEFS.map((l, i) => [l.id, i]))

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

let ctx = null
let w = 0
let h = 0
let dpr = 1
let cols = 0
let rows = 0
let heat = null // Uint8Array cols * rows, 0-4
let tint = null // Uint8Array lane id
let raf = 0
let lastShift = 0
const SHIFT_MS = 55
// Mainnet closes ~3.8s. ledger_time/close_time is rounded to 10s buckets
// (close_time_resolution) so it must not drive column spacing.
const TYPICAL_CLOSE_MS = 3800
// Empty columns between a closed ledger and the next proposed cloud.
const CLOSE_GAP_COLS = Math.max(10, Math.round((TYPICAL_CLOSE_MS / SHIFT_MS) * 0.18))
let ro = null
let bandRows = []
let flapId = 0
const flaps = ref([]) // { id, col, n, flag }
const proposedMarks = new Map() // hash -> { col, r, r2 }
const ledgerCol = new Map() // closed ledger index -> col
const openSeenCol = new Map() // open ledger index -> first column seen

function layoutBands() {
  bandRows = LANE_DEFS.map((l) => {
    const r0 = Math.floor(l.y0 * rows)
    const r1 = Math.max(r0 + 1, Math.floor(l.y1 * rows))
    return { r0, r1 }
  })
}

function resize() {
  const canvas = canvasRef.value
  const wrap = wrapRef.value
  if (!canvas || !wrap) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  const nw = Math.max(320, Math.floor(wrap.clientWidth))
  const nh = Math.max(180, Math.floor(wrap.clientHeight))
  const nextCols = Math.max(8, Math.floor(nw / PITCH))
  const nextRows = Math.max(8, Math.floor(nh / PITCH))
  const same = nw === w && nh === h && nextCols === cols && nextRows === rows
  w = nw
  h = nh
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  ctx = canvas.getContext('2d', { alpha: false })
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  if (same && heat) {
    paint()
    return
  }
  cols = nextCols
  rows = nextRows
  heat = new Uint8Array(cols * rows)
  tint = new Uint8Array(cols * rows)
  flaps.value = []
  proposedMarks.clear()
  ledgerCol.clear()
  openSeenCol.clear()
  layoutBands()
  paint()
}

function idx(c, r) {
  return c * rows + r
}

function light(c, r, lane, amt = 2) {
  if (c < 0 || c >= cols || r < 0 || r >= rows) return
  const i = idx(c, r)
  const next = Math.min(4, heat[i] + amt)
  if (next >= heat[i]) tint[i] = lane
  heat[i] = next
}

let lastLedgerIndex = 0
let lastLedgerPerf = 0

function catchUp(now = performance.now()) {
  if (!lastShift) lastShift = now
  let n = 0
  while (now - lastShift >= SHIFT_MS && n < cols) {
    shift()
    lastShift += SHIFT_MS
    n++
  }
}

function pruneColMap(map, keep = 24) {
  if (map.size <= keep) return
  const extra = map.size - keep
  let n = 0
  for (const k of map.keys()) {
    map.delete(k)
    if (++n >= extra) break
  }
}

function gapToLive(n) {
  const steps = Math.max(0, Math.min(cols, n | 0))
  for (let i = 0; i < steps; i++) shift()
}

function markOpenLedger(index) {
  const L = Number(index || 0)
  if (!L || openSeenCol.has(L)) return
  openSeenCol.set(L, cols - 1)
  pruneColMap(openSeenCol)
}

// Closed ledger N sits at the end of its proposed window: just before we
// first saw proposed for N+1, or the live edge if N+1 has not started.
function colForClosedLedger(index) {
  const L = Number(index || 0)
  if (L && ledgerCol.has(L)) return ledgerCol.get(L)
  const next = L ? openSeenCol.get(L + 1) : null
  const c = next != null ? Math.max(0, next - 1) : cols - 1
  if (L) {
    ledgerCol.set(L, c)
    pruneColMap(ledgerCol)
  }
  return c
}

function clearProposedPixel(c, r) {
  const proposedLi = laneIndex.proposed ?? 0
  if (c < 0 || c >= cols || r == null || r < 0 || r >= rows) return
  const i = idx(c, r)
  if (tint[i] !== proposedLi) return
  heat[i] = 0
}

function clearMark(rec) {
  if (!rec) return
  clearProposedPixel(rec.col, rec.r)
  clearProposedPixel(rec.col, rec.r2)
}

function paintInBand(c, bandLane, amt, colorLane = bandLane) {
  const b = bandRows[bandLane] || bandRows[0]
  const span = Math.max(1, b.r1 - b.r0)
  const r = b.r0 + ((Math.random() * span) | 0)
  light(c, r, colorLane, amt)
  let r2 = null
  if (Math.random() < 0.45) {
    r2 = r + (Math.random() < 0.5 ? -1 : 1)
    light(c, r2, colorLane, 1)
  }
  return { r, r2 }
}

// Pull a proposed mark off the time-scatter and redraw it on the close column.
function landProposed(hash, typeLane, closeCol) {
  const rec = hash ? proposedMarks.get(hash) : null
  if (rec) {
    clearMark(rec)
    proposedMarks.delete(hash)
  }
  const proposedLi = laneIndex.proposed ?? 0
  paintInBand(closeCol, proposedLi, 3, typeLane ?? proposedLi)
}

function moveOpenProposed(fromMaxCol, toCol) {
  const proposedLi = laneIndex.proposed ?? 0
  for (const rec of proposedMarks.values()) {
    if (rec.col > fromMaxCol || rec.col === toCol) continue
    clearMark(rec)
    const { r, r2 } = paintInBand(toCol, proposedLi, 1)
    rec.col = toCol
    rec.r = r
    rec.r2 = r2
  }
}

function dropProposed(hash) {
  if (!hash) return
  // Leave the slate mark where it is — not collected onto a close, not moved.
  proposedMarks.delete(hash)
}

function pulse(p) {
  if (!heat) return
  const now = performance.now()
  catchUp(now)
  if (p.kind === 'dropped') {
    dropProposed(p.hash)
    return
  }
  if (p.kind === 'tx' && p.proposed && p.ledger) markOpenLedger(p.ledger)
  if (p.kind === 'ledger') {
    const index = Number(p.index || 0)
    if (lastLedgerIndex && index > lastLedgerIndex) {
      const jumped = index - lastLedgerIndex
      const had = now - lastLedgerPerf
      // Live closes already sit ~3.8s apart via catchUp. Only pad when
      // ledgerClosed messages were queued in one gulp (had ≈ 0).
      if (had < TYPICAL_CLOSE_MS * 0.35 * jumped) {
        const missing = jumped * TYPICAL_CLOSE_MS - had
        const steps = Math.min(cols, Math.round(missing / SHIFT_MS))
        for (let i = 0; i < steps; i++) shift()
        lastShift += steps * SHIFT_MS
      }
    }
    lastLedgerIndex = index
    lastLedgerPerf = now
    const c = colForClosedLedger(index)
    const v = p.flag ? 2 : 1
    for (let r = 0; r < rows; r++) {
      if (r % 2 === 0) light(c, r, tint[idx(c, r)] || 0, v)
    }
    flaps.value = [
      ...flaps.value,
      { id: ++flapId, col: c, n: Number(p.txnCount || 0), flag: !!p.flag },
    ]
    if (c >= cols - 2) gapToLive(CLOSE_GAP_COLS)
    const closedAt = ledgerCol.get(index) ?? c
    moveOpenProposed(closedAt, cols - 1)
    return
  }
  const closed = p.kind === 'tx' && !p.proposed
  const name =
    p.lane ||
    (p.kind === 'validation' ? (p.trusted ? 'validation-unl' : 'validation-other') : 'other')
  const li = laneIndex[name] ?? 4
  if (p.kind === 'validation') {
    paintInBand(cols - 1, li, 2)
    return
  }
  if (closed) {
    const c = colForClosedLedger(p.ledger || lastLedgerIndex)
    paintInBand(c, li, 2)
    landProposed(p.hash, li, c)
    return
  }
  const proposedLi = laneIndex.proposed ?? 0
  const c = cols - 1
  const { r, r2 } = paintInBand(c, proposedLi, 1)
  if (p.hash) {
    proposedMarks.set(p.hash, { col: c, r, r2 })
    if (proposedMarks.size > 4000) {
      const extra = proposedMarks.size - 3000
      let n = 0
      for (const k of proposedMarks.keys()) {
        proposedMarks.delete(k)
        if (++n >= extra) break
      }
    }
  }
}

function paint() {
  if (!ctx || !heat) return
  ctx.fillStyle = '#0a121c'
  ctx.fillRect(0, 0, w, h)
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = heat[idx(c, r)]
      if (!v) continue
      const lane = tint[idx(c, r)]
      ctx.fillStyle = LEVELS[v][lane] || LEVELS[v][0]
      ctx.fillRect(c * PITCH, r * PITCH, CELL, CELL)
    }
  }
  const splitY = Math.floor(0.17 * rows) * PITCH
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(0, splitY, w, 1)
  const voteY = Math.floor(0.75 * rows) * PITCH
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.fillRect(0, voteY, w, 1)
  if (props.flagWindow) {
    ctx.fillStyle = 'rgba(255,209,102,0.12)'
    ctx.fillRect((cols - 1) * PITCH, 0, CELL, h)
  }
}

function shiftMap(map) {
  for (const [k, c] of map) {
    const next = c - 1
    if (next < 0) map.delete(k)
    else map.set(k, next)
  }
}

function shift() {
  if (!heat) return
  heat.copyWithin(0, rows)
  tint.copyWithin(0, rows)
  heat.fill(0, (cols - 1) * rows)
  tint.fill(0, (cols - 1) * rows)
  if (flaps.value.length) {
    flaps.value = flaps.value
      .map((m) => ({ ...m, col: m.col - 1 }))
      .filter((m) => m.col >= 0)
  }
  if (proposedMarks.size) {
    for (const [h, rec] of proposedMarks) {
      rec.col -= 1
      if (rec.col < 0) proposedMarks.delete(h)
    }
  }
  shiftMap(ledgerCol)
  shiftMap(openSeenCol)
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
    <canvas ref="canvasRef" />
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
    <div class="lanes">
      <span
        v-for="l in LANE_DEFS.filter((x) => x.label)"
        :key="l.id"
        :style="{ color: l.color, top: l.y0 * 100 + 0.6 + '%' }"
      >
        <template v-if="l.labelParts">
          <em v-for="(p, i) in l.labelParts" :key="i" :style="{ color: p.color, fontStyle: 'normal' }">{{ p.text }}</em>
        </template>
        <template v-else>{{ l.label }}</template>
      </span>
    </div>
    <div class="legend">
      <span>proposed: slate in-flight · type color on a close = included</span>
      <span>slate off-column = dropped</span>
      <span>type bands = closed ledger (final)</span>
      <span>| = ledger close · gap = next open</span>
    </div>
  </div>
</template>

<style scoped>
.spec {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0a121c;
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
}
</style>
