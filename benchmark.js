require('dotenv').config()

const fs = require('fs').promises
const Papa = require('papaparse')
const sharp = require('sharp')
const ssim = require('ssim.js').default
const { sourcePath } = require('./lib/path-tools')

const { compress } = require('./lib/compress')

const tableConfig = {
  'WebP 1920/1': { format: 'webp', width: 1920 },
  'WebP 960/1':  { format: 'webp', width: 960 },
  'WebP 1920/2': { format: 'webp', width: 1920 },
  'WebP 1920/3': { format: 'webp', width: 1920 },
  'AVIF 1920/1': { format: 'avif', width: 1920 },
  'AVIF 960/1':  { format: 'avif', width: 960 },
  'AVIF 1920/2': { format: 'avif', width: 1920 },
  'AVIF 1920/3': { format: 'avif', width: 1920 },
}

const filesizeResults = []
const scoreResults = []
const bppResults = []
const runCompression = async () => {
  const qualityCsv = await fs.readFile(
    'quality-tests.csv', { encoding: 'utf8' }
  )
  const qualityTable = Papa.parse(qualityCsv, { header: true }).data

  for (imageRow of qualityTable) {
    if (isNaN(Number(imageRow.Image))) { continue }

    const num = imageRow.Image
    const padded = num.padStart(3, '0')
    const source = sourcePath(`./Image_${padded}.png`)

    const scoreResult = { image: num }
    const filesizeResult = { image: num }
    const bppResult = { image: num }

    for (configKey of Object.keys(tableConfig)) {
      const { format, width } = tableConfig[configKey]
      const quality = Number(imageRow[configKey])
      if (!quality) { continue }

      // console.log({ padded, format, width, quality })
      const intermediateScaled = await sharp(source)
        .ensureAlpha()
        .resize({ width })
      const rawScaled = await intermediateScaled
        .toFormat('png')
        .toBuffer()
      const rawCompressed = await compress({ source, format, width, quality })
      const { height } = await intermediateScaled.metadata()
      const pixelCount = width * height

      const scaledPixels = await sharp(rawScaled).ensureAlpha().raw().toBuffer()
      const compressedPixels = await sharp(rawCompressed).ensureAlpha().raw().toBuffer()
      const scaledId = { data: scaledPixels, width, height }
      const compressedId = { data: compressedPixels, width, height }
      const score = ssim(scaledId, compressedId).mssim

      const filesize = rawCompressed.byteLength
      const bpp = (filesize * 8) / pixelCount

      scoreResult[configKey] = score
      filesizeResult[configKey] = filesize
      bppResult[configKey] = bpp

      console.log({num, configKey, score, filesize, bpp})
    }

    scoreResults.push(scoreResult)
    filesizeResults.push(filesizeResult)
    bppResults.push(bppResult)
  }

  console.log(Papa.unparse(scoreResults))
  console.log(Papa.unparse(filesizeResults))
  console.log(Papa.unparse(bppResults))
}

runCompression()
