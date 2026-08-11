require('dotenv').config()

const fs = require('fs').promises
const PATH = require('path')

const {
  logLocation, sourcePath, cachePath, sourceHash, parseOptions
} = require('./path-tools')
const { signedSourceUrl } = require('./signing')
const { startJob, completeCachePath } = require('./cache')

const encoding = 'utf8'
const concurrency = Number(process.env.MAX_CONCURRENT_JOBS) || 4

// Nothing here is interactive, and every entry fans out to one Lambda
// invocation per format. If something is broken, an unattended run will happily
// fire thousands of doomed invocations in a couple of minutes, so it stops
// itself once failures stop looking like bad luck.
const abortAfter = Number(process.env.REGEN_ABORT_AFTER) || 10

// Exiting isn't enough on its own: under `restart: always` or `unless-stopped`
// Docker just starts the run again and the in-process counter resets, so the
// breaker would trip forever instead of once. Record the abort somewhere that
// outlives the container -- CACHE_DIR is already a persistent volume -- and
// refuse to start again until it ages out.
const cooldown = Number(process.env.REGEN_COOLDOWN_MS) || 1000 * 60 * 15
const abortMarker = PATH.join(PATH.resolve(process.env.CACHE_DIR), '.regen-aborted')

const coolingDown = async () => {
  try {
    const { mtimeMs } = await fs.stat(abortMarker)
    const age = Date.now() - mtimeMs
    if (age >= cooldown) { return false }

    logError(`a previous run aborted ${Math.round(age / 1000)}s ago; cooling down.`)
    logError(`  Retrying automatically would just re-run the same failures, so this`)
    logError(`  exits without contacting Lambda at all. Waiting ${Math.round((cooldown - age) / 1000)}s more,`)
    logError(`  or delete ${abortMarker} to override.`)
    return true
  } catch (e) {
    return false   // no marker, nothing to wait for
  }
}

const stamp = () => new Date().toISOString()
const log = (...args) => console.log(stamp(), '[lens]', ...args)
const logError = (...args) => console.error(stamp(), '[lens]', ...args)

// Compression is remote, but Lambda fetches the originals back through the
// public origin -- so regen depends on the web server being up, which is not
// obvious and fails in a confusing way. Prove the whole path works on one
// request before spending thousands.
const preflight = async source => {
  const url = signedSourceUrl(source)
  const shown = new URL(url).origin + new URL(url).pathname

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      logError(`preflight failed: ${shown} returned HTTP ${response.status}`)
      logError('  Lambda fetches source images through this URL, so regen cannot')
      logError('  work until it serves. Is the Express server running behind the proxy?')
      return false
    }
  } catch (e) {
    logError(`preflight failed: could not reach ${shown}`)
    logError(' ', (e.cause && e.cause.message) || e.message)
    return false
  }

  log('preflight ok:', shown)
  return true
}

const processEntry = async entry => {
  const [source, width, options] = entry
  const { accepts, quality, density } = parseOptions(options)

  // The hash comes from the source as it exists now, which is why the log
  // doesn't record it: an entry describes a request, not a revision.
  let stat
  try {
    stat = await fs.stat(sourcePath(source))
  } catch (e) {
    log('skipped  source file missing:', source)
    return 'skipped'
  }

  const srcHash = sourceHash(stat)
  const job = {
    source, accepts, quality, density, srcHash, width: Number(width)
  }

  // Check that the file doesn't exist first
  if (await completeCachePath(cachePath(job))) { return 'cached' }

  // startJob logs the full round trip itself, so nothing to announce here.
  await startJob(job)
  return 'compressed'
}

const run = async () => {
  let entries
  try {
    const json = await fs.readFile(logLocation, { encoding })
    entries = JSON.parse(json).map(entry => entry.split('||'))
  } catch (e) {
    console.dir(e)
    console.log("Couldn't read the image request log. Nothing to do.", logLocation)
    process.exit(1)
  }

  if (entries.length === 0) {
    log('nothing to do: the request log is empty')
    process.exit(0)
  }

  // Exit 0 while cooling down: a non-zero code makes `restart: on-failure`
  // relaunch us, which is the loop this is here to prevent.
  if (await coolingDown()) { process.exit(0) }

  if (!await preflight(entries[0][0])) { process.exit(1) }

  const queue = entries.slice()
  const counts = { compressed: 0, cached: 0, skipped: 0, failed: 0 }
  let consecutiveFailures = 0
  let aborted = false

  // Work is remote now, so run a few at a time instead of one after another.
  const worker = async () => {
    while (queue.length > 0 && !aborted) {
      const entry = queue.shift()
      try {
        const outcome = await processEntry(entry)
        counts[outcome]++
        // Only real work clears the breaker. Cache hits and missing sources
        // would otherwise mask a steady drip of failures.
        if (outcome === 'compressed') { consecutiveFailures = 0 }
      } catch (e) {
        counts.failed++
        consecutiveFailures++
        logError(`failed   ${entry.join('||')} - ${e.message}`)

        // Every worker in flight lands here at once; only the first should trip.
        if (!aborted && consecutiveFailures >= abortAfter) {
          aborted = true
          await fs.writeFile(abortMarker, stamp()).catch(() => {})
          logError(`aborting: ${consecutiveFailures} consecutive failures.`)
          logError('  Nothing is being produced, so the rest of the run would only')
          logError('  burn Lambda invocations. Fix the cause and run regen again;')
          logError('  work already cached is skipped, so it picks up where it left off.')
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  // Got to the end without tripping, so clear any cooldown from a past run.
  if (!aborted) { await fs.unlink(abortMarker).catch(() => {}) }

  log(`finished: ${counts.compressed} compressed, ${counts.cached} already cached, ` +
    `${counts.skipped} skipped, ${counts.failed} failed` +
    (aborted ? `, ${queue.length} not attempted` : ''))

  process.exit(aborted ? 1 : 0)
}

run()
