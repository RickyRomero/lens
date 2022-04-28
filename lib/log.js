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

const writeBatch = async () => {
  let baseLog
  try {
    baseLog = JSON.parse(await fs.readFile(logLocation, { encoding }))
  } catch (e) {
    baseLog = []
  }
  let logContents = [
    ...new Set([
      ...baseLog,
      ...[...pendingWrites]
    ])
  ].sort()

  await fs.writeFile(logLocation, JSON.stringify(logContents, null, 2), { encoding })
  pendingWrites.clear()

  setTimeout(writeBatch, writeInterval)
}

writeBatch()

module.exports = { addLogEntry }
