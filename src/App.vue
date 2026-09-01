<script setup>
import { computed, ref, watch } from 'vue'
import { useXrpl } from './composables/useXrpl.js'
import Spectrogram from './components/Spectrogram.vue'
import ContributionGraph from './components/ContributionGraph.vue'
import FlapCounter from './components/FlapCounter.vue'
import { colorForType } from './lib/txMeta.js'
import { commas, formatXrp, shortAddr, shortHash } from './lib/format.js'

const xrpl = useXrpl()
const spec = ref(null)

watch(
  spec,
  (el) => {
    xrpl.setPulseHandler(el ? (p) => el.pulse(p) : null)
  },
  { immediate: true },
)

const overlay = computed(() => {
  const h = xrpl.ledgerHash.value
  if (!h) return ''
  return `hash=${h.slice(0, 12).toLowerCase()}/ledger-${xrpl.ledgerIndex.value}`
})

const consensusLabel = computed(() => (xrpl.consensus.value || 'open').toUpperCase())

const flagLabel = computed(() => {
  const f = xrpl.flag.value
  if (f.phase === 'flag') return 'FLAG LEDGER'
  if (f.phase === 'vote') return 'FLAG −1  ·  voting'
  if (f.phase === 'apply') return 'FLAG +1  ·  applying'
  if (f.phase === 'effective') return 'FLAG +2  ·  effective'
  return `Flag in ${f.remaining}`
})

