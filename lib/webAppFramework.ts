// Pure, dependency-free framework detection — deliberately split out of
// lib/webAppSandbox.ts (which imports the "e2b" SDK, a server-only package)
// so components/ProjectPanel.tsx can import this same heuristic client-side
// to decide which Run endpoint to call, without pulling e2b into the browser
// bundle. Same detection app/api/projects/run-webapp/route.ts uses
// server-side — one heuristic, not two copies that could drift.
export type WebAppFramework = "static" | "next";

// Evidence of actual Next.js source, not just a package.json that happens to
// be sitting next to it — confirmed live that a scaffold can be nothing but
// a plain index.html plus a stray/leftover package.json (e.g. from
// ensurePackageJson in app/api/chat/route.ts firing on a framework the model
// picked inconsistently) and still get sent through `npm install` on every
// single Run with no Next app for that install to ever actually serve.
const NEXT_CONFIG_RE = /^next\.config\.(js|mjs|ts|cjs)$/i;
const NEXT_SOURCE_RE = /^(app|pages)\/.*\.(tsx?|jsx?)$/i;

function looksLikeNextSource(files: { path: string }[]): boolean {
  return files.some((f) => NEXT_CONFIG_RE.test(f.path) || NEXT_SOURCE_RE.test(f.path));
}

/**
 * null means "not a web app project" — the caller should fall back to the
 * ordinary single-script run flow (SandboxProjectRun via /api/projects/run),
 * unchanged from before this feature existed.
 */
export function detectWebAppFramework(files: { path: string }[]): WebAppFramework | null {
  const hasPackageJson = files.some(
    (f) => f.path === "package.json" || f.path.endsWith("/package.json")
  );
  if (hasPackageJson && looksLikeNextSource(files)) return "next";

  const hasHtml = files.some((f) => /\.html?$/i.test(f.path));
  if (hasHtml) return "static";

  // A package.json with no HTML and no recognizable Next source (e.g. a
  // scaffold that only got as far as package.json) is still worth trying as
  // "next" — better to attempt and fail with a clear npm/dev-server error
  // than to silently refuse to run at all.
  if (hasPackageJson) return "next";

  return null;
}
