#!/bin/sh
# The DSP is verified against rooms whose reverberation time we already know.
# The palette is verified against the surfaces it actually lands on.
set -e
cd "$(dirname "$0")/.."

# Instant, and it fails on a token that moved, so run it before the slow part.
node test/contrast.mjs
for t in synthetic bands imagesource skirts; do
  ./node_modules/.bin/esbuild "test/$t.ts" --bundle --platform=node --format=esm --outfile="test/.$t.mjs" --log-level=error
  node "test/.$t.mjs"
  rm -f "test/.$t.mjs"
done
