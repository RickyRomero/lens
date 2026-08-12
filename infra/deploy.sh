#!/usr/bin/env bash
#
# Builds the Lambda bundle, converges the stack, then pushes the code.
# Requires only the aws CLI and npm. Run it from anywhere:
#
#   AWS_REGION=us-west-2 ORIGIN_BASE_URL=https://lens.example.com infra/deploy.sh
#
set -euo pipefail

STACK="${LENS_STACK_NAME:-lens-compressor}"
REGION="${AWS_REGION:?AWS_REGION must be set}"
ORIGIN="${ORIGIN_BASE_URL:?ORIGIN_BASE_URL must be set}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/lambda/.build"
ZIP="$ROOT/lambda/function.zip"

echo "==> Bundling"
rm -rf "$BUILD" "$ZIP"
mkdir -p "$BUILD"
cp "$ROOT/lambda/pnpm-lock.yaml" "$ROOT/lambda/.npmrc" \
   "$ROOT/lambda/index.js" "$ROOT/lambda/compress.js" "$BUILD/"

# sharp ships prebuilt binaries per platform, and pnpm's supportedArchitectures
# *replaces* the host platform rather than adding to it. Keeping it out of the
# committed manifest lets local installs stay native; it only belongs here, in
# the copy that becomes the bundle.
node -e '
  const fs = require("fs")
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  pkg.pnpm = {
    ...pkg.pnpm,
    supportedArchitectures: { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] }
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2))
' "$ROOT/lambda/package.json" "$BUILD/package.json"

(cd "$BUILD" && pnpm install --prod --frozen-lockfile --ignore-scripts)

# supportedArchitectures pulls musl alongside glibc, and none of it is reachable
# on Lambda. Keep only what the function actually loads.
find "$BUILD/node_modules/@img" -mindepth 1 -maxdepth 1 -type d \
  ! -name 'colour' \
  ! -name 'sharp-linux-arm64' \
  ! -name 'sharp-libvips-linux-arm64' \
  -exec rm -rf {} +

# A bundle missing this still deploys cleanly and only fails on first
# invocation, so fail here instead. The filename carries sharp's version
# (sharp-linux-arm64-0.35.3.node), so match on the extension rather than
# pinning a name that changes on every upgrade.
BINARY="$(find "$BUILD/node_modules/@img/sharp-linux-arm64/lib" \
  -name '*.node' -print -quit 2>/dev/null)"
if [ -z "$BINARY" ]; then
  echo "error: sharp's linux-arm64 binary is missing from the bundle." >&2
  echo "       Lambda would fail on first invocation. Refusing to deploy." >&2
  exit 1
fi
case "$(file -b "$BINARY")" in
  *aarch64*) ;;
  *) echo "error: $BINARY is not an aarch64 ELF object." >&2; exit 1 ;;
esac

(cd "$BUILD" && zip -qr "$ZIP" .)
echo "    $(du -h "$ZIP" | cut -f1) bundle, sharp-linux-arm64 verified"

echo "==> Deploying stack: $STACK"

# A failed *initial* create leaves the stack in ROLLBACK_COMPLETE, which is a
# terminal state: CloudFormation cannot update out of it, so every later deploy
# fails with a confusing error until it's removed. The rollback already tore
# down everything it made, so the stack record is empty and safe to clear.
# Deliberately narrow -- only this one status, never a stack holding resources.
STATUS="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)"
if [ "$STATUS" = "ROLLBACK_COMPLETE" ]; then
  echo "    clearing empty ROLLBACK_COMPLETE stack left by a previous failed create"
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"
fi

# `aws cloudformation deploy` sends UsePreviousValue=True for every parameter
# missing from --parameter-overrides, so on an existing stack an omitted tunable
# silently keeps whatever was last deployed rather than falling back to the
# template. Dropping an override then looks like it reverted when it didn't.
# Resolving defaults here and passing every parameter explicitly makes the
# template the source of truth: what you don't override is what it declares.
#
# The defaults come from CloudFormation's own parser rather than a second YAML
# reader that could drift from the template. Parameters with no default (only
# AllowedOrigin today) are left out and still fall back to UsePreviousValue.
SUMMARY="$(aws cloudformation get-template-summary \
  --region "$REGION" \
  --template-body "file://$ROOT/infra/lens-compressor.yaml")"

# Command substitution, not a process substitution: a rejected LENS_STACK_PARAMS
# has to stop the deploy, and `while read < <(...)` would discard node's exit
# status and carry on with an empty parameter list.
RESOLVED="$(printf '%s' "$SUMMARY" | node -e '
  const fs = require("fs")
  const summary = JSON.parse(fs.readFileSync(0, "utf8"))
  const [, origin, raw] = process.argv

  const fail = message => { console.error(`error: ${message}`); process.exit(1) }

  const declared = new Map(
    (summary.Parameters || []).map(p => [p.ParameterKey, p.DefaultValue])
  )

  const resolved = new Map()
  for (const [key, value] of declared) {
    if (value !== undefined) { resolved.set(key, value) }
  }

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const split = token.indexOf("=")
    if (split < 1) { fail(`LENS_STACK_PARAMS entry "${token}" is not Key=Value.`) }

    const key = token.slice(0, split)
    if (key === "AllowedOrigin") {
      fail("AllowedOrigin comes from ORIGIN_BASE_URL; remove it from LENS_STACK_PARAMS.")
    }
    if (!declared.has(key)) {
      fail(`LENS_STACK_PARAMS names "${key}", which the template does not declare.`)
    }
    resolved.set(key, token.slice(split + 1))
  }

  resolved.set("AllowedOrigin", origin)
  for (const [key, value] of resolved) { console.log(`${key}=${value}`) }
' "$ORIGIN" "${LENS_STACK_PARAMS:-}")"

PARAMS=()
while IFS= read -r LINE; do
  PARAMS+=("$LINE")
done <<< "$RESOLVED"

printf '    %s\n' "${PARAMS[@]}"

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$ROOT/infra/lens-compressor.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMS[@]}"

stack_output() {
  aws cloudformation describe-stacks \
    --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

FUNCTION_NAME="$(stack_output FunctionName)"

# Always after the stack converges: on a first create the template's placeholder
# is what's live, and this is what replaces it.
echo "==> Pushing code to $FUNCTION_NAME"
aws lambda update-function-code \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP" \
  --publish >/dev/null

aws lambda wait function-updated \
  --region "$REGION" --function-name "$FUNCTION_NAME"

rm -rf "$BUILD"

cat <<EOF

Done.

  LENS_LAMBDA_URL=$(stack_output FunctionUrl)

If this was a first deploy, mint credentials for the origin once:

  aws iam create-access-key --user-name $(stack_output InvokerUserName)

then put the key id and secret in the origin's .env as AWS_ACCESS_KEY_ID and
AWS_SECRET_ACCESS_KEY.
EOF
