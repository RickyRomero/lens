const PATH = require('path')
const fs = require('fs').promises
const sharp = require('sharp')
const { compressOne } = require('./compress')

const sourceFetchAttempts = Number(process.env.SOURCE_FETCH_ATTEMPTS) || 3

// Normalised, so a trailing slash in the deploy parameter doesn't turn every
// request into a confusing 403.
const allowedOrigin = process.env.ALLOWED_ORIGIN
  ? new URL(process.env.ALLOWED_ORIGIN).origin
  : null
const supportedFormats = new Set(['jpeg', 'png', 'webp', 'avif'])

const maxSourceBytes = 64 * 1024 * 1024
const fetchTimeout = 1000 * 30

// Lambda caps a response payload at 6 MB, and base64 inflates by a third. Fail
// loudly under that rather than let AWS truncate the image.
const maxResponseBytes = Math.floor(4.5 * 1024 * 1024)

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

const cacheFile = srcHash => PATH.join('/tmp', `src-${srcHash}`)

const evictSourceCache = async () => {
  const entries = await fs.readdir('/tmp').catch(() => [])
  await Promise.all(
    entries
      .filter(entry => entry.startsWith('src-'))
      .map(entry => fs.unlink(PATH.join('/tmp', entry)).catch(() => {}))
  )
}

// Warm containers handle many variants of the same image (widths, densities,
// formats), so holding the source on local disk saves the origin a lot of
// repeated egress.
const fetchSource = async (sourceUrl, srcHash) => {
  let url
  try {
    url = new URL(sourceUrl)
  } catch (e) {
    throw fail(400, 'Malformed sourceUrl.')
  }

  // Signed URLs mean only this server can hand us work, but pinning the origin
  // stops the function from being usable as a general-purpose fetcher.
  if (!allowedOrigin || url.origin !== allowedOrigin) {
    throw fail(403, 'sourceUrl is not on the allowed origin.')
  }

  const cached = cacheFile(srcHash)
  const hit = await fs.readFile(cached).catch(() => null)
  if (hit) { return hit }

  // A dropped connection or a blip from the proxy in front of the origin is
  // transient and worth another go in-process -- far cheaper than failing the
  // job and having the whole invocation repeated. Deterministic answers (a bad
  // signature, a missing file) are not retried: they'd fail identically.
  let buffer
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(fetchTimeout) })

      if (response.status >= 400 && response.status < 500) {
        throw fail(502, `Origin returned ${response.status} for the source image.`)
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`Origin returned ${response.status} for the source image.`),
          { transient: true }
        )
      }

      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxSourceBytes) {
        throw fail(413, 'Source image is too large.')
      }

      buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxSourceBytes) {
        throw fail(413, 'Source image is too large.')
      }

      // A truncated body still decodes as "a file", so check it really is an
      // image before trusting it. Without this a short read could be written to
      // the /tmp cache and then reused by every later invocation on this
      // container -- one bad download poisoning everything that follows.
      if (declared && buffer.length !== declared) {
        throw Object.assign(
          new Error(`Truncated download: got ${buffer.length} of ${declared} bytes.`),
          { transient: true }
        )
      }
      await sharp(buffer).metadata()

      break
    } catch (e) {
      const retryable = e.transient || e.name === 'TimeoutError' || e.name === 'AbortError' ||
        e.cause !== undefined || /Input buffer|unsupported image format/i.test(e.message || '')

      if (!retryable || attempt >= sourceFetchAttempts) {
        if (e.statusCode) { throw e }
        throw fail(502, `Could not fetch a usable source after ${attempt} attempt(s): ${e.message}`)
      }

      console.warn(`Source fetch attempt ${attempt} failed (${e.message}); retrying.`)
      await new Promise(resolve => setTimeout(resolve, 250 * attempt))
    }
  }

  try {
    await fs.writeFile(cached, buffer)
  } catch (e) {
    // /tmp is finite and we never know which sources a container has seen.
    // Losing the cache is fine; losing the job is not.
    await evictSourceCache()
    await fs.writeFile(cached, buffer).catch(() => {})
  }

  return buffer
}

const parseRequest = event => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body

  let request
  try {
    request = JSON.parse(raw)
  } catch (e) {
    throw fail(400, 'Body must be JSON.')
  }

  const { sourceUrl, srcHash, format, width, quality, limits } = request

  if (!supportedFormats.has(format)) {
    throw fail(400, `Unsupported format: ${format}`)
  }
  if (!/^[0-9a-f]{8,64}$/.test(String(srcHash || ''))) {
    throw fail(400, 'srcHash must be a hex digest.')
  }
  if (!Number.isFinite(width) || width < 1) {
    throw fail(400, 'width must be a positive number.')
  }
  if (format !== 'png' && !quality && !limits) {
    throw fail(400, 'Either quality or limits is required.')
  }

  return { sourceUrl, srcHash, format, width, quality, limits }
}

exports.handler = async (event, context) => {
  let request
  try {
    request = parseRequest(event)
  } catch (e) {
    return { statusCode: e.statusCode || 400, body: e.message }
  }

  const { sourceUrl, srcHash, format, width, quality, limits } = request

  try {
    const source = await fetchSource(sourceUrl, srcHash)
    const result = await compressOne({
      source,
      format,
      width,
      quality,
      limits,
      remaining: () => context.getRemainingTimeInMillis()
    })

    if (result.skipped) {
      return {
        statusCode: 200,
        headers: { 'x-lens-format': format, 'x-lens-skipped': result.skipped }
      }
    }

    if (result.buffer.length > maxResponseBytes) {
      return {
        statusCode: 413,
        body: `Compressed ${format} is ${result.buffer.length} bytes, over the response limit.`
      }
    }

    // An OOM kills the environment outright, so the only warning you get is a
    // job that came close and survived. Report it rather than wait for the kill.
    const peakMb = Math.round(process.memoryUsage().rss / 1048576)
    const budgetMb = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) || 0
    if (budgetMb && peakMb > budgetMb * 0.8) {
      console.warn(`Peak RSS ${peakMb} MB of ${budgetMb} MB budget — near the OOM threshold.`)
    }

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'x-lens-format': format,
        'x-lens-quality': String(result.quality ?? ''),
        'x-lens-ssim': String(result.ssim ?? ''),
        'x-lens-peak-mb': String(peakMb)
      },
      body: result.buffer.toString('base64'),
      isBase64Encoded: true
    }
  } catch (e) {
    // Strip the query string before logging: it carries a live signature that
    // is good for this path for a few minutes, and CloudWatch keeps it for days.
    let target = '(unparseable sourceUrl)'
    try {
      const u = new URL(sourceUrl)
      target = u.origin + u.pathname
    } catch (parseError) { /* leave the placeholder */ }

    console.error('Compression failed:', format, target, e)
    return { statusCode: e.statusCode || 500, body: e.message }
  }
}
