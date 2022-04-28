require('dotenv').config()

const fs = require('fs').promises

const { logLocation, sourcePath, cachePath, parseOptions } = require('./path-tools')
const { startJob, completeCachePath } = require('./cache')

const encoding = 'utf8'

const run = async () => {
  let json
  let entries
  try {
    json = await fs.readFile(logLocation, { encoding })
    entries = JSON.parse(json).map(entry => entry.split('||'))
  } catch (e) {
    console.dir(e)
    console.log("Couldn't read the image request log. Nothing to do.", logLocation)
    process.exit()
  }

  for (const entry of entries) {
    const [source, width, options] = entry
    const { accepts, quality, density } = parseOptions(options)
    const sourceTarget = sourcePath(source)
    const cacheTarget = cachePath({ source, accepts, width, quality, density })
    const canonicalPath = completeCachePath(cacheTarget)

    // Check if the source file still exists
    try {
      await fs.access(sourceTarget)
    } catch (e) {
      console.log('Source file missing:', source)
      continue
    }

    try {
      console.log(source, accepts, width, quality, density)

      await fs.access(canonicalPath) // Check that the file doesn't exist first
    } catch (e) {
      await startJob({ source, accepts, width: Number(width), quality, density }, false)
    }
  }

  process.exit()
}

run()
