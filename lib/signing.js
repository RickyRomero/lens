const crypto = require('crypto')

// Lambda fetches source images back out of this server over plain HTTP, so the
// endpoint that serves them needs to be closed off. The origin signs a URL that
// is only good for one path and a few minutes; Lambda just fetches it and never
// holds the key.
const lifetime = 1000 * 60 * 5

const key = () => {
  const secret = process.env.RAW_SIGNING_KEY
  if (!secret) {
    throw new Error('RAW_SIGNING_KEY is not set.')
  }
  return secret
}

const digest = (path, exp) => crypto
  .createHmac('sha256', key())
  .update(`${path}|${exp}`)
  .digest('base64url')

const rawPrefix = '/_origin/raw'

const sign = path => {
  const exp = Date.now() + lifetime
  return { exp, sig: digest(path, exp) }
}

// The full URL Lambda should fetch. Signing here means Lambda holds no secret of
// ours at all; it just replays a URL that stops working in a few minutes.
const signedSourceUrl = path => {
  const base = process.env.ORIGIN_BASE_URL
  if (!base) {
    throw new Error('ORIGIN_BASE_URL is not set.')
  }

  const { exp, sig } = sign(path)
  const url = new URL(`${rawPrefix}/${path}`, base)
  url.searchParams.set('exp', exp)
  url.searchParams.set('sig', sig)

  return url.toString()
}

const verify = (path, exp, sig) => {
  const expiry = Number(exp)
  if (!Number.isFinite(expiry) || Date.now() > expiry) { return false }
  if (typeof sig !== 'string') { return false }

  const expected = Buffer.from(digest(path, exp))
  const supplied = Buffer.from(sig)

  // timingSafeEqual throws rather than returning false on a length mismatch.
  if (expected.length !== supplied.length) { return false }

  return crypto.timingSafeEqual(expected, supplied)
}

module.exports = { sign, signedSourceUrl, verify, rawPrefix }
