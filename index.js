require('dotenv').config()

const PATH = require('path')
const fs = require('fs').promises

const express = require('express')
const mime = require('mime')
const { retrieve } = require('./lib/cache')
const { compressToSsim } = require('./lib/compress')
const { sourcePath, isFilePath, sterilizePath } = require('./lib/path-tools')

const app = express()
app.disable('x-powered-by')

const cacheControl = 'public, max-age=86400, immutable'
const imagePaths = ['*.jpg', '*.png']
const supportedPaths = [...imagePaths, '*.woff2', '*.mp4', '*.svg']

// Sterilize incoming paths
app.get(supportedPaths, (req, res, next) => {
  res.locals.path = sterilizePath(req.path)
  if (isFilePath(res.locals.path)) {
    next()
  } else {
    res.status(400).end()
  }
})

// Verify the requested file exists
app.get(supportedPaths, async (req, res, next) => {
  try {
    const sourceTarget = sourcePath(res.locals.path)
    await fs.access(sourceTarget)
    next()
  } catch (e) {
    res.status(400).end()
  }
})

// Compress images if desireable
app.get(imagePaths, async (req, res, next) => {
  const params = {}
  try {
    const accepts = ['jpeg', 'png']
    const acceptHeader = req.headers.accept || ''
    if (acceptHeader.indexOf('image/avif') > -1) {
      accepts.push('avif')
    }
    if (acceptHeader.indexOf('image/webp') > -1) {
      accepts.push('webp')
    }

    params.source = res.locals.path
    params.accepts = accepts
    params.quality = req.query.q || 'normal'
    params.density = req.query.d || '1x'
    params.width = Number(req.query.w || 8192)

    const buf = await retrieve(params)
    if (buf) {
      res.status(200)
        .set('cache-control', cacheControl)
        .set('content-type', mime.getType(format))
        .send(buf)
        .end()
    } else {
      // Cache missed and it's compressing now
      next()
    }
  } catch (e) {
    res.status(400).end()
  }
})

// Serve static files
app.get(supportedPaths, async (req, res) => {
  const userPath = res.locals.path
  const type = PATH.extname(userPath)
  try {
    const buf = await fs.readFile(sourcePath(userPath))
    res.status(200)
      .set('cache-control', cacheControl)
      .set('content-type', mime.getType(type))
      .send(buf)
      .end()
  } catch (e) {
    res.status(400).end()
  }
})

// EXPERIMENTS
//
// app.get('/abx/:id/png', async (req, res) => {
//   const padded = String(Number(req.params.id)).padStart(3, '0')
//   const buf = await fs.readFile(`${padded}.png`)
//   res.status(200)
//     .set('content-type', mime.getType('png'))
//     .send(buf)
//     .end()
// })
//
// app.get('/abx/:id/:ssim/:format', async (req, res) => {
//   const padded = String(Number(req.params.id)).padStart(3, '0')
//   const ssim = Number(req.params.ssim)
//   const format = req.params.format
//   const buf = await compressToSsim({
//     source: `${padded}.png`,
//     targetSsim: ssim,
//     format
//   })
//   res.status(200)
//     .set('content-type', mime.getType(format))
//     .send(buf)
//     .end()
// })

app.listen(process.env.PORT)
