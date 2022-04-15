require('dotenv').config()

const fs = require('fs').promises

const { logLocation } = require('./path-tools')
const retrieve = require('./cache')

const encoding = 'utf8'

const run = async () => {
  const json = await fs.readFile(logLocation, { encoding })
  const entries = JSON.parse(json).map(entry => entry.split('||'))

  for (const entry of entries) {
    const [source, format, width, quality] = entry
    try {
      console.log(source, format, width, quality)

      // This will return a buffer, but we don't care because it will
      // also recreate the file if it doesn't exist
      await retrieve({ source, format, width: Number(width), quality }, false)
    } catch (e) {
      console.dir(e)
    }
  }

  // Give the final write time to finish since retrieve() returns ASAP,
  // before writing has finished
  setTimeout(() => process.exit(), 5000)
}

run()
