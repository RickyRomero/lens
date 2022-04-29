const { Worker } = require('worker_threads')
const PATH = require('path')

const runThread = (type, args) => {
  // "Unused" but required by Sharp for threads
  const sharp = require('sharp')
  const workerScript = PATH.join(__dirname, 'compress-thread.js')

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, {
      workerData: { type, args }
    })
    worker.on('message', resolve)
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0)
        reject(new Error(`Worker stopped with exit code ${code}`))
    })
  })
}

const compressUsingBestFormat = async args => {
  return await runThread('compressUsingBestFormat', args)
}

const compress = async args => {
  return await runThread('compress', args)
}

const compressToSsim = async args => {
  return await runThread('compressToSsim', args)
}

module.exports = { compress, compressToSsim, compressUsingBestFormat }
