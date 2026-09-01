<script setup>
import { computed, ref } from 'vue'
import { commas } from '../lib/format.js'

const props = defineProps({
  history: { type: Array, default: () => [] },
})

const ROWS = 8
const COLS = 32
const hover = ref(null)

const maxTxn = computed(() => {
  let m = 1
  for (const h of props.history) if (h.txnCount > m) m = h.txnCount
  return m
})

const cells = computed(() => {
  const hist = props.history.slice(-256)
  const pad = 256 - hist.length
  const out = []
  for (let i = 0; i < 256; i++) {
    const row = i % ROWS
    const col = Math.floor(i / ROWS)
    const rec = i < pad ? null : hist[i - pad]
    out.push({ row, col, rec, i })
  }
  return out
})

function level(rec) {
  if (!rec) return 0
  if (!rec.txnCount) return 1
  const t = rec.txnCount / maxTxn.value
  if (t < 0.15) return 1
  if (t < 0.35) return 2
  if (t < 0.65) return 3
  return 4
}

function onEnter(c, ev) {
  if (!c.rec) return
  hover.value = {
    rec: c.rec,
    x: ev.clientX,
    y: ev.clientY,
  }
}
</script>

<template>
  <div class="graph">
    <div class="grid">
      <button
        v-for="c in cells"
        :key="c.i"
        class="cell"
        :class="[`lv-${level(c.rec)}`, { flag: c.rec?.flag }]"
        :style="{ gridColumn: c.col + 1, gridRow: c.row + 1 }"
        :title="c.rec ? `${commas(c.rec.index)} · ${c.rec.txnCount} tx` : ''"
        @mouseenter="onEnter(c, $event)"
        @mouseleave="hover = null"
      />
    </div>
    <div v-if="hover" class="tip">
      Ledger {{ commas(hover.rec.index) }}
      <span>{{ hover.rec.txnCount }} tx</span>
      <em v-if="hover.rec.flag">flag</em>
    </div>
  </div>
</template>

<style scoped>
.graph {
  position: relative;
}
.grid {
  display: grid;
  grid-template-columns: repeat(32, 1fr);
  grid-template-rows: repeat(8, 1fr);
  gap: 3px;
  width: 100%;
  height: 108px;
}
.cell {
  border: 0;
  padding: 0;
  border-radius: 2px;
  background: #121a24;
  min-width: 0;
  min-height: 0;
  cursor: default;
}
.lv-1 {
  background: #0a2e1b;
}
.lv-2 {
  background: #145c35;
}
.lv-3 {
  background: #1e8a50;
}
.lv-4 {
  background: #22c55e;
}
.flag {
  box-shadow: inset 0 0 0 1px #f97316;
}
.tip {
  position: absolute;
  left: 0;
  top: -28px;
  font-size: 11px;
  color: #c5d4e8;
  font-family: 'IBM Plex Mono', monospace;
  white-space: nowrap;
}
.tip span {
  color: #56d364;
  margin-left: 8px;
}
.tip em {
  color: #ffd166;
  font-style: normal;
  margin-left: 8px;
}
</style>
