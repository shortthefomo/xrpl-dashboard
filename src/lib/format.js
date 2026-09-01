const nf = new Intl.NumberFormat('en-US')
const nfCompact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function commas(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return nf.format(Math.round(Number(n)))
}

export function compact(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return nfCompact.format(Number(n))
}

export function shortHash(h, head = 8, tail = 4) {
  if (!h) return ''
  const s = String(h)
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function shortAddr(a) {
  if (!a) return ''
  const s = String(a)
  if (s.length <= 10) return s
  return `${s.slice(0, 5)}…${s.slice(-4)}`
}

export function dropsToXrp(drops) {
  const n = Number(drops)
  if (!Number.isFinite(n)) return 0
  return n / 1_000_000
}

export function formatXrp(drops, digits = 2) {
  const xrp = dropsToXrp(drops)
  const abs = Math.abs(xrp)
  if (abs >= 1_000_000) return nfCompact.format(xrp)
  return xrp.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function flagMod(index) {
  return Number(index) % 256
}

export function ledgersToFlag(index) {
  const m = flagMod(index)
  return m === 0 ? 0 : 256 - m
}

export function flagPhase(index) {
  const m = flagMod(index)
  if (m === 255) return 'vote'
  if (m === 0) return 'flag'
  if (m === 1) return 'apply'
  if (m === 2) return 'effective'
  return null
}

export function isFlagWindow(index) {
  const m = flagMod(index)
  return m >= 254 || m <= 2
}

export function hueFromString(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
  return h % 360
}
