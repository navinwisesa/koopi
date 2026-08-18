import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse pulls in @napi-rs/canvas (a native N-API binary) for its
  // getScreenshot() rendering path, and tesseract.js ships its own WASM/
  // worker assets — neither is in Next's default externalized-packages list
  // (unlike plain `canvas`, which is). Left bundled, Next's server-components
  // bundler tries to inline these into the route's serverless function and
  // drops the native binary/worker files it can't statically trace, so the
  // function crashes at import time on Vercel's Linux runtime — every
  // /api/chat request 500s before the handler even runs, since route.ts
  // imports lib/pdfExtract.ts (which imports both) unconditionally at module
  // scope, not just when a PDF attachment is actually present. Confirmed:
  // local `next build && next start` doesn't reproduce this (Windows-built
  // native binaries are already correct locally), only Vercel's Linux
  // serverless bundling hits it. Marking them external makes Next leave them
  // as real `require()`s resolved from node_modules at runtime instead of
  // trying to bundle them.
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas", "tesseract.js"],
};

export default nextConfig;
