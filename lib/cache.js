const PATH = require('path')
const fs = require('fs').promises
const { addLogEntry } = require('./log')
const { sourcePath, cachePath } = require('./path-tools')
const { compressUsingBestFormat } = require('./compress')

const supportedFormats = ['jpeg', 'png', 'webp', 'avif']
const formatMap = new Map()

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
  const { accepts, source, quality, width, density } = options
  const cacheTarget = cachePath({ accepts, source, width, quality, density })
  const sourceTarget = sourcePath(source)

  console.log('Compressing:', cacheTarget)

  let compressed
  if (quality === 'ultra') {
    compressed = await compressUsingBestFormat({
      source: sourceTarget,
      quality: compressionLimits.ultra,
      accepts, width 
    })
  } else {
    compressed = await compressUsingBestFormat({
      source: sourceTarget,
      limits: compressionLimits[density],
      accepts, width 
    })
  }

  const { buffer, format } = compressed
  const fullCachePath = `${cacheTarget}.${format}`
  formatMap.set(cacheTarget, format)

  try {
    await fs.mkdir(PATH.dirname(fullCachePath), { recursive: true })
  } catch (e) {}

  await fs.writeFile(fullCachePath, buffer)

  return buffer
}

const completeCachePath = async target => {
  if (!formatMap.has(target)) {
    for (let format of supportedFormats) {
      try {
        await fs.access(`${target}.${format}`)
        formatMap.set(target, format)
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
  const { source, accepts, width, quality, density } = options
  const cacheTarget = cachePath({ source, accepts, width, quality, density })
  const sourceTarget = sourcePath(source)

  if (log) {
    addLogEntry({ source, accepts, width, quality, density })
  }

  try {
    const canonicalCachePath = await completeCachePath(cacheTarget)
    const format = PATH.extname(canonicalCachePath)
    return {
      buffer: await fs.readFile(canonicalCachePath),
      format
    }
  } catch (e) {
    // Compressed asset doesn't exist.
    // We don't want to wait a year while we try to compress it, so kick off
    // the compression, but tell the middleware it needs to grab the source
    // version of the image.
    await fs.access(sourceTarget)

    queueJob({ source, accepts, width, quality, density })

    return false
  }
}

module.exports = { retrieve, startJob, completeCachePath }
