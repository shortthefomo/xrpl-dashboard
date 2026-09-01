import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { Client } from 'xrpl'
import {
  deliveredDrops,
  feeDrops,
  isProposed,
  laneForTxType,
  txBody,
} from '../lib/txMeta.js'
import { flagPhase, isFlagWindow, ledgersToFlag } from '../lib/format.js'
import { loadPublishedUnl } from '../lib/unl.js'

export const PUBLIC_HOSTS = ['wss://s1.ripple.com/', 'wss://s2.ripple.com/']

const CORE_STREAMS = [
  'ledger',
  'transactions',
  'transactions_proposed',
  'validations',
  'manifests',
]
const OPTIONAL_STREAMS = ['consensus', 'server', 'peer_status']

const RIPPLE_EPOCH = 946684800
const HISTORY = 256

function rippleToUnixMs(rt) {
  const n = Number(rt)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return (n + RIPPLE_EPOCH) * 1000
}
const FEED_MAX = 40
const OPEN_MAX = 400

function defaultWsUrl() {
  const q = new URLSearchParams(window.location.search).get('ws')
  if (q) return q
  if (import.meta.env.VITE_XRPL_WS) return import.meta.env.VITE_XRPL_WS
  return PUBLIC_HOSTS[0]
}

function isPublicRipple(u) {
  return /s[12]\.ripple\.com/i.test(String(u || ''))
}

function hostListFor(u) {
  return isPublicRipple(u) ? [...PUBLIC_HOSTS] : [u]
}

function parseCompleteRange(s) {
  if (!s || typeof s !== 'string') return null
  const last = s.split(',').pop().trim()
  const m = last.match(/(\d+)\s*-\s*(\d+)/)
  if (!m) return null
  return { from: Number(m[1]), to: Number(m[2]) }
}

