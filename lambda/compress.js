const sharp = require('sharp')
const ssim = require('ssim.js').default

if (process.env.SHARP_CONCURRENCY) {
  sharp.concurrency(Number(process.env.SHARP_CONCURRENCY))
}

const isLossless = { png: true }
const alphaUnavailable = { jpeg: true }

const rounds = 10
const tolerance = 0.00002

// Quality here is gated by an SSIM search, and ssim.js grayscales before it
// compares, so it only ever measures luma. Anything that spends bytes on chroma
// resolution is therefore invisible to the gate: it enlarges the file without
// moving the number the search is steering by. Measured at width 1280 on
// openemu/background.jpg against the '2x' target:
//
//   jpeg  mozjpeg              -23.3%   ssim unchanged   <- kept
//   jpeg  progressive           +6.0%   ssim unchanged
//   jpeg  chromaSubsampling 4:4:4  +35.6%   ssim unchanged
//   webp  smartSubsample         +7.6%   ssim worse
//   webp  alphaQuality           -2.1%   ssim unchanged   <- kept
//
// 4:4:4 and smartSubsample do genuinely help saturated colour; they just cost
// bytes that this quality gate can't see, and the SSIM targets in lib/cache.js
// were calibrated by eye against 4:2:0 output. AVIF and PNG stay on sharp's
// defaults, which makes their output byte-identical to what Lens shipped before.
const formatOptions = (format, quality) => {
  const baseOptions = {
    jpeg: { mozjpeg: true },
    avif: {},
    webp: { alphaQuality: quality }
  }

  return { ...baseOptions[format], quality }
}

const compress = async ({ source, format, width, quality }) => (
  await sharp(source)
    .ensureAlpha()
    .resize({ width, withoutEnlargement: true })
    .toFormat(format, formatOptions(format, quality))
    .toBuffer()
)

// ssim.js reads its pixel data as a Uint8ClampedArray, so hand it a view over
// sharp's buffer. Spreading into a plain array instead costs ~8x the memory
// (one JS number per byte) and was what exhausted the heap on large sources.
const pixelView = buffer => new Uint8ClampedArray(
  buffer.buffer, buffer.byteOffset, buffer.byteLength
)

const compressToSsim = async ({ source, format, limits, width, remaining }) => {
  const ssimTarget = limits.ssimTarget
  const [minQuality, maxQuality] = limits.quality[format]
  const range = maxQuality - minQuality

  let binary = range / 4
  let quality = minQuality + (range / 2)
  let tested = new Map()
  let best
  let slowestRound = 0

  // Decoding straight to raw skips the full-size intermediate PNG the original
  // round-tripped through. PNG is lossless, so the pixels are identical.
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .resize({ width, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const sourceId = {
    data: pixelView(data),
    width: info.width,
    height: info.height
  }

  for (let round = 0; round < rounds; round++) {
    const preparedQuality = Math.round(
      Math.min(maxQuality, Math.max(minQuality, quality))
    )

    if (!tested.has(preparedQuality)) {
      // Bail out with what we have rather than get killed mid-encode. The
      // search already returns its last candidate when it runs out of rounds,
      // so an early exit degrades size, never correctness.
      if (best && remaining() < (slowestRound * 1.5) + 5000) { break }

      const startedAt = Date.now()
      const buffer = await compress({ source, format, width, quality: preparedQuality })
      const compressed = await sharp(buffer).ensureAlpha().raw().toBuffer()
      const score = ssim(sourceId, {
        data: pixelView(compressed),
        width: info.width,
        height: info.height
      }).mssim

      slowestRound = Math.max(slowestRound, Date.now() - startedAt)
      tested.set(preparedQuality, { score, buffer, quality: preparedQuality })
    }

    // Keep the buffer with its score. The original kept only the score, so a
    // revisited quality level could return a buffer from a different round.
    best = tested.get(preparedQuality)

    const scoreDelta = ssimTarget - best.score
    if (best.score >= ssimTarget && Math.abs(scoreDelta) <= tolerance) {
      return { buffer: best.buffer, quality: best.quality, ssim: best.score }
    }

    quality += binary * Math.sign(scoreDelta)
    binary /= 2
  }

  // Ran out of rounds without landing inside the tolerance. The original did the
  // same thing: hand back the closest candidate rather than fail.
  return best
    ? { buffer: best.buffer, quality: best.quality, ssim: best.score }
    : { skipped: 'deadline' }
}

// An out-of-memory kill takes the whole execution environment with it: there is
// no exception to catch and no chance to hand back a partial result, which is
// what makes it different from a timeout. So the only real defence is declining
// work that is known to be too big before any of it starts.
//
// This is an operator-set ceiling rather than a prediction. Peak RSS measured
// against the largest source in this repo, by output size: 0.9 MP ~485 MB,
// 3.7 MP ~1.5 GB, 8.3 MP ~1.9 GB, 14.7 MP ~2.9 GB, 20.4 MP ~3.8 GB, 33 MP ~5 GB.
// Unset (0) disables the check entirely.
const maxOutputMegapixels = Number(process.env.MAX_OUTPUT_MEGAPIXELS) || 0

const outputMegapixels = async source => {
  const { width, height } = await sharp(source).metadata()
  return { width, height, megapixels: (width * height) / 1e6 }
}

// One format per call. The origin fans these out in parallel and picks whichever
// buffer comes back smallest, so the format comparison no longer lives here.
const compressOne = async ({ source, format, width, quality, limits, remaining }) => {
  if (maxOutputMegapixels) {
    const src = await outputMegapixels(source)
    // resize() never enlarges, so the output is the smaller of the two.
    const scale = Math.min(1, width / src.width)
    const megapixels = src.megapixels * scale * scale

    if (megapixels > maxOutputMegapixels) {
      throw Object.assign(
        new Error(
          `Output would be ${megapixels.toFixed(1)}MP, over the ` +
          `${maxOutputMegapixels}MP ceiling for this function's memory. ` +
          'Raise MAX_OUTPUT_MEGAPIXELS once MemorySize allows it.'
        ),
        { statusCode: 413 }
      )
    }
  }

  if (alphaUnavailable[format]) {
    const { isOpaque } = await sharp(source).stats()
    if (!isOpaque) { return { skipped: 'alpha' } }
  }

  if (isLossless[format]) {
    return { buffer: await compress({ source, format, width, quality: 100 }), quality: 100 }
  }

  // q=ultra pins a fixed quality per format and skips the search entirely.
  if (quality) {
    return { buffer: await compress({ source, format, width, quality }), quality }
  }

  return await compressToSsim({ source, format, limits, width, remaining })
}

module.exports = { compressOne }
