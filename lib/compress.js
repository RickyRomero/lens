const sharp = require('sharp')
const ssim = require('ssim.js').default

const isLossless = { png: true }
const alphaUnavailable = { jpeg: true }

const formatOptions = (format, quality) => {
  const baseOptions = {
    jpeg: {
      chromaSubsampling: '4:4:4',
      progressive: true,
      mozjpeg: true,
      overshootDeringing: false
    },
    avif: {
      chromaSubsampling: '4:4:4',
      effort: 9
    },
    webp: {
      alphaQuality: quality,
      smartSubsample: true,
      effort: 6
    }
  }

  return { ...baseOptions[format], quality }
}

const compressUsingBestFormat = async ({ accepts, source, limits, width, quality }) => {
  const sourceRequiresAlpha = !(await (sharp(source).stats())).isOpaque
  const formatBuffers = []

  for (format of accepts) {
    if (alphaUnavailable[format] && sourceRequiresAlpha) { continue }

    if (quality) {
      formatBuffers.push({
        buffer: isLossless[format]
          ? await compress({ source, format, width, quality: 100 })
          : await compress({ source, format, width, quality: quality[format] }),
        format
      })
    } else {
      formatBuffers.push({
        buffer: isLossless[format]
          ? await compress({ source, format, width, quality: 100 })
          : await compressToSsim({ source, format, limits, width }),
        format
      })
    }
  }

  const sortedSizes = formatBuffers.sort(
    (a, b) => a.buffer.length - b.buffer.length
  )
  console.dir(sortedSizes.map(buffer => [buffer.format, buffer.buffer.length]))

  return formatBuffers.sort(
    (a, b) => a.buffer.length - b.buffer.length
  ).shift()
}

const compress = async ({ source, format, width, quality }) => {
  const options = { quality, ...formatOptions[format] }
  return (
    await sharp(source)
      .ensureAlpha()
      .resize({ width, withoutEnlargement: true })
      .toFormat(format, options)
      .toBuffer()
  )
}

const compressToSsim = async ({ source, format, limits, width }) => {
  const ssimTarget = limits.ssimTarget
  const [minQuality, maxQuality] = limits.quality[format]
  const range = maxQuality - minQuality

  let tolerance = 0.00002
  let binary = range / 4
  let quality = minQuality + (range / 2)
  let testedQualities = new Map()
  let detectedWidth
  let height
  let sourceImg
  let sourcePixels
  let compressed

  sourceImg = await sharp(source).ensureAlpha().resize({
    width, withoutEnlargement: true
  }).toFormat('png').toBuffer()
  detectedWidth = (await sharp(sourceImg).metadata()).width
  height = (await sharp(sourceImg).metadata()).height
  sourcePixels = [...await sharp(sourceImg).raw().toBuffer()]

  for (let round = 0; round < 10; round++) {
    // Cache SSIM scores since we have to round the quality level,
    // and they won't be different if we round to the same value
    let score
    const preparedQuality = Math.round(Math.min(maxQuality, Math.max(minQuality, quality)))

    if (!testedQualities.has(preparedQuality)) {
      const options = {
        source,
        quality: preparedQuality
      }
      compressed = await compress({ ...options, format, width })
      const compressedPixels = [...await sharp(compressed).ensureAlpha().raw().toBuffer()]
      const sourceId = { data: sourcePixels, width: detectedWidth, height }
      const compressedId = { data: compressedPixels, width: detectedWidth, height }
      score = ssim(sourceId, compressedId).mssim

      testedQualities.set(preparedQuality, score)
    } else {
      score = testedQualities.get(preparedQuality)
    }

    const scoreDelta = ssimTarget - score
    if (score >= ssimTarget && Math.abs(scoreDelta) <= tolerance) {
      return compressed
    } else {
      quality += binary * Math.sign(scoreDelta)
      binary /= 2
    }
  }

  return compressed
}

module.exports = { compress, compressToSsim, compressUsingBestFormat }
