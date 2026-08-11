const PATH = require('path')
const fs = require('fs').promises
const { addLogEntry } = require('./log')
const { cachePath, cacheVariant } = require('./path-tools')
const { signedSourceUrl } = require('./signing')
const { compressFormat } = require('./compress')

const supportedFormats = ['jpeg', 'png', 'webp', 'avif']
const formatMap = new Map()

// Compression happens on someone else's computer now, so the origin log is the
// only place the whole round trip is visible. Timestamped because this runs
// under whatever process manager the VPS uses.
const stamp = () => new Date().toISOString()
const log = (...args) => console.log(stamp(), '[lens]', ...args)
const logError = (...args) => console.error(stamp(), '[lens]', ...args)
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`
const secs = ms => `${(ms / 1000).toFixed(1)}s`

// I analyzed hundreds of images on high-end displays to decide on these parameters.
// https://docs.google.com/spreadsheets/d/1B_YUC9uXAepXWneojGq2shn62fopN_PLz3MzVhiQRrM/edit?usp=sharing
const compressionLimits = {
  ultra: { jpeg: 99, webp: 98, avif: 95 },
  '1x': {
    ssimTarget: 0.9996981048,
    quality: { jpeg: [60, 95], webp: [85, 92], avif: [55, 80] }
  },
  '2x': {
    ssimTarget: 0.9994126217,
    quality: { jpeg: [55, 80], webp: [66, 85], avif: [46, 75] }
  },
  '3x': {
    ssimTarget: 0.9991252686,
    quality: { jpeg: [47, 80], webp: [41, 71], avif: [36, 65] }
  }
}

// Compression happens in Lambda now, so jobs no longer compete for local CPU and
// several can be in flight at once.
const maxConcurrentJobs = Number(process.env.MAX_CONCURRENT_JOBS) || 4

// A failing job can be expensive: every attempt may burn up to the full Lambda
// timeout, per format, before it errors. Back off geometrically and then stop
// entirely, rather than paying that bill on a fixed interval forever.
const failureBackoff = Number(process.env.FAILURE_BACKOFF_MS) || 1000 * 60 * 5
const maxJobAttempts = Number(process.env.MAX_JOB_ATTEMPTS) || 4

const queuedJobs = new Set()
const activeJobs = new Set()
const failedJobs = new Map()

const describe = o =>
  `${o.source} w=${o.width} d=${o.density} q=${o.quality} ` +
  `accepts=${o.accepts.join(',')} hash=${o.srcHash}`

const queueJob = options => {
  const key = JSON.stringify(options)
  if (queuedJobs.has(key) || activeJobs.has(key)) { return }

  const failure = failedJobs.get(key)
  if (failure) {
    // Given up on. The key includes the source hash, so replacing or re-saving
    // the source produces a new key and the work is attempted fresh.
    if (failure.attempts >= maxJobAttempts) { return }
    if (Date.now() < failure.retryAfter) {
      log('backoff  waiting', secs(failure.retryAfter - Date.now()),
        `(attempt ${failure.attempts}/${maxJobAttempts})`, options.source)
      return
    }
  }

  queuedJobs.add(key)
  log('queued  ', describe(options), `[${queuedJobs.size} waiting, ${activeJobs.size} active]`)
  drainQueue()
}

const drainQueue = () => {
  while (activeJobs.size < maxConcurrentJobs && queuedJobs.size > 0) {
    const key = queuedJobs.values().next().value
    queuedJobs.delete(key)
    activeJobs.add(key)
    runJob(key)
  }
}

const runJob = async key => {
  try {
    await startJob(JSON.parse(key))
    failedJobs.delete(key)
  } catch (e) {
    // A rejection here used to leave the job in the queue with the running flag
    // stuck on, which wedged compression for the life of the process. Back the
    // job off instead so one bad source can't spin.
    // A permanent failure gets no retries at all: burn the attempt budget up
    // front so it quarantines on the first try instead of the fourth.
    const attempts = e.permanent
      ? maxJobAttempts
      : (failedJobs.get(key)?.attempts || 0) + 1
    const retryAfter = Date.now() + (failureBackoff * Math.pow(3, attempts - 1))
    failedJobs.set(key, { attempts, retryAfter })

    const job = JSON.parse(key)
    if (e.permanent) {
      logError('failed   permanently, not retrying until the source changes:',
        job.source, '-', e.message)
    } else if (attempts >= maxJobAttempts) {
      logError(`failed   ${attempts}x, giving up until the source changes:`,
        job.source, '-', e.message)
    } else {
      logError(`failed   attempt ${attempts}/${maxJobAttempts}, retrying in`,
        secs(retryAfter - Date.now()) + ':', job.source, '-', e.message)
    }
  } finally {
    activeJobs.delete(key)
    drainQueue()
  }
}

// Cache filenames carry the source hash, so anything sharing this variant's
// prefix under a different hash was built from a source revision we've replaced.
const sweepStaleVariants = async options => {
  const { dir, prefix } = cacheVariant(options)
  const keep = `${prefix}${options.srcHash}.`
  const entries = await fs.readdir(dir).catch(() => [])
  const stale = entries.filter(e => e.startsWith(prefix) && !e.startsWith(keep))

  await Promise.all(stale.map(e => fs.unlink(PATH.join(dir, e)).catch(() => {})))

  return stale
}

const startJob = async options => {
  const { accepts, source, quality, width, density, srcHash } = options
  const cacheTarget = cachePath({ accepts, source, width, quality, density, srcHash })
  const sourceUrl = signedSourceUrl(source)
  const ultra = quality === 'ultra'

  const startedAt = Date.now()
  log('start   ', describe(options))

  // One invocation per format, in parallel, so the slowest format sets the wall
  // clock instead of the sum of all of them.
  const results = await Promise.allSettled(accepts.map(format => compressFormat({
    sourceUrl,
    srcHash,
    format,
    width,
    quality: ultra ? compressionLimits.ultra[format] : undefined,
    limits: ultra ? undefined : compressionLimits[density]
  })))

  const candidates = []
  const failures = []
  let permanent = false
  results.forEach((result, index) => {
    const format = accepts[index].padEnd(4)

    if (result.status === 'rejected') {
      // 413 means the work itself is too big for the function, not that
      // something went wrong in transit. Identical inputs will fail identically,
      // so there is nothing to gain from retrying it.
      if (result.reason.status === 413) { permanent = true }
      logError(`  ${format} FAILED  ${result.reason.message}`)
      failures.push(`${accepts[index]}: ${result.reason.message}`)
      return
    }

    const r = result.value
    if (r.skipped) {
      log(`  ${format} skipped ${r.skipped.padEnd(24)} ${secs(r.ms).padStart(6)}`)
      return
    }

    log(
      `  ${format} ok      ${kb(r.buffer.length).padStart(10)}` +
      `  q=${String(r.quality ?? '-').padEnd(4)}` +
      `  ssim=${r.ssim ? Number(r.ssim).toFixed(7) : '-'.padEnd(9)}` +
      `  peak=${(r.peakMb ? r.peakMb + 'MB' : '-').padStart(6)}` +
      `  ${secs(r.ms).padStart(6)}`
    )
    candidates.push(r)
  })

  // Whatever wins here gets cached until the source changes, so a partial result
  // isn't good enough: if avif were throttled while jpeg succeeded we'd quietly
  // enshrine the jpeg. Fail the job and let the backoff retry it intact.
  if (failures.length > 0) {
    throw Object.assign(
      new Error(`Format(s) failed for ${source} — ${failures.join('; ')}`),
      { permanent }
    )
  }

  if (candidates.length === 0) {
    throw new Error(`No format produced output for ${source}`)
  }

  candidates.sort((a, b) => a.buffer.length - b.buffer.length)

  const { buffer, format } = candidates[0]
  const runnerUp = candidates[1]
  const margin = runnerUp
    ? ` (next best ${runnerUp.format} ${kb(runnerUp.buffer.length)}, ` +
      `${((runnerUp.buffer.length / buffer.length - 1) * 100).toFixed(0)}% larger)`
    : ''
  log(`  winner   ${format} ${kb(buffer.length)}${margin}`)

  const fullCachePath = `${cacheTarget}.${format}`

  await fs.mkdir(PATH.dirname(fullCachePath), { recursive: true })
  await fs.writeFile(fullCachePath, buffer)
  formatMap.set(cacheTarget, format)

  const swept = await sweepStaleVariants({ accepts, source, width, quality, density, srcHash })
  if (swept.length > 0) {
    log(`  swept    ${swept.length} stale file(s): ${swept.join(', ')}`)
  }

  log('done    ', PATH.basename(fullCachePath), 'in', secs(Date.now() - startedAt))

  return buffer
}

const completeCachePath = async target => {
  if (!formatMap.has(target)) {
    for (const format of supportedFormats) {
      try {
        await fs.access(`${target}.${format}`)
        formatMap.set(target, format)
        break
      } catch (e) {
        continue
      }
    }
  }

  if (!formatMap.has(target)) {
    return false
  } else {
    return `${target}.${formatMap.get(target)}`
  }
}

const retrieve = async (options, log = true) => {
  const { source, accepts, width, quality, density, srcHash } = options
  const cacheTarget = cachePath({ source, accepts, width, quality, density, srcHash })

  if (log) {
    addLogEntry({ source, accepts, width, quality, density })
  }

  const canonicalCachePath = await completeCachePath(cacheTarget)
  if (canonicalCachePath) {
    try {
      return {
        buffer: await fs.readFile(canonicalCachePath),
        format: PATH.extname(canonicalCachePath)
      }
    } catch (e) {
      // Swept out from under us, or never finished writing. Rebuild it.
      formatMap.delete(cacheTarget)
    }
  }

  // We don't want to wait a year while we try to compress it, so kick off
  // the compression, but tell the middleware it needs to grab the source
  // version of the image.
  queueJob({ source, accepts, width, quality, density, srcHash })

  return false
}

module.exports = { retrieve, startJob, completeCachePath }