export function useXrpl() {
  const url = ref(defaultWsUrl())
  const connected = ref(false)
  const status = ref('connecting')
  const error = ref('')
  const rateLimit = ref('')
  const isClio = ref(false)
  const hostLabel = computed(() => {
    try {
      return new URL(url.value).host
    } catch {
      return url.value.replace(/^wss?:\/\//, '').replace(/\/$/, '')
    }
  })

  const ledgerIndex = ref(0)
  const ledgerHash = ref('')
  const txnCount = ref(0)
  const feeBase = ref(10)
  const reserveBase = ref(0)
  const reserveInc = ref(0)
  const ledgerTime = ref(0)
  const serverState = ref('')
  const peers = ref(0)
  const proposers = ref(0)
  const quorum = ref(0)
  const loadFactor = ref(1)
  const hostid = ref('')
  const buildVersion = ref('')
  const consensus = ref('')
  const completeLedgers = ref('')

  const unlKeys = shallowRef(new Set())
  const signingKeys = shallowRef({}) // master -> ephemeral
  const ephemeralToMaster = shallowRef({})
  const trustedIds = shallowRef(new Set())
  const unlCount = ref(0)
  const seenValidators = shallowRef(new Set())
  const seenCount = ref(0)

  const validatedTotal = ref(0)
  const proposedTotal = ref(0)
  const droppedTotal = ref(0)
  const xrpDeliveredDrops = ref(0)
  const feesDrops = ref(0)
  const feesLostDrops = ref(0)
  const typeCounts = reactive({})
  const typeProposed = reactive({})

  const openProposed = shallowRef(new Map()) // hash -> {type, t}
  const openCount = ref(0)
  const closingSet = shallowRef([])
  const feed = shallowRef([])
  const droppedFeed = shallowRef([])

  const history = shallowRef([]) // {index, txnCount, hash, flag}
  const voteLedgerHash = ref('')
  const voteUnl = ref(0)
  const voteOther = ref(0)
  const validationTotal = ref(0)
  const roundUnl = new Set()
  const roundOther = new Set()

  const amendmentNames = shallowRef({})
  const amendmentVotes = shallowRef({})
  const flagBanner = ref(null)
  const lastManifest = ref(null)
  const lastPeer = ref(null)
  const streamCounts = reactive({
    transaction: 0,
    proposed: 0,
    validationReceived: 0,
    ledgerClosed: 0,
    consensusPhase: 0,
    serverStatus: 0,
    manifestReceived: 0,
    peerStatusChange: 0,
  })

  const pulses = []
  let pulseHandler = null
  const setPulseHandler = (fn) => {
    pulseHandler = fn
    if (fn && pulses.length) {
      for (const p of pulses) fn(p)
      pulses.length = 0
    }
  }
  const pulse = (p) => {
    if (pulseHandler) pulseHandler(p)
    else {
      pulses.push(p)
      if (pulses.length > 2000) pulses.splice(0, pulses.length - 1000)
    }
  }

  let client = null
  let reconnectTimer = null
  let infoTimer = null
  let unmounted = false
  let connecting = false
  let droppedTxStream = false
  let unlFetchedAt = 0
  let backoffMs = 2000
  let failCount = 0
  const seenTx = new Map() // hash -> {validated, type}
  const hosts = hostListFor(url.value)

  const rankedTypes = computed(() => {
    return Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({
        name,
        count,
        proposed: typeProposed[name] || 0,
      }))
  })

  const flag = computed(() => ({
    mod: ledgerIndex.value % 256,
    remaining: ledgersToFlag(ledgerIndex.value),
    phase: flagPhase(ledgerIndex.value),
    window: isFlagWindow(ledgerIndex.value),
  }))

  function rememberTx(hash, rec) {
    seenTx.set(hash, rec)
    if (seenTx.size > 8000) {
      const drop = seenTx.size - 6000
      let i = 0
      for (const k of seenTx.keys()) {
        seenTx.delete(k)
        if (++i >= drop) break
      }
    }
  }

  function pushFeed(item) {
    const next = [item, ...feed.value]
    if (next.length > FEED_MAX) next.length = FEED_MAX
    feed.value = next
  }

  function watchLoad(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.warning === 'load') markLoad('load')
    if (!Array.isArray(msg.warnings)) return
    for (const w of msg.warnings) {
      if (w?.id === 2001) continue // Clio notice, not a rate limit
      const text = String(w?.message || '')
      if (w?.id === 2008 || /load|rate|threshold/i.test(text)) markLoad('load')
    }
  }

  function markLoad(kind) {
    rateLimit.value = kind || 'load'
    if (client?.isConnected()) degrade(client)
  }

  async function degrade(c) {
    if (droppedTxStream || !c?.isConnected()) return
    droppedTxStream = true
    try {
      await c.request({ command: 'unsubscribe', streams: ['transactions'] })
    } catch {
      /* already gone */
    }
  }

  function rotateHost() {
    if (hosts.length < 2) return
    const i = hosts.indexOf(url.value)
    url.value = hosts[(i + 1) % hosts.length]
  }

  function onTransaction(msg) {
    watchLoad(msg)
    const body = txBody(msg)
    const type = body.TransactionType || 'Unknown'
    const hash = msg.hash || body.hash || body.TxnSignature || ''
    const proposed = isProposed(msg)
    const prev = hash ? seenTx.get(hash) : null

    if (proposed) {
      const cur = Number(msg.ledger_current_index || 0)
      const lls = Number(body.LastLedgerSequence || 0)
      if (prev?.validated) return
      if (prev && hash) {
        const map = new Map(openProposed.value)
        const rec = map.get(hash) || { type, account: body.Account }
        rec.lastLedger = cur || rec.lastLedger || 0
        rec.lls = lls || rec.lls || 0
        rec.fee = rec.fee || feeDrops(msg)
        rec.t = Date.now()
        map.set(hash, rec)
        openProposed.value = map
        return
      }
      streamCounts.proposed++
      proposedTotal.value++
      typeProposed[type] = (typeProposed[type] || 0) + 1
      const map = new Map(openProposed.value)
      if (hash)
        map.set(hash, {
          type,
          t: Date.now(),
          account: body.Account,
          lastLedger: cur,
          lls,
          fee: feeDrops(msg),
        })
      if (map.size > OPEN_MAX) {
        const first = map.keys().next().value
        map.delete(first)
      }
      openProposed.value = map
      openCount.value = map.size
      if (hash) rememberTx(hash, { validated: false, type })
      pulse({
        kind: 'tx',
        type,
        lane: 'proposed',
        proposed: true,
        hash,
        ledger: cur,
        at: rippleToUnixMs(body.date),
      })
      pushFeed({
        hash,
        type,
        proposed: true,
        account: body.Account,
        dest: body.Destination,
        result: msg.engine_result,
      })
      return
    }

    if (prev?.validated) return
    streamCounts.transaction++
    validatedTotal.value++
    typeCounts[type] = (typeCounts[type] || 0) + 1
    if (hash) rememberTx(hash, { validated: true, type, ledger: msg.ledger_index })
    if (hash && openProposed.value.has(hash)) {
      const map = new Map(openProposed.value)
      map.delete(hash)
      openProposed.value = map
      openCount.value = map.size
    }
    if (type === 'Payment') xrpDeliveredDrops.value += deliveredDrops(msg)
    feesDrops.value += feeDrops(msg)
    pulse({
      kind: 'tx',
      type,
      lane: laneForTxType(type),
      proposed: false,
      hash,
      ledger: Number(msg.ledger_index || 0),
      result: msg.engine_result,
      at: rippleToUnixMs(body.date || msg.date),
    })
    if (!prev?.validated) {
      pushFeed({
        hash,
        type,
        proposed: false,
        account: body.Account,
        dest: body.Destination,
        result: msg.engine_result,
        ledger: msg.ledger_index,
      })
    }
  }

  function onLedgerClosed(msg) {
    watchLoad(msg)
    streamCounts.ledgerClosed++
    const index = Number(msg.ledger_index || 0)
    ledgerIndex.value = index
    ledgerHash.value = msg.ledger_hash || ''
    txnCount.value = Number(msg.txn_count || 0)
    feeBase.value = Number(msg.fee_base || feeBase.value)
    reserveBase.value = Number(msg.reserve_base || reserveBase.value)
    reserveInc.value = Number(msg.reserve_inc || reserveInc.value)
    ledgerTime.value = Number(msg.ledger_time || 0)
    if (msg.validated_ledgers) completeLedgers.value = msg.validated_ledgers

    const made = []
    const still = new Map()
    for (const [h, rec] of openProposed.value) {
      const seen = seenTx.get(h)
      if (seen?.validated) {
        if (seen.ledger === index) made.push(h)
        continue
      }
      const expired = rec.lls ? index >= rec.lls : rec.lastLedger && index - rec.lastLedger >= 3
      if (expired) {
        droppedTotal.value++
        feesLostDrops.value += rec.fee || 0
        droppedFeed.value = [
          { hash: h, type: rec.type, account: rec.account, ledger: index },
          ...droppedFeed.value,
        ].slice(0, 12)
        pulse({ kind: 'dropped', hash: h, type: rec.type })
      } else still.set(h, rec)
    }
    openProposed.value = still
    openCount.value = still.size
    closingSet.value = made

    const row = {
      index,
      txnCount: Number(msg.txn_count || 0),
      hash: msg.ledger_hash || '',
      flag: index % 256 === 0,
    }
    const hist = history.value.slice()
    const existing = hist.findIndex((h) => h.index === index)
    if (existing >= 0) hist[existing] = row
    else hist.push(row)
    hist.sort((a, b) => a.index - b.index)
    if (hist.length > HISTORY) hist.splice(0, hist.length - HISTORY)
    history.value = hist

    const phase = flagPhase(index)
    flagBanner.value = isFlagWindow(index)
      ? { phase, index, remaining: ledgersToFlag(index) }
      : null

    pulse({
      kind: 'ledger',
      index,
      txnCount: row.txnCount,
      flag: row.flag,
      ledgerTime: Number(msg.ledger_time || 0),
    })
  }

  function masterOf(msg) {
    if (msg.master_key) return msg.master_key
    const eph = msg.validation_public_key
    if (eph && ephemeralToMaster.value[eph]) return ephemeralToMaster.value[eph]
    return eph || ''
  }

  function isTrusted(msg, master) {
    const ids = trustedIds.value
    if (!ids.size) return false
    if (master && ids.has(master)) return true
    if (msg.master_key && ids.has(msg.master_key)) return true
    if (msg.validation_public_key && ids.has(msg.validation_public_key)) return true
    return false
  }

  function onValidation(msg) {
    try {
      watchLoad(msg)
      streamCounts.validationReceived++
      validationTotal.value++
      const master = masterOf(msg)
      const eph = msg.validation_public_key
      const id = master || eph || ''
      if (id) {
        const set = seenValidators.value
        if (!set.has(id)) {
          const next = new Set(set)
          next.add(id)
          seenValidators.value = next
          seenCount.value = next.size
        }
      }
      const hash = String(msg.ledger_hash || msg.validated_hash || '')
      if (hash && hash !== voteLedgerHash.value) {
        voteLedgerHash.value = hash
        roundUnl.clear()
        roundOther.clear()
        voteUnl.value = 0
        voteOther.value = 0
      }
      const trusted = isTrusted(msg, master)
      if (msg.full !== false && id) {
        if (trusted) {
          roundUnl.add(id)
          voteUnl.value = roundUnl.size
        } else {
          roundOther.add(id)
          voteOther.value = roundOther.size
        }
      }
      pulse({
        kind: 'validation',
        lane: trusted ? 'validation-unl' : 'validation-other',
        trusted,
        key: id,
        at: rippleToUnixMs(msg.signing_time),
      })

      if (Array.isArray(msg.amendments) && trusted) {
        const tally = { ...amendmentVotes.value }
        for (const id of msg.amendments) {
          const slot = tally[id] || { keys: new Set(), count: 0 }
          if (!slot.keys.has(master)) {
            const keys = new Set(slot.keys)
            keys.add(master)
            tally[id] = { keys, count: keys.size }
          }
        }
        amendmentVotes.value = tally
      }
    } catch (e) {
      console.warn('validation handler', e)
    }
  }

  function onConsensus(msg) {
    streamCounts.consensusPhase++
    consensus.value = msg.consensus || consensus.value
    pulse({ kind: 'consensus', phase: msg.consensus })
  }

  function onServer(msg) {
    streamCounts.serverStatus++
    serverState.value = msg.server_status || serverState.value
    if (msg.load_factor) loadFactor.value = Number(msg.load_factor) / 256
  }

  function onManifest(msg) {
    streamCounts.manifestReceived++
    lastManifest.value = {
      master: msg.master_key || msg.public_key,
      seq: msg.seq,
      ephemeral: msg.ephemeral_key,
    }
    pulse({ kind: 'manifest' })
  }

  function onPeer(msg) {
    streamCounts.peerStatusChange++
    lastPeer.value = { action: msg.action, ledger: msg.ledger_index }
    pulse({ kind: 'peer', action: msg.action })
  }

  function applyValidatorSet({ unl, signing, rev, trusted, count, quorum: q }) {
    unlKeys.value = unl
    unlCount.value = count
    signingKeys.value = signing
    ephemeralToMaster.value = rev
    trustedIds.value = trusted
    if (q) quorum.value = q
  }

  async function ensurePublishedUnl() {
    if (unlKeys.value.size && Date.now() - unlFetchedAt < 10 * 60 * 1000) return
    const parsed = await loadPublishedUnl()
    if (!parsed) return
    applyValidatorSet(parsed)
    unlFetchedAt = Date.now()
  }

  async function refreshInfo(c) {
    try {
      const [infoRes, valRes] = await Promise.all([
        c.request({ command: 'server_info' }),
        c.request({ command: 'validators' }).catch(() => null),
      ])
      watchLoad(infoRes)
      watchLoad(valRes)
      const info = infoRes.result?.info || {}
      isClio.value = Boolean(info.clio_version)
      serverState.value =
        info.server_state || (info.clio_version ? 'clio' : serverState.value)
      peers.value = Number(info.peers || 0)
      proposers.value = Number(info.last_close?.proposers || proposers.value)
      quorum.value = Number(info.validation_quorum || quorum.value)
      loadFactor.value = Number(info.load_factor || loadFactor.value)
      hostid.value = info.hostid || hostLabel.value
      buildVersion.value =
        info.clio_version || info.rippled_version || info.build_version || buildVersion.value
      completeLedgers.value = info.complete_ledgers || completeLedgers.value
      if (info.validated_ledger) {
        const vl = info.validated_ledger
        if (!ledgerIndex.value) ledgerIndex.value = Number(vl.seq || 0)
        if (!ledgerHash.value) ledgerHash.value = vl.hash || ''
        reserveBase.value = Math.round((vl.reserve_base_xrp || 0) * 1_000_000) || reserveBase.value
        reserveInc.value = Math.round((vl.reserve_inc_xrp || 0) * 1_000_000) || reserveInc.value
      }
      if (valRes?.result?.trusted_validator_keys) {
        const keys = valRes.result.trusted_validator_keys || []
        const unl = new Set(keys)
        const signing = valRes.result.signing_keys || {}
        const rev = {}
        const trusted = new Set(unl)
        for (const [master, eph] of Object.entries(signing)) {
          if (typeof eph === 'string') {
            rev[eph] = master
            trusted.add(eph)
          }
          trusted.add(master)
        }
        applyValidatorSet({
          unl,
          signing,
          rev,
          trusted,
          count: unl.size,
          quorum: Number(valRes.result.validation_quorum || 0),
        })
      } else {
        await ensurePublishedUnl()
      }
    } catch (e) {
      console.warn('server_info', e?.message || e)
      await ensurePublishedUnl().catch(() => {})
    }
  }

  async function loadFeatures(c) {
    try {
      const res = await c.request({ command: 'feature' })
      const raw = res.result?.features || res.result || {}
      const names = {}
      for (const [id, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && v.name) names[id] = v.name
      }
      amendmentNames.value = names
    } catch {
      /* optional */
    }
  }

  async function backfillHistory(current) {
    const range = parseCompleteRange(completeLedgers.value)
    const to = current || range?.to
    if (!to) return
    const from = Math.max(range?.from || to - HISTORY + 1, to - HISTORY + 1)
    let filler
    try {
      filler = new Client(url.value, { connectionTimeout: 12000 })
      await filler.connect()
    } catch {
      return
    }
    const rows = []
    const batch = 8
    try {
      for (let i = from; i <= to; i += batch) {
        if (unmounted) return
        const slice = []
        for (let j = i; j < Math.min(i + batch, to + 1); j++) {
          slice.push(
            filler
              .request({ command: 'ledger', ledger_index: j, transactions: true, binary: false })
              .then((r) => {
                const L = r.result?.ledger || {}
                const idx = Number(L.ledger_index || j)
                const txs = L.transactions
                const n = Array.isArray(txs) ? txs.length : Number(L.txn_count || 0)
                return {
                  index: idx,
                  txnCount: n,
                  hash: L.ledger_hash || '',
                  flag: idx % 256 === 0,
                }
              })
              .catch(() => null),
          )
        }
        const got = await Promise.all(slice)
        for (const row of got) if (row) rows.push(row)
        const live = history.value.filter((h) => !rows.some((r) => r.index === h.index))
        history.value = [...rows, ...live].sort((a, b) => a.index - b.index).slice(-HISTORY)
      }
    } finally {
      try {
        await filler.disconnect()
      } catch {
        /* noop */
      }
    }
  }

  async function subscribeAll(c) {
    const sub = await c.request({ command: 'subscribe', streams: CORE_STREAMS })
    watchLoad(sub)
    for (const s of OPTIONAL_STREAMS) {
      try {
        const extra = await c.request({ command: 'subscribe', streams: [s] })
        watchLoad(extra)
      } catch {
        /* Clio / non-admin — consensus, server, peer_status */
      }
    }
  }

  async function afterConnect(c) {
    if (unmounted || c !== client) return
    connected.value = true
    status.value = 'live'
    failCount = 0
    backoffMs = 2000
    if (rateLimit.value === 'threshold exceeded') rateLimit.value = ''
    droppedTxStream = false
    try {
      await subscribeAll(c)
      await refreshInfo(c)
      await loadFeatures(c)
      if (!isPublicRipple(url.value)) {
        backfillHistory(ledgerIndex.value).catch(() => {})
      }
    } catch (e) {
      error.value = e?.message || String(e)
    }
    if (infoTimer) clearInterval(infoTimer)
    const interval = isPublicRipple(url.value) ? 20000 : 5000
    infoTimer = setInterval(() => {
      if (rateLimit.value) return
      if (client?.isConnected()) refreshInfo(client)
    }, interval)
  }

  function bind(c) {
    c.on('transaction', onTransaction)
    c.on('ledgerClosed', onLedgerClosed)
    c.on('validationReceived', onValidation)
    c.on('consensusPhase', onConsensus)
    c.on('manifestReceived', onManifest)
    c.on('peerStatusChange', onPeer)
    c.on('connected', () => {
      afterConnect(c)
    })
    c.on('disconnected', (code) => {
      connected.value = false
      if (unmounted || connecting) return
      if (code === 1000) return
      status.value = 'reconnecting'
      if (code === 1008) {
        rateLimit.value = 'threshold exceeded'
        backoffMs = Math.min(Math.max(backoffMs, 8000) * 2, 60000)
        rotateHost()
        scheduleReconnect(backoffMs)
        return
      }
      failCount++
      if (failCount >= 2) {
        rotateHost()
        failCount = 0
        scheduleReconnect(backoffMs)
      }
      // otherwise xrpl.js reconnects this same socket
    })
    c.on('error', (code, msg, data) => {
      watchLoad(data)
      const text = `${code || ''} ${msg || ''}`
      if (/slowDown|tooBusy|threshold/i.test(text)) markLoad(code || 'load')
    })
    const conn = c.connection
    if (conn?.on) {
      conn.on('serverStatus', onServer)
    }
  }

  function scheduleReconnect(ms = backoffMs) {
    if (unmounted || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, ms)
  }

  async function connect() {
    if (unmounted || connecting) return
    connecting = true
    status.value = 'connecting'
    error.value = ''
    try {
      if (client) {
        try {
          await client.disconnect()
        } catch {
          /* noop */
        }
      }
      client = new Client(url.value, { connectionTimeout: 12000 })
      bind(client)
      await client.connect()
    } catch (e) {
      connected.value = false
      status.value = 'error'
      error.value = e?.message || String(e)
      failCount++
      if (failCount >= 2 || isPublicRipple(url.value)) rotateHost()
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }

  onMounted(() => {
    connect()
  })
  onUnmounted(() => {
    unmounted = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (infoTimer) clearInterval(infoTimer)
    if (client) {
      try {
        client.disconnect()
      } catch {
        /* noop */
      }
    }
  })

  return {
    url,
    hostLabel,
    connected,
    status,
    error,
    rateLimit,
    isClio,
    ledgerIndex,
    ledgerHash,
    txnCount,
    feeBase,
    reserveBase,
    reserveInc,
    serverState,
    peers,
    proposers,
    quorum,
    loadFactor,
    hostid,
    buildVersion,
    consensus,
    unlCount,
    seenCount,
    validatedTotal,
    proposedTotal,
    droppedTotal,
    xrpDeliveredDrops,
    feesDrops,
    feesLostDrops,
    rankedTypes,
    typeCounts,
    openCount,
    feed,
    droppedFeed,
    history,
    voteUnl,
    voteOther,
    validationTotal,
    flag,
    flagBanner,
    amendmentNames,
    amendmentVotes,
    lastManifest,
    lastPeer,
    streamCounts,
    setPulseHandler,
  }
}
