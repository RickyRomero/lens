require('dotenv').config()

const fs = require('fs').promises

const {
  logLocation, sourcePath, cachePath, sourceHash, parseOptions
} = require('./path-tools')
const { startJob, completeCachePath } = require('./cache')

const encoding = 'utf8'
const concurrency = Number(process.env.MAX_CONCURRENT_JOBS) || 4

const processEntry = async entry => {
  const [source, width, options] = entry
  const { accepts, quality, density } = parseOptions(options)

  // The hash comes from the source as it exists now, which is why the log
  // doesn't record it: an entry describes a request, not a revision.
  let stat
  try {
    stat = await fs.stat(sourcePath(source))
  } catch (e) {
    console.log(new Date().toISOString(), '[lens] skipped  source file missing:', source)
    return
  }

  const srcHash = sourceHash(stat)
  const job = {
    source, accepts, quality, density, srcHash, width: Number(width)
  }

  // Check that the file doesn't exist first
  if (await completeCachePath(cachePath(job))) { return }

  // startJob logs the full round trip itself, so nothing to announce here.
  await startJob(job)
}

const run = async () => {
  let entries
  try {
    const json = await fs.readFile(logLocation, { encoding })
    entries = JSON.parse(json).map(entry => entry.split('||'))
  } catch (e) {
    console.dir(e)
    console.log("Couldn't read the image request log. Nothing to do.", logLocation)
    process.exit()
  }

  // Work is remote now, so run a few at a time instead of one after another.
  const queue = entries.slice()
  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift()
      try {
        await processEntry(entry)
      } catch (e) {
        console.error('Failed:', entry.join('||'), e.message)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  process.exit()
}

run()
