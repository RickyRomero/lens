require('dotenv').config()

const PATH = require('path')
const fs = require('fs').promises
const { createReadStream } = require('fs')

const express = require('express')
const mime = require('mime')
const { retrieve } = require('./lib/cache')
const { verify, rawPrefix } = require('./lib/signing')
const {
  sourcePath, sourceHash, isFilePath, sterilizePath
} = require('./lib/path-tools')

const app = express()
app.disable('x-powered-by')

const cacheControl = 'public, max-age=86400, immutable'
// The compressed version usually lands within seconds, so don't let a client
// pin a multi-megabyte original for a day while it waits.
const pendingCacheControl = 'public, max-age=60'

const maxWidth = 8192
const imagePaths = ['*.jpg', '*.png']
const supportedPaths = [...imagePaths, '*.woff2', '*.mp4', '*.svg']

// Where the compressor pulls originals from. Signed and short-lived, because it
// exists to feed Lambda rather than browsers.
app.get(`${rawPrefix}/*`, async (req, res) => {
  const userPath = sterilizePath(req.params[0] || '')

  if (!isFilePath(userPath) || !verify(userPath, req.query.exp, req.query.sig)) {
    return res.status(403).end()
  }

  try {
    const target = sourcePath(userPath)
    await fs.access(target)

    res.status(200)
      .set('cache-control', 'no-store')
      .set('content-type', mime.getType(PATH.extname(userPath)))

    createReadStream(target).pipe(res)
  } catch (e) {
    res.status(404).end()
  }
})

// Sterilize incoming paths
app.get(supportedPaths, (req, res, next) => {
  res.locals.path = sterilizePath(req.path)
  if (isFilePath(res.locals.path)) {
    next()
  } else {
    res.status(400).end()
  }
})

// Verify the requested file exists. The stat doubles as the cache key input, so
// busting the cache on a changed source costs no extra syscall.
app.get(supportedPaths, async (req, res, next) => {
  try {
    res.locals.sourceStat = await fs.stat(sourcePath(res.locals.path))
    next()
  } catch (e) {
    res.status(400).end()
  }
})

// Compress images if desireable
app.get(imagePaths, async (req, res, next) => {
  // Asking for the original has to be explicit. It can't be inferred from
  // content negotiation: Chrome and Firefox advertise image/avif and image/webp
  // on top-level navigations too, so a direct visit looks identical to an <img>.
  if (req.query.raw) { return next() }

  const params = {}
  try {
    const accepts = ['jpeg', 'png']
    const acceptHeader = req.headers.accept || ''
    if (acceptHeader.indexOf('image/webp') > -1) {
      accepts.push('webp')
    }
    if (acceptHeader.indexOf('image/avif') > -1) {
      accepts.push('avif')
    }

    const width = Number(req.query.w || maxWidth)
    if (!Number.isFinite(width) || width < 1) {
      return res.status(400).end()
    }

    params.source = res.locals.path
    params.accepts = accepts
    params.quality = req.query.q || 'normal'
    params.density = req.query.d || '1x'
    params.width = Math.min(Math.floor(width), maxWidth)
    params.srcHash = sourceHash(res.locals.sourceStat)

    const cached = await retrieve(params)
    if (cached) {
      res.status(200)
        .set('cache-control', cacheControl)
        .set('content-type', mime.getType(cached.format))
        .send(cached.buffer)
        .end()
    } else {
      // Cache missed and it's compressing now
      res.locals.pending = true
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
      .set('cache-control', res.locals.pending ? pendingCacheControl : cacheControl)
      .set('content-type', mime.getType(type))
      .send(buf)
      .end()
  } catch (e) {
    res.status(400).end()
  }
})

app.listen(process.env.PORT)
