const aws4 = require('aws4')

// Lambda's own ceiling is 15 minutes, so give up just past it rather than hold
// a socket open forever if something goes wrong in between.
const timeout = 1000 * 60 * 16

const credentials = () => ({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN
})

const compressFormat = async ({ sourceUrl, srcHash, format, width, quality, limits }) => {
  const endpoint = process.env.LENS_LAMBDA_URL
  if (!endpoint) {
    throw new Error('LENS_LAMBDA_URL is not set.')
  }

  const url = new URL(endpoint)
  const body = JSON.stringify({ sourceUrl, srcHash, format, width, quality, limits })

  // The function URL is IAM-authenticated, so unsigned requests are rejected by
  // AWS before the function ever runs and never show up on the bill.
  const signed = aws4.sign({
    host: url.host,
    path: `${url.pathname}${url.search}`,
    service: 'lambda',
    region: process.env.AWS_REGION,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  }, credentials())

  // fetch sets Host itself from the URL, to the same value aws4 just signed.
  delete signed.headers.Host

  const startedAt = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(timeout)
  })
  const ms = Date.now() - startedAt

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw Object.assign(
      new Error(`Lambda returned ${response.status} for ${format}: ${detail}`.trim()),
      { status: response.status, ms }
    )
  }

  if (response.headers.get('x-lens-skipped')) {
    return { format, ms, skipped: response.headers.get('x-lens-skipped') }
  }

  return {
    format,
    ms,
    buffer: Buffer.from(await response.arrayBuffer()),
    quality: response.headers.get('x-lens-quality') || undefined,
    ssim: response.headers.get('x-lens-ssim') || undefined,
    peakMb: response.headers.get('x-lens-peak-mb') || undefined
  }
}

module.exports = { compressFormat }
