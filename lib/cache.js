const PATH = require('path')
const fs = require('fs').promises
const { sourcePath, cachePath } = require('./path-tools')
const { compressToSsim } = require('./compress')

const ssimLevels = {
  'basic': 0.9975,
  'ui': 0.9999
}

const retrieve = async ({ source, format, width, quality = 'basic' }) => {
  const cacheTarget = cachePath({ source, format, width, quality })
  const sourceTarget = sourcePath(source)

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
