[**AI usage notice →**](#ai-usage-notice)

# Lens

Lens is a simple express.js server which hosts visual assets. It will also
compress images for you using next-gen formats.

I built Lens as a way to cope with next.js loading images slowly all the time
(since it doesn't persist compressed images). Maybe you'll find it useful too,
though you might need some elbow grease to get it working in your setup.

**Why should you use `next/image` instead of this?**

- It's good enough
- It doesn't require AWS
- The initial compression is faster and uses fewer resources
- You don't want to write a custom image loader
- You don't want to set up a caching proxy

**Why should you use this instead of `next/image`?:**

- If a compressed image isn't ready, it sends the uncompressed one and doesn't
  block
- It persists compressed images between builds
- It re-generates missing compressed images by keeping a log of image requests
- During compression, it uses [SSIM
  comparison](https://en.wikipedia.org/wiki/Structural_similarity) to smartly
  select image quality levels
- Because of the SSIM comparison, AVIF images end up way smaller than WebP,
  which more fully realizes their potential

## How to configure the SSIM levels

They're in `lib/cache.js`. I decided on the levels in that file through testing
about 220 images, so you might not want to mess with this unless you do the
same. (Using `abx.html` and some elbow grease...)

## How compression works

Lens itself doesn't compress anything. Encoding a 30-megapixel PNG into four
formats, ten quality levels deep, is not something you want happening on the box
that's also serving requests, so that work runs in AWS Lambda.

```
browser ──▶ Lens ──▶ cache hit?  ──yes──▶ compressed image
                          │
                          no
                          │
                          ├──▶ responds with the uncompressed original
                          │
                          └──▶ Lambda × one per accepted format ──┐
                                    │                             │
                                    └── pulls the original back ◀─┘
                                        through a signed URL

                               Lens keeps whichever came back smallest.
```

Source images are too big to pass in a Lambda invocation (the payload cap is 6
MB and originals here run past 20 MB), so Lambda fetches them back out of this
server over a separate, short-lived signed URL. Compressed results come back in
the response, which fits comfortably.

## How to run

Clone this repo, then copy `.env.example` to `.env` and fill it in. The
image-serving half needs:

```
PORT=3001
SOURCE_DIR=/path/to/source/assets/dir
CACHE_DIR=/path/to/image/cache/dir
REGEN_LOG=/path/to/regen/log.json
```

and the compression half needs:

```
ORIGIN_BASE_URL=https://lens.example.com   # must be reachable from AWS
RAW_SIGNING_KEY=                           # openssl rand -base64 48
LENS_LAMBDA_URL=                           # printed by the deploy
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
MAX_CONCURRENT_JOBS=4
```

After that:

```zsh
pnpm install

# If developing locally
pnpm dev

# If running on a server
pnpm start

# If you want it to regenerate the image cache based on previous requests
pnpm regen && pnpm start
```

## How to deploy the compressor

You need the `aws` CLI and credentials with permission to create the stack.
There is no console clicking, and no SAM, CDK, or Terraform involved.

```zsh
AWS_REGION=us-west-2 ORIGIN_BASE_URL=https://lens.example.com pnpm deploy:lambda
```

That builds the bundle (cross-installing sharp's Linux arm64 binaries),
converges `infra/lens-compressor.yaml`, and pushes the code. On a first deploy
it also prints the invoking IAM user, so you can mint credentials once:

```zsh
aws iam create-access-key --user-name lens-compressor-invoker
```

Re-run `pnpm deploy:lambda` for any later change. Tunables — memory, timeout,
reserved concurrency, log retention — are CloudFormation parameters; pass them
through `LENS_STACK_PARAMS`:

```zsh
LENS_STACK_PARAMS="MemorySize=7076 ReservedConcurrency=20" pnpm deploy:lambda
```

`LENS_STACK_PARAMS` is the whole set, not a patch on the last deploy: anything
left out is reset to the default declared in `infra/lens-compressor.yaml`, so
removing an override reverts it. Deploying with none of them set restores every
template default. The resolved values are printed before the stack converges.

The function URL is IAM-authenticated, so unsigned requests are rejected by AWS
before the function runs and never cost you anything. Lambda will only fetch
source images from `ORIGIN_BASE_URL`, so it can't be pointed at anything else.

## How the cache is keyed

Compressed files are named:

```
<basename>.<width>.<options>.<sourcehash>.<format>
    me   .  1280 .  1039   .  fea4d36e  . jpeg
```

`options` packs the accepted formats, quality, and density into one integer.
`sourcehash` is derived from the source file's modification time and size, so
editing a source image changes the name and the old file is deleted the next
time that variant is built. Replacing a source with a byte-identical copy that
has a new mtime will rebuild it unnecessarily, which is the cheap direction to
be wrong in.

If you change codec settings in `lambda/compress.js`, bump `CODEC_GENERATION` in
`lib/path-tools.js`. It feeds the same hash, so every cached image is
invalidated without wiping `CACHE_DIR` by hand.

## How to access compressed images

Using an `<img>` tag, request the image you want to compress (.jpg or .png) with
this `src`:

`http://localhost:3001/path/to/image/in/SOURCE_DIR/img.jpg?d=1x&w=640`

Or this one:

`http://localhost:3001/path/to/image/in/SOURCE_DIR/img.jpg?q=ultra&w=640`

The browser's `Accept` header tells Lens which next-gen formats it supports, and
that's how Lens decides which format to send back.

There are two situations where you won't receive a compressed image in response.

- The compressed image isn't ready (so, your request just started that job). You
  get the original, with a short `max-age` so you pick up the compressed version
  once it lands a few seconds later.
- You asked for the original explicitly with `?raw=1`.

The `d` query parameter (for "density") is one of `1x`, `2x`, or `3x`. It refers
to the target pixel density, optimizing the image for each one. This defaults to
`1x` if not supplied. It doesn't affect the scale of the final image; just the
quality optimization.

The `w` query parameter (for "width") and determines the width of the final
image in pixels. This defaults to the width of the source image if not supplied.
It won't scale up.

If you don't like the result of the `d` parameter, you can replace it with
`q=ultra`. Lens will then return a lightly compressed (but much larger) image to
compensate.

The `raw` query parameter, set to anything, skips compression entirely and hands
back the original file. Use it for "view the full-size original" links.

## AI usage notice

This project is developed with AI assistance, including agentic coding tools.
The code here may be written or drafted by a model under my direction, then is
read, tested, and taken responsibility for by me. Commits before August 9, 2026
predate this practice.

If you'd prefer to avoid software developed this way, that's a legitimate
position and I completely respect your decision. This notice exists so you can
act on it without having to guess.

## Contributing with AI

Use whatever tools you like, including agents. **You are the author either
way:** read every line, be prepared to explain why it's correct, write your own
PR descriptions, and keep your diff small and targeted. Open an issue before
doing anything big so we can plan your approach together beforehand.

[Please read my full policy here.](./AI_POLICY.md)
