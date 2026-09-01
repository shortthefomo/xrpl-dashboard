import { decode, encodeNodePublic } from 'xrpl'

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '')
  if (h.length % 2) return new Uint8Array()
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s.toUpperCase()
}

function nodeKey(hexOrBytes) {
  const bytes = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes) : hexOrBytes
  return encodeNodePublic(bytes)
}

function parseBlob(b64) {
  return JSON.parse(new TextDecoder().decode(b64ToBytes(b64)))
}

/** Ripple's published UNL — public Clio has no admin `validators` command. */
export async function loadPublishedUnl() {
  const urls = ['/unl', 'https://vl.ripple.com']
  let data = null
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: 'no-cache' })
      if (!r.ok) continue
      const json = await r.json()
      if (json?.blob || json?.['blobs-v2']) {
        data = json
        break
      }
    } catch {
      /* try next */
    }
  }
  if (!data) return null

  const blobs = []
  if (data.blob) blobs.push(data.blob)
  for (const b of data['blobs-v2'] || []) if (b?.blob) blobs.push(b.blob)

  const unl = new Set()
  const signing = {}
  const rev = {}
  const trusted = new Set()

  for (const b64 of blobs) {
    let blob
    try {
      blob = parseBlob(b64)
    } catch {
      continue
    }
    for (const v of blob.validators || []) {
      let master
      try {
        master = nodeKey(v.validation_public_key)
      } catch {
        continue
      }
      unl.add(master)
      trusted.add(master)
      if (!v.manifest) continue
      try {
        const hex = /^[0-9A-Fa-f]+$/.test(v.manifest)
          ? v.manifest
          : bytesToHex(b64ToBytes(v.manifest))
        const m = decode(hex)
        if (m.SigningPubKey) {
          const eph = nodeKey(m.SigningPubKey)
          signing[master] = eph
          rev[eph] = master
          trusted.add(eph)
        }
        if (m.PublicKey) trusted.add(nodeKey(m.PublicKey))
      } catch {
        /* skip bad manifest */
      }
    }
  }
  if (!unl.size) return null
  return { unl, signing, rev, trusted, count: unl.size }
}
