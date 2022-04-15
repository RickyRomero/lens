const PATH = require('path')

const sourceLocation = PATH.resolve(process.env.SOURCE_DIR)
const cacheLocation = PATH.resolve(process.env.CACHE_DIR)
const logLocation = PATH.resolve(process.env.REGEN_LOG)

const sourcePath = source => PATH.join(sourceLocation, source)

const cachePath = ({ source, format, width, quality }) => {
  const ext = PATH.extname(source)
  const basename = PATH.basename(source, ext)
  const dirname = PATH.dirname(source)
  const cachename = `${basename}.${width}.${quality}.${format}`
  return PATH.resolve(cacheLocation, dirname, cachename)
}

const isFilePath = userPath => PATH.extname(userPath) !== ''
const sterilizePath = userPath => (
  PATH.normalize(`/${userPath}`).replace(/^\//, '')
)

module.exports = {
  cachePath,
  sourcePath,
  logLocation,
  isFilePath,
  sterilizePath
}
