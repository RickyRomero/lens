const PATH = require('path')
const crypto = require('crypto')

// Bumping this invalidates every cached image, since it feeds the source hash
// baked into each cache filename. Bump it whenever the codec settings in
// lambda/compress.js change, instead of wiping CACHE_DIR by hand.
const CODEC_GENERATION = 3

const sourceLocation = PATH.resolve(process.env.SOURCE_DIR)
const cacheLocation = PATH.resolve(process.env.CACHE_DIR)
const logLocation = PATH.resolve(process.env.REGEN_LOG)

const densityMeta = { mask: 0b11, offset: 10 }
const densityTable = {
  '1x': 0b00,
  '2x': 0b01,
  '3x': 0b10,
  rsv1: 0b11
}

const qualityMeta = { mask: 0b11, offset: 8 }
const qualityTable = {
  normal: 0b00,
  ultra:  0b01,
  rsv1:   0b10,
  rsv2:   0b11
}

const acceptMeta = { mask: 0b11111111, offset: 0 }
const acceptFlags = {
  jpeg: 0b00000001,
  png:  0b00000010,
  webp: 0b00000100,
  avif: 0b00001000,
  rsv1: 0b00010000,
  rsv2: 0b00100000,
  rsv3: 0b01000000,
  rsv4: 0b10000000
}

const stringifyOptions = opts => {
  const { accepts, density, quality } = opts

  const acceptBits = (
    (acceptFlags.jpeg & (accepts.includes('jpeg') ? acceptMeta.mask : 0)) |
    (acceptFlags.png  & (accepts.includes('png') ? acceptMeta.mask : 0))  |
    (acceptFlags.webp & (accepts.includes('webp') ? acceptMeta.mask : 0)) |
    (acceptFlags.avif & (accepts.includes('avif') ? acceptMeta.mask : 0))
  ) << acceptMeta.offset
  const qualityBits = qualityTable[quality] << qualityMeta.offset
  const densityBits = densityTable[density] << densityMeta.offset

  return acceptBits | qualityBits | densityBits
}

const parseOptions = bits => {
  let accepts = []
  let density
  let quality
  const acceptBits = (bits >> acceptMeta.offset) & acceptMeta.mask
  const qualityBits = (bits >> qualityMeta.offset) & qualityMeta.mask
  const densityBits = (bits >> densityMeta.offset) & densityMeta.mask

  Object.keys(acceptFlags).forEach(format => {
    if (acceptFlags[format] & acceptBits) { accepts.push(format) }
  })
  quality = Object.keys(qualityTable).find(
    q => qualityTable[q] === qualityBits
  )
  density = Object.keys(densityTable).find(
    d => densityTable[d] === densityBits
  )

  return { accepts, density, quality }
}

const sourcePath = source => PATH.join(sourceLocation, source)

// Cheap cache busting: mtime and size, rather than reading 20+ MB of pixels on
// every request just to hash them. A non-preserving copy of a source will bust
// the cache needlessly, which is a much better failure than serving stale bytes.
const sourceHash = stat => crypto.createHash('sha256')
  .update(`${Math.round(stat.mtimeMs)}:${stat.size}:${CODEC_GENERATION}`)
  .digest('hex')
  .slice(0, 8)

// Everything identifying a cache entry except which source revision produced it.
// The trailing dot keeps the prefix unambiguous, so `foo.256.15.` can't match
// `foo.2560.15.<hash>.avif`.
const cacheVariant = ({ accepts, source, width, density, quality }) => {
  const ext = PATH.extname(source)
  const basename = PATH.basename(source, ext)
  const dirname = PATH.dirname(source)
  const optionsHash = stringifyOptions({ accepts, density, quality })

  return {
    dir: PATH.resolve(cacheLocation, dirname),
    prefix: `${basename}.${width}.${optionsHash}.`
  }
}

const cachePath = ({ accepts, source, width, density, quality, srcHash }) => {
  const { dir, prefix } = cacheVariant({ accepts, source, width, density, quality })
  return PATH.resolve(dir, `${prefix}${srcHash}`)
}

const isFilePath = userPath => PATH.extname(userPath) !== ''
const sterilizePath = userPath => (
  PATH.normalize(`/${userPath}`).replace(/^\//, '')
)

module.exports = {
  cachePath,
  cacheVariant,
  sourcePath,
  sourceHash,
  logLocation,
  isFilePath,
  sterilizePath,

  stringifyOptions,
  parseOptions
}
