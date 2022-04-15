# Lens

Lens is a simple express.js server which hosts visual assets. It will also compress images for you using next-gen formats.

I built Lens as a way to cope with next.js loading images slowly all the time (since it doesn't persist compressed images). Maybe you'll find it useful too, though you might need some elbow grease to get it working in your setup.

**Why should you use `next/image` instead of this?**

- It's good enough
- It handles cache busting
- The initial compression is faster and uses fewer resources
- You don't want to write a custom image loader
- You don't want to set up a caching proxy

**Why should you use this instead of `next/image`?:**

- It persists compressed images between builds
- It re-generates missing compressed images by keeping a log of image requests
- During compression, it uses [SSIM comparison](https://en.wikipedia.org/wiki/Structural_similarity) to smartly select image quality levels
- Because of the SSIM comparison, AVIF images end up way smaller than WebP, which more fully realizes their potential

## How to configure the SSIM levels

They're in `lib/cache.js`. I decided on the levels in that file through ABX testing of about 130 images, so you might not want to mess with this unless you do the same. (Using `abx.html` and some elbow grease...)

## How to run

Clone this repo, then add a `.env` file with the following info:

```
PORT=3001
SOURCE_DIR=/path/to/source/assets/dir
CACHE_DIR=/path/to/image/cache/dir
REGEN_LOG=/path/to/regen/log.txt
```

After that:

```zsh
yarn

# If developing locally
yarn dev

# If running on a server
yarn start

# If you want it to regenerate the image cache based on previous requests
yarn regen && yarn start
```

## How to access compressed images

Using an `<img>` tag, request the image you want to compress (.jpg or .png) with this `src`:

`http://localhost:3001/path/to/image/in/SOURCE_DIR/img.jpg?q=basic&w=640`

When requesting with `<img>`, the browser will send the server an `Accept` header. This is how Lens decides on which format to send it. If you visit the image URL directly, it won't receive this header and send you the raw asset instead (without recompression or scaling).

The `q` query parameter selects the compression level [as defined here.](#how-to-configure-the-ssim-levels)
The `w` query parameter is optional and determines the width of the final image in pixels.
