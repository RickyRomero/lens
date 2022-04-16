const PATH = require('path')
const fs = require('fs').promises
const { addLogEntry } = require('./log')
const { sourcePath, cachePath } = require('./path-tools')
const { compressToSsim } = require('./compress')

const ssimLevels = {
  'basic': 0.9975,
  'ui': 0.9999
}

let jobRunning = false
const queuedJobs = new Set()
const queueJob = options => {
  const serializedOptions = JSON.stringify(options)
  if (queuedJobs.has(serializedOptions)) {
    return
  } else {
    queuedJobs.add(serializedOptions)
    if (!jobRunning) { runNextJob() }
  }
}

const runNextJob = async () => {
  jobRunning = true

  const serializedJob = [...queuedJobs].shift()
  const job = JSON.parse(serializedJob)

  await startJob(job)
  queuedJobs.delete(serializedJob)

  if (queuedJobs.size > 0) { 
    runNextJob()
  } else {
    jobRunning = false
  }
}

const startJob = async options => {
  const { source, quality, format, width } = options
  const cacheTarget = cachePath({ source, format, width, quality })
  const sourceTarget = sourcePath(source)
  const serializedOptions = JSON.stringify(options)

  const compressed = await compressToSsim({
    source: sourceTarget,
    targetSsim: ssimLevels[quality],
    format, width 
  })

  try {
    await fs.mkdir(PATH.dirname(cacheTarget), { recursive: true })
  } catch (e) {}

  await fs.writeFile(cacheTarget, compressed)

  return compressed
}

const retrieve = async (options, log = true) => {
  const { source, format, width, quality = 'basic' } = options
  const cacheTarget = cachePath({ source, format, width, quality })
  const sourceTarget = sourcePath(source)

  if (log) {
    addLogEntry({ source, format, width, quality })
  }

  try {
    return await fs.readFile(cacheTarget)
  } catch (e) {
    // Compressed asset doesn't exist.
    // We don't want to wait a year while we try to compress it, so kick off
    // the compression, but tell the middleware it needs to grab the source
    // version of the image.
    await fs.access(sourceTarget)

    queueJob({ source, format, width, quality })

    return false
  }
}

module.exports = { retrieve, startJob }
