const PATH = require('path')
const fs = require('fs').promises
const { addLogEntry } = require('./log')
const { sourcePath, cachePath } = require('./path-tools')
const { compressToSsim } = require('./compress')

const ssimLevels = {
  'basic': 0.9975,
  'ui': 0.9999
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
    await fs.access(sourceTarget)

    const compressed = await compressToSsim({
      source: sourceTarget,
      targetSsim: ssimLevels[quality],
      format, width 
    })

    try {
      await fs.mkdir(PATH.dirname(cacheTarget), { recursive: true })
    } catch (e) {}

    fs.writeFile(cacheTarget, compressed)
    return compressed
  }
}

module.exports = retrieve
