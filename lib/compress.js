const sharp = require('sharp')
const ssim = require('ssim.js').default

const formatOptions = (format, quality) => {
  const baseOptions = {
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

const compress = async ({ source, format, width, quality }) => {
  const options = { quality, ...formatOptions[format] }
  if (width) {
    return (
      await sharp(source)
        .ensureAlpha()
        .resize({ width, withoutEnlargement: true })
        .toFormat(format, options)
        .toBuffer()
    )
  }

  return (
    await sharp(source)
      .ensureAlpha()
      .toFormat(format, options)
      .toBuffer()
  )
}

const compressToSsim = async ({ source, limits, format, width }) => {
  const ssimTarget = limits.ssimTarget
  const [minQuality, maxQuality] = limits.quality[format]
  const minBpp = limits.minBpp[format]
  const range = maxQuality - minQuality

  let tolerance = 0.00002
  let binary = range / 4
  let quality = minQuality + (range / 2)
  let testedQualities = new Map()
  let mainWidth = width
  let sourceImg
  let compressed
  if (width) {
    sourceImg = await sharp(source).ensureAlpha().resize({ width })
  } else {
    sourceImg = await sharp(source).ensureAlpha()
    mainWidth = (await sourceImg.metadata()).width
  }
  const { height } = await sourceImg.metadata()
  const sourcePixels = [...await sourceImg.raw().toBuffer()]

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
      const sourceId = { data: sourcePixels, width: mainWidth, height }
      const compressedId = { data: compressedPixels, width: mainWidth, height }
      score = ssim(sourceId, compressedId).mssim

      testedQualities.set(preparedQuality, score)
    } else {
      score = testedQualities.get(preparedQuality)
    }

    const scoreDelta = ssimTarget - score
    if (score > ssimTarget && Math.abs(scoreDelta) <= tolerance) {
      return compressed
    } else {
      quality += binary * Math.sign(scoreDelta)
      binary /= 2
    }
  }

  return compressed
}

module.exports = { compress, compressToSsim }
