<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: [Number, String], default: 0 },
  flag: { type: Boolean, default: false },
  tone: { type: String, default: '' },
})

const digits = computed(() => String(Math.max(0, Number(props.value) || 0)).padStart(2, '0').split(''))
</script>

<template>
  <div class="board" :class="{ flag, magenta: tone === 'magenta' }">
    <span v-for="(d, i) in digits" :key="i" class="unit" :style="{ animationDelay: i * 70 + 'ms' }">
      <span class="face top"><em>{{ d }}</em></span>
      <span class="face bot"><em>{{ d }}</em></span>
      <i class="hinge" />
    </span>
  </div>
</template>

<style scoped>
.board {
  display: inline-flex;
  gap: 2px;
  perspective: 80px;
}
.unit {
  position: relative;
  width: 11px;
  height: 16px;
  animation: flip-in 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  transform-style: preserve-3d;
}
.face {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: linear-gradient(#1c2430, #121820);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.face em {
  position: absolute;
  left: 0;
  right: 0;
  text-align: center;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: #e5e7eb;
}
.flag .face em {
  color: #f97316;
}
.face.top {
  clip-path: inset(0 0 50% 0);
  border-radius: 2px 2px 0 0;
  background: linear-gradient(#2a3342, #1a222e);
}
.face.bot {
  clip-path: inset(50% 0 0 0);
  border-radius: 0 0 2px 2px;
  background: linear-gradient(#0e141c, #161d28);
}
.face.bot em {
  color: #d1d5db;
}
.flag .face.bot em {
  color: #f97316;
}
.magenta .face em,
.magenta .face.bot em {
  color: #ef4444;
}
.hinge {
  position: absolute;
  left: 1px;
  right: 1px;
  top: 50%;
  height: 1px;
  margin-top: -0.5px;
  background: #05080c;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08);
  z-index: 2;
}
@keyframes flip-in {
  0% {
    transform: rotateX(-90deg);
    opacity: 0.2;
  }
  60% {
    transform: rotateX(12deg);
    opacity: 1;
  }
  100% {
    transform: rotateX(0deg);
    opacity: 1;
  }
}
</style>