const amendmentRows = computed(() => {
  const names = xrpl.amendmentNames.value
  const votes = xrpl.amendmentVotes.value
  const unl = xrpl.unlCount.value || 1
  return Object.entries(votes)
    .map(([id, v]) => ({
      id,
      name: names[id] || shortHash(id, 8, 4),
      count: v.count,
      pct: Math.round((v.count / unl) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
})

const liveFeed = computed(() => xrpl.feed.value)

watch(
  () => xrpl.ledgerIndex.value,
  () => {
    /* spectrogram already pulses on ledger close */
  },
)
</script>

<template>
  <div class="wall" :class="{ flag: xrpl.flag.value.window }">
    <header class="top">
      <div class="brand">
        <span class="dot" :class="xrpl.status.value" />
        XRPL
        <em>{{ xrpl.hostLabel.value || xrpl.hostid.value || 'mainnet' }}</em>
      </div>
      <div class="pills">
        <span v-if="overlay" class="pill hashpill">{{ overlay }}</span>
        <span v-if="xrpl.serverState.value" class="pill">{{ xrpl.serverState.value }}</span>
        <span v-if="xrpl.consensus.value" class="pill phase">{{ consensusLabel }}</span>
        <span class="pill" :class="{ gold: xrpl.flag.value.window }">{{ flagLabel }}</span>
        <span v-if="xrpl.peers.value" class="pill">{{ xrpl.peers.value }} peers</span>
        <span class="pill">quorum {{ xrpl.quorum.value }}</span>
        <span v-if="xrpl.rateLimit.value" class="pill warn">{{ xrpl.rateLimit.value }}</span>
        <span class="pill muted">{{ xrpl.status.value }}{{ xrpl.error.value ? ' · ' + xrpl.error.value : '' }}</span>
      </div>
    </header>

    <main class="grid">
      <section class="left">
        <div class="metric">
          <div class="label">Ledger</div>
          <div class="hero">{{ commas(xrpl.ledgerIndex.value) }}</div>
          <div class="sub">{{ xrpl.txnCount.value }} txs this close</div>
        </div>

        <div class="metric">
          <div class="label">Validated Transactions</div>
          <div class="hero cyan">{{ commas(xrpl.validatedTotal.value) }}</div>
          <div class="sub">session · {{ commas(xrpl.openCount.value) }} proposed in-flight</div>
        </div>

        <div class="types">
          <div class="label">Transaction Types</div>
          <ul>
            <li v-for="t in xrpl.rankedTypes.value" :key="t.name">
              <i :style="{ background: colorForType(t.name) }" />
              <span class="name">{{ t.name }}</span>
              <b>{{ commas(t.count) }}</b>
            </li>
            <li v-if="!xrpl.rankedTypes.value.length" class="empty">waiting for stream…</li>
          </ul>
        </div>

        <div class="feed">
          <div class="label">Live stream</div>
          <div v-for="(tx, i) in liveFeed" :key="tx.hash + i" class="tx" :class="{ proposed: tx.proposed }">
            <i :style="{ background: colorForType(tx.type) }" />
            <span class="tt">{{ tx.type }}</span>
            <span class="acct">{{ shortAddr(tx.account) }}</span>
            <span class="res">{{ tx.proposed ? 'open' : 'final' }}</span>
          </div>
        </div>
      </section>

      <section class="viz">
        <Spectrogram ref="spec" :flag-window="xrpl.flag.value.window" />
      </section>
    </main>

    <footer class="bottom">
      <div class="loc">
        <div class="label">Proposed — Dropped</div>
        <div class="delta">
          <span class="up">+{{ commas(xrpl.openCount.value) }}</span>
          <span class="down">−{{ commas(xrpl.droppedTotal.value) }}</span>
        </div>
        <div class="xrp">
          <span class="up">+{{ formatXrp(xrpl.feesDrops.value, 4) }} consumed</span>
          <span class="down">−{{ formatXrp(xrpl.feesLostDrops.value, 4) }} lost</span>
        </div>
      </div>

      <div class="contrib">
        <div class="label">Last 256 Ledgers</div>
        <ContributionGraph :history="xrpl.history.value" />
      </div>

      <div class="unl">
        <div class="label">Validations — Network</div>
        <div class="hero cyan unl-num">{{ commas(xrpl.validationTotal.value) }}</div>
        <div class="votes">
          <div class="bar">
            <i
              class="fill"
              :style="{
                width:
                  Math.min(
                    100,
                    (xrpl.unlCount.value || xrpl.quorum.value)
                      ? (xrpl.voteUnl.value / (xrpl.unlCount.value || xrpl.quorum.value || 1)) * 100
                      : 0,
                  ) + '%',
              }"
            />
          </div>
          <span>
            this ledger {{ xrpl.voteUnl.value }}/{{ xrpl.unlCount.value || xrpl.quorum.value }} UNL
            · {{ xrpl.voteOther.value }} other
          </span>
        </div>
      </div>

      <div class="dropped">
        <div class="dropped-head">
          <span class="label">Dropped</span>
          <FlapCounter :value="xrpl.droppedTotal.value" tone="magenta" />
        </div>
        <div class="dropped-list">
          <div v-for="tx in xrpl.droppedFeed.value" :key="tx.hash" class="tx">
            <i :style="{ background: colorForType(tx.type) }" />
            <span class="tt">{{ tx.type }}</span>
            <span class="acct">{{ shortAddr(tx.account) }}</span>
          </div>
          <div v-if="!xrpl.droppedFeed.value.length" class="empty">none this session</div>
        </div>
      </div>
    </footer>

    <aside v-if="xrpl.flag.value.window" class="flag-panel">
      <div class="label">Flag ledger window</div>
      <div class="flag-title">{{ flagLabel }}</div>
      <p>
        Every 256 ledgers UNL votes on amendments and fees. Proposed txs still stream;
        the trusted set selects what closes.
      </p>
      <ul v-if="amendmentRows.length">
        <li v-for="a in amendmentRows" :key="a.id">
          <span>{{ a.name }}</span>
          <b>{{ a.count }}/{{ xrpl.unlCount.value }} · {{ a.pct }}%</b>
        </li>
      </ul>
      <div v-else class="sub">Waiting for UNL amendment votes…</div>
    </aside>
  </div>
</template>

<style scoped>
.wall {
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto;
  padding: 10px 14px 10px;
  gap: 8px;
  position: relative;
}
.wall.flag {
  box-shadow: inset 0 0 0 1px rgba(255, 209, 102, 0.18);
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand {
  font-size: 13px;
  letter-spacing: 0.18em;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand em {
  font-style: normal;
  letter-spacing: 0;
  color: #6f829c;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #334155;
  box-shadow: 0 0 0 3px rgba(51, 65, 85, 0.25);
}
.dot.live {
  background: #56d364;
  box-shadow: 0 0 10px #56d364;
}
.dot.connecting,
.dot.reconnecting {
  background: #ffd166;
}
.dot.error {
  background: #f87171;
}
.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  min-width: 0;
}
.pill {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #9fb3cc;
  border: 1px solid var(--line);
  padding: 4px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.pill.hashpill {
  text-transform: none;
  letter-spacing: 0;
  font-family: 'IBM Plex Mono', monospace;
  color: #60a5fa;
}
.pill.phase {
  color: var(--cyan);
  border-color: rgba(126, 231, 255, 0.25);
}
.pill.gold {
  color: var(--gold);
  border-color: rgba(255, 209, 102, 0.35);
}
.pill.muted {
  opacity: 0.7;
  text-transform: none;
  letter-spacing: 0;
}
.pill.warn {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.45);
}

.grid {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(320px, 26%) 1fr;
  gap: 12px;
  overflow: hidden;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding-top: 2px;
}
.metric .label,
.types .label,
.feed .label,
.loc .label,
.contrib .label,
.unl .label,
.flag-panel .label {
  color: var(--muted);
  font-size: 15px;
  font-weight: 400;
}
.hero {
  font-size: clamp(28px, 2.4vw, 44px);
  font-weight: 300;
  letter-spacing: -0.04em;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
  white-space: nowrap;
  overflow: visible;
}
.hero.cyan {
  color: var(--cyan);
  text-shadow: 0 0 28px rgba(126, 231, 255, 0.18);
}
.sub {
  margin-top: 8px;
  color: #6f829c;
  font-size: 13px;
}
.hash {
  font-family: 'IBM Plex Mono', monospace;
  margin-left: 10px;
  opacity: 0.8;
}

.types {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
}
.types ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.types li {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  color: #c5d4e8;
  font-size: 13px;
}
.types li i,
.tx i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.types .name {
  opacity: 0.92;
}
.types b {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: #9fb3cc;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
}
.types .empty {
  color: #6f829c;
  display: block;
}

.viz {
  position: relative;
  min-width: 0;
  min-height: 0;
  border-radius: 4px;
  overflow: hidden;
}
.feed {
  margin-top: 4px;
  min-height: 72px;
  flex: 1 1 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.tx {
  display: grid;
  grid-template-columns: 8px minmax(0, 1.2fr) minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  color: #9ecbff;
  min-width: 0;
}
.tx .tt,
.tx .acct {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tx.proposed {
  opacity: 0.55;
}
.tx .tt {
  color: #d7e3f4;
}
.tx .acct {
  color: #7ee7ff;
}
.tx .res {
  color: #8b9cb3;
}

.bottom {
  display: grid;
  grid-template-columns: 0.9fr 1.3fr 0.9fr 1fr;
  gap: 20px;
  align-items: start;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.dropped {
  min-width: 0;
}
.dropped-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.dropped .label,
.unl .label {
  color: var(--muted);
}
.dropped-list {
  max-height: 88px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dropped-list .empty {
  color: #6f829c;
  font-size: 12px;
}
.delta {
  font-size: clamp(22px, 2vw, 32px);
  font-weight: 400;
  letter-spacing: -0.03em;
  margin-top: 6px;
  display: flex;
  gap: 16px;
}
.up {
  color: var(--green);
}
.down {
  color: var(--red);
}
.xrp {
  margin-top: 6px;
  font-size: 13px;
  display: flex;
  gap: 14px;
}
.unl-num {
  font-size: clamp(36px, 4vw, 64px);
  white-space: nowrap;
}
.unl-num small {
  font-size: 0.42em;
  color: #8b9cb3;
  letter-spacing: -0.02em;
}
.votes {
  margin-top: 8px;
  color: #8b9cb3;
  font-size: 12px;
}
.bar {
  height: 4px;
  background: #152033;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 6px;
  max-width: 280px;
}
.fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #22c55e, #3b82f6);
}

.flag-panel {
  position: absolute;
  right: 28px;
  top: 56px;
  width: 280px;
  background: rgba(8, 14, 24, 0.82);
  border: 1px solid rgba(255, 209, 102, 0.28);
  padding: 14px 16px;
  border-radius: 6px;
  backdrop-filter: blur(8px);
  z-index: 5;
}
.flag-title {
  color: var(--gold);
  font-size: 18px;
  margin: 4px 0 8px;
}
.flag-panel p {
  color: #9fb3cc;
  font-size: 12px;
  line-height: 1.45;
  margin: 0 0 10px;
}
.flag-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.flag-panel li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
  color: #d7e3f4;
}
.flag-panel b {
  font-weight: 400;
  color: var(--gold);
  font-family: 'IBM Plex Mono', monospace;
}

@media (max-width: 980px) {
  .wall {
    overflow: auto;
    height: auto;
    min-height: 100%;
  }
  .grid,
  .bottom {
    grid-template-columns: 1fr;
  }
  .viz {
    height: 360px;
  }
  .hero {
    font-size: 56px;
  }
}
</style>
