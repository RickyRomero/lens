const fs = require('fs').promises
const { logLocation, stringifyOptions } = require('./path-tools')

const writeInterval = 1000 * 60 * 10
// const writeInterval = 1000 * 10 // for debugging
const encoding = 'utf8'
let pendingWrites = new Set()

const addLogEntry = ({ source, accepts, width, quality, density }) => {
  const options = stringifyOptions({ accepts, quality, density })
  pendingWrites.add(
    [source, width, options].join('||')
  )
}

let timer

const schedule = () => {
  timer = setTimeout(writeBatch, writeInterval)
  // Don't hold a short-lived process open just for the next flush.
  if (timer.unref) { timer.unref() }
}

const writeBatch = async () => {
  // With nothing pending there is nothing to add, and rewriting the file anyway
  // is pure downside: it's how a process.exit() elsewhere managed to catch this
  // mid-write and leave a zero-byte log behind.
  if (pendingWrites.size > 0) {
    let baseLog
    try {
      baseLog = JSON.parse(await fs.readFile(logLocation, { encoding }))
    } catch (e) {
      baseLog = []
    }
    const logContents = [...new Set([...baseLog, ...pendingWrites])].sort()

    // Write to one side and rename into place. Rename is atomic within a
    // filesystem, so an interrupted flush leaves the previous log intact
    // instead of a truncated one.
    const temp = `${logLocation}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(logContents, null, 2), { encoding })
    await fs.rename(temp, logLocation)

    pendingWrites.clear()
  }

  schedule()
}

// Scheduled rather than called: importing this module should never rewrite the
// log, and until now merely requiring it did exactly that.
schedule()

module.exports = { addLogEntry }
