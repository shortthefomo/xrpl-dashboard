/** Transaction-type colors and spectrogram lanes — GitHub-wall palette. */

/** livenet.xrpl.org live viz — not the full marketing swatch book. */
export const XRPL = {
  green: '#22C55E',
  blue: '#3B82F6',
  blueDim: '#60A5FA',
  magenta: '#EC4899',
  orange: '#F97316',
  gray: '#9CA3AF',
  white: '#E5E7EB',
}

export const TYPE_COLORS = {
  Payment: XRPL.green,
  OfferCreate: XRPL.blue,
  OfferCancel: XRPL.blueDim,
  TrustSet: XRPL.blue,
  AccountSet: XRPL.orange,
  AccountDelete: XRPL.orange,
  SetRegularKey: XRPL.orange,
  SignerListSet: XRPL.orange,
  TicketCreate: XRPL.orange,
  EscrowCreate: XRPL.orange,
  EscrowFinish: XRPL.green,
  EscrowCancel: XRPL.orange,
  PaymentChannelCreate: XRPL.green,
  PaymentChannelFund: XRPL.green,
  PaymentChannelClaim: XRPL.green,
  CheckCreate: XRPL.green,
  CheckCash: XRPL.green,
  CheckCancel: XRPL.orange,
  DepositPreauth: XRPL.orange,
  NFTokenMint: XRPL.magenta,
  NFTokenBurn: XRPL.magenta,
  NFTokenCreateOffer: XRPL.magenta,
  NFTokenAcceptOffer: XRPL.magenta,
  NFTokenCancelOffer: XRPL.magenta,
  NFTokenModify: XRPL.magenta,
  AMMCreate: '#A855F7',
  AMMDeposit: '#A855F7',
  AMMWithdraw: '#A855F7',
  AMMBid: '#A855F7',
  AMMVote: '#C084FC',
  AMMDelete: '#A855F7',
  AMMClawback: XRPL.orange,
  OracleSet: XRPL.gray,
  OracleDelete: XRPL.gray,
  DIDSet: XRPL.gray,
  DIDDelete: XRPL.gray,
  Clawback: XRPL.orange,
  EnableAmendment: XRPL.gray,
  SetFee: XRPL.gray,
  UNLModify: XRPL.gray,
  UNLReport: XRPL.gray,
}

/** One color per livenet family — not two blues, not leftover-orange. */
export const LANE_DEFS = [
  { id: 'proposed', label: 'proposed', color: '#64748B', y0: 0.0, y1: 0.16 },
  { id: 'Payment', label: 'Payment', color: '#22C55E', y0: 0.18, y1: 0.34 },
  {
    id: 'dex',
    label: 'DEX / AMM',
    color: '#3B82F6',
    y0: 0.34,
    y1: 0.5,
    labelParts: [
      { text: 'DEX', color: '#3B82F6' },
      { text: ' / ', color: '#64748B' },
      { text: 'AMM', color: '#A855F7' },
    ],
  },
  { id: 'amm', label: '', color: '#A855F7', y0: 0.34, y1: 0.5 },
  { id: 'nft', label: 'NFT', color: '#EC4899', y0: 0.5, y1: 0.62 },
  { id: 'account', label: 'Account', color: '#F97316', y0: 0.62, y1: 0.74 },
  { id: 'validation-unl', label: 'UNL votes', color: '#E5E7EB', y0: 0.76, y1: 0.88 },
  { id: 'validation-other', label: 'other validators', color: '#6B7280', y0: 0.88, y1: 1.0 },
]

const NFT = new Set([
  'NFTokenMint',
  'NFTokenBurn',
  'NFTokenCreateOffer',
  'NFTokenAcceptOffer',
  'NFTokenCancelOffer',
  'NFTokenModify',
])
const AMM = new Set([
  'AMMCreate',
  'AMMDeposit',
  'AMMWithdraw',
  'AMMBid',
  'AMMVote',
  'AMMDelete',
  'AMMClawback',
])
const PSEUDO = new Set(['EnableAmendment', 'SetFee', 'UNLModify', 'UNLReport'])

const ACCOUNT = new Set([
  'AccountSet',
  'AccountDelete',
  'SetRegularKey',
  'SignerListSet',
  'TicketCreate',
  'DepositPreauth',
  'DelegateSet',
])

export function laneForTxType(type) {
  if (!type) return 'account'
  if (type === 'Payment') return 'Payment'
  if (AMM.has(type)) return 'amm'
  if (type === 'OfferCreate' || type === 'OfferCancel' || type === 'TrustSet') return 'dex'
  if (NFT.has(type)) return 'nft'
  if (ACCOUNT.has(type) || PSEUDO.has(type)) return 'account'
  return 'account'
}

export function colorForType(type) {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type]
  if (NFT.has(type)) return TYPE_COLORS.NFTokenMint
  if (AMM.has(type)) return TYPE_COLORS.AMMDeposit
  if (PSEUDO.has(type)) return TYPE_COLORS.EnableAmendment
  const wheel = ['#22C55E', '#3B82F6', '#EC4899', '#F97316', '#9CA3AF']
  let h = 0
  const s = String(type || 'other')
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
  return wheel[h % wheel.length]
}

export function txBody(msg) {
  return msg?.tx_json || msg?.transaction || {}
}

export function txTypeOf(msg) {
  return txBody(msg).TransactionType || 'Unknown'
}

export function isProposed(msg) {
  return msg?.validated !== true
}

export function deliveredDrops(msg) {
  const meta = msg?.meta || msg?.metadata
  const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount
  if (typeof delivered === 'string' && /^\d+$/.test(delivered)) return Number(delivered)
  const body = txBody(msg)
  const amt = body.DeliverMax ?? body.Amount
  if (typeof amt === 'string' && /^\d+$/.test(amt)) return Number(amt)
  return 0
}

export function feeDrops(msg) {
  const fee = txBody(msg).Fee
  const n = Number(fee)
  return Number.isFinite(n) ? n : 0
}
