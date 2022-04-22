const fs = require('fs').promises
const { logLocation } = require('./path-tools')

const writeInterval = 1000 * 60 * 10
// const writeInterval = 1000 * 10 // for debugging
const encoding = 'utf8'
let pendingWrites = new Set()

const addLogEntry = ({ source, format, width, quality, density }) => {
  pendingWrites.add(
    [source, format, width, quality, density].join('||')
  )
}

const writeBatch = async () => {
  let logJson
  try {
    logJson = await fs.readFile(logLocation, { encoding })
  } catch (e) {
    logJson = '[]'
  }
  let logContents = [
    ...new Set([
      ...JSON.parse(logJson),
      ...[...pendingWrites]
    ])
  ].sort()

  await fs.writeFile(logLocation, JSON.stringify(logContents, null, 2), { encoding })
  pendingWrites.clear()

  setTimeout(writeBatch, writeInterval)
}

writeBatch()

module.exports = { addLogEntry }
