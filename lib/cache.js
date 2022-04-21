const PATH = require('path')
const fs = require('fs').promises
const { addLogEntry } = require('./log')
const { sourcePath, cachePath } = require('./path-tools')
const { compress, compressToSsim } = require('./compress')

// I analyzed hundreds of images on high-end displays to decide on these parameters.
// https://docs.google.com/spreadsheets/d/1B_YUC9uXAepXWneojGq2shn62fopN_PLz3MzVhiQRrM/edit?usp=sharing
const compressionLimits = {
  ultra: { webp: 98, avif: 95 },
  '1x': {
    ssimTarget: 0.9996981048,
    quality: { webp: [85, 92], avif: [55, 80] },
    minBpp: { webp: 0.0401498781, avif: 0.008285544105 }
  },
  '2x': {
    ssimTarget: 0.9994126217,
    quality: { webp: [66, 85], avif: [46, 75] },
    minBpp: { webp: 0.03226950355, avif: 0.01441918772 }
  },
  '3x': {
    ssimTarget: 0.9991252686,
    quality: { webp: [41, 71], avif: [36, 65] },
    minBpp: { webp: 0.02282524379, avif: 0.007431571365 }
  }
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
  const { source, quality, format, width, density } = options
  const cacheTarget = cachePath({ source, format, width, quality, density })
  const sourceTarget = sourcePath(source)

  console.log('Compressing:', cacheTarget)

  let compressed
  if (quality === 'ultra') {
    compressed = await compress({
      source: sourceTarget,
      quality: compressionLimits.ultra[format],
      format, width
    })
  } else {
    compressed = await compressToSsim({
      source: sourceTarget,
      limits: compressionLimits[density],
      format, width 
    })
  }

  try {
    await fs.mkdir(PATH.dirname(cacheTarget), { recursive: true })
  } catch (e) {}

  await fs.writeFile(cacheTarget, compressed)

  return compressed
}

const retrieve = async (options, log = true) => {
  const { source, format, width, quality, density } = options
  const cacheTarget = cachePath({ source, format, width, quality, density })
  const sourceTarget = sourcePath(source)

  if (log) {
    addLogEntry({ source, format, width, quality, density })
  }

  try {
    return await fs.readFile(cacheTarget)
  } catch (e) {
    // Compressed asset doesn't exist.
    // We don't want to wait a year while we try to compress it, so kick off
    // the compression, but tell the middleware it needs to grab the source
    // version of the image.
    await fs.access(sourceTarget)

    queueJob({ source, format, width, quality, density })

    return false
  }
}

module.exports = { retrieve, startJob }
