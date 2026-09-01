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
let ro = null
let bandRows = []
let flapId = 0
const flaps = ref([]) // { id, col, n, flag }
const proposedMarks = new Map() // hash -> { col, r, r2 }

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

function recolorProposed(hash, lane) {
  const rec = proposedMarks.get(hash)
  if (!rec) return
  proposedMarks.delete(hash)
  const proposedLi = laneIndex.proposed ?? 0
  const paint = (rr) => {
    if (rec.col < 0 || rec.col >= cols || rr == null || rr < 0 || rr >= rows) return
    const i = idx(rec.col, rr)
    if (!heat[i]) return
    if (tint[i] !== proposedLi && tint[i] !== lane) return
    tint[i] = lane
    heat[i] = Math.min(4, Math.max(heat[i], 3))
  }
  paint(rec.r)
  paint(rec.r2)
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

function pulse(p) {
  if (!heat) return
  const now = performance.now()
  catchUp(now)
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
  }
  const c = cols - 1
  if (p.kind === 'ledger') {
    const v = p.flag ? 2 : 1
    for (let r = 0; r < rows; r++) {
      if (r % 2 === 0) light(c, r, tint[idx(c, r)] || 0, v)
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
  const b = bandRows[li] || bandRows[4]
  const span = Math.max(1, b.r1 - b.r0)
  const r = b.r0 + ((Math.random() * span) | 0)
  const amt = p.kind === 'validation' ? 2 : p.proposed ? 1 : 2
  light(c, r, li, amt)
  let r2 = null
  if (Math.random() < 0.45) {
    r2 = r + (Math.random() < 0.5 ? -1 : 1)
    light(c, r2, li, 1)
  }
  if (p.proposed && p.hash) {
    proposedMarks.set(p.hash, { col: c, r, r2 })
    if (proposedMarks.size > 4000) {
      const extra = proposedMarks.size - 3000
      let n = 0
      for (const k of proposedMarks.keys()) {
        proposedMarks.delete(k)
        if (++n >= extra) break
      }
    }
  } else if (p.kind === 'tx' && !p.proposed && p.hash) {
    recolorProposed(p.hash, li)
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
      <span>proposed: slate until final (type color)</span>
      <span>type bands = closed ledger (final)</span>
      <span>| = ledger close</span>
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
  height: 18px;
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
