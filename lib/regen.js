require('dotenv').config()

const fs = require('fs').promises

const { logLocation, cachePath } = require('./path-tools')
const { startJob } = require('./cache')

const encoding = 'utf8'

const run = async () => {
  let json
  let entries
  try {
    json = await fs.readFile(logLocation, { encoding })
    entries = JSON.parse(json).map(entry => entry.split('||'))
  } catch (e) {
    console.log("Couldn't read the image request log. Nothing to do.")
    process.exit()
  }

  for (const entry of entries) {
    const [source, format, width, quality] = entry
    const cacheTarget = cachePath({ source, format, width, quality })
    try {
      console.log(source, format, width, quality)

      await fs.access(cacheTarget) // Check that the file doesn't exist first
    } catch (e) {
      await startJob({ source, format, width: Number(width), quality }, false)
    }
  }

  process.exit()
}

run()
