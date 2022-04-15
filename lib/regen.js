require('dotenv').config()

const fs = require('fs').promises

const { logLocation, cachePath } = require('./path-tools')
const { startJob } = require('./cache')

const encoding = 'utf8'

const run = async () => {
  const json = await fs.readFile(logLocation, { encoding })
  const entries = JSON.parse(json).map(entry => entry.split('||'))

  for (const entry of entries) {
    const [source, format, width, quality] = entry
    const cacheTarget = cachePath({ source, format, width, quality })
    try {
      console.log(source, format, width, quality)

      await fs.access(cacheTarget) // Check that the file doesn't exist first
    } catch (e) {
      // This will return a buffer, but we don't care because it will
      // also recreate the file if it doesn't exist
      await startJob({ source, format, width: Number(width), quality }, false)
    }
  }

  process.exit()
}

run()
