// Pure, dependency-free scaffold safety nets — split out of app/api/chat/
// route.ts (same reasoning as lib/webAppFramework.ts's own split: one
// heuristic, not two copies that could drift) so app/api/projects/
// run-webapp/route.ts can apply them too. They were originally only applied
// when a scaffold was first written via chat's scaffold_web_app tool call,
// which fixes new scaffolds but does nothing for a project whose files were
// already persisted before a given guard existed — run-webapp/route.ts reads
// project_files as-is and just runs it. Applying the same guards there too
// means a previously-broken project self-heals the next time someone clicks
// Run, instead of being permanently stuck until someone starts a fresh room.

// Confirmed live: a model can specify framework: "next" and scaffold real,
// coherent Next.js-shaped files (next/link imports, a pages/ directory)
// while simply forgetting the one file that makes any of it runnable —
// package.json is what tells detectWebAppFramework (lib/webAppFramework.ts)
// AND npm this is a Next project at all. Without it the scaffold silently
// can't ever be Run (falls through to "not a web app project"/tries to
// execute a React component as a standalone script instead) despite every
// other file being exactly right. A sensible default is safer than
// trusting a model to remember it every single time.
const DEFAULT_NEXT_PACKAGE_JSON = JSON.stringify(
  {
    name: "scaffolded-app",
    version: "0.1.0",
    private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "latest", react: "latest", "react-dom": "latest" },
  },
  null,
  2
);

export function ensurePackageJson(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  if (framework !== "next" || files.some((f) => f.path === "package.json")) return files;
  return [...files, { path: "package.json", content: DEFAULT_NEXT_PACKAGE_JSON }];
}

// Same failure class as DEFAULT_NEXT_PACKAGE_JSON above, confirmed live: a
// model scaffolds real, coherent Next.js files using the idiomatic `@/...`
// import alias (e.g. `@/components/Hero`) — which every Next.js example and
// create-next-app's own default project use — but never writes the
// tsconfig.json whose `compilerOptions.paths` is the ONLY thing that makes
// `@/` resolve to anything. Next will happily auto-generate a bare
// tsconfig.json on first `next dev` if one's missing, but that auto-generated
// file has no `paths` entry, so every `@/...` import still 404s as "Module
// not found" — this looked exactly like a real app bug rather than a missing
// config file. Only injected when nothing already defines `@/` (a real
// tsconfig/jsconfig the model DID write, however it maps paths, must win).
const DEFAULT_NEXT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: false,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2
);

export function ensureTsConfigPathAlias(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  if (framework !== "next") return files;
  const hasPathAlias = files.some(
    (f) => (f.path === "tsconfig.json" || f.path === "jsconfig.json") && f.content.includes('"@/')
  );
  if (hasPathAlias) return files;
  return [
    ...files.filter((f) => f.path !== "tsconfig.json"),
    { path: "tsconfig.json", content: DEFAULT_NEXT_TSCONFIG },
  ];
}

// Confirmed live: a model can write an otherwise-fine next.config.js but
// gate the app directory behind `experimental.appDir`, the pre-13.4 idiom
// for opting into what's now the stable default — the scaffold_web_app
// system prompt tells it not to, but that's a request, not a guarantee. The
// sandbox always installs the latest Next.js, whose own config validator
// rejects `appDir` as an unrecognized key and hard-crashes the dev server
// before it serves anything, so this is a second, independent line of
// defense: a plain text patch (next.config.js is arbitrary JS/TS, not JSON,
// so no safe way to fully parse+re-serialize it here) that only ever removes
// this one known-dead key/flag rather than touching anything else the model
// configured. Deliberately narrow instead of a general "strip unknown
// experimental keys" pass — this fixes the one concretely observed crash
// without guessing at what else might be valid on whatever Next version
// actually ends up installed.
const NEXT_CONFIG_FILE_RE = /^next\.config\.(js|mjs|ts|cjs)$/i;
const DEAD_APP_DIR_KEY_RE = /\bappDir\s*:\s*(true|false)\s*,?\s*/g;
const EMPTY_EXPERIMENTAL_BLOCK_RE = /\bexperimental\s*:\s*\{\s*\}\s*,?\s*/g;

export function sanitizeNextConfig(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  if (framework !== "next") return files;
  return files.map((f) => {
    if (!NEXT_CONFIG_FILE_RE.test(f.path) || !f.content.includes("appDir")) return f;
    const content = f.content
      .replace(DEAD_APP_DIR_KEY_RE, "")
      .replace(EMPTY_EXPERIMENTAL_BLOCK_RE, "");
    return { ...f, content };
  });
}

// Confirmed live against this app's own Supabase data: a scaffolded next
// project can have a perfectly legitimate, internally-consistent
// package.json (real pinned next/react/react-dom versions, real
// tailwind/postcss devDependencies) and a real tsconfig.json with .tsx
// files throughout — and still never list `typescript` or the `@types/*`
// packages tsconfig.json implies. ensureTsConfigPathAlias above means every
// "next" scaffold ends up with a tsconfig.json regardless, so Next always
// runs its TypeScript-setup verification on boot; when it can't resolve an
// installed `typescript` package it doesn't fail cleanly, it crashes with a
// raw `TypeError: Cannot read properties of undefined (reading 'endsWith')`
// deep in its own require-hook — same failure class as the other guards
// here, just surfacing during boot instead of at the config-validation
// step sanitizeNextConfig covers. Merged into whatever devDependencies
// already exist rather than replacing package.json wholesale, and only
// added when genuinely missing — a version the model deliberately pinned
// always wins.
//
// Confirmed live, the hard way: an earlier version of this guard used
// "latest" for all four packages and it did NOT fix the crash above — the
// exact same TypeError, at the exact same require-hook.js line, on a
// project pinning next@14.2.3 + react@18.2.0 (a mid-2024 stack) that had
// just had a genuinely-missing `typescript` installed. "latest" typescript/
// @types/react resolve to whatever's newest in the npm registry *today*,
// which for an old pinned Next/React combo can be a typescript or React
// types major that Next 14's bundled verify-typescript-setup was never
// built against — trading the original missing-package crash for a
// version-skew one that looks identical from the outside. Pinning to the
// major that was actually contemporaneous with (and untouched since) these
// Next versions avoids resolving into a future nobody tested this against.
// @types/react/@types/react-dom specifically track whatever `react` major
// is actually declared (18 needs @types/react ^18, not ^19) rather than a
// fixed number, since DEFAULT_NEXT_PACKAGE_JSON's own "react": "latest"
// means this needs to keep working as React's current major moves forward.
function majorVersion(spec: string | undefined): number | null {
  if (!spec) return null;
  const match = spec.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

export function ensureTypeScriptDeps(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  if (framework !== "next") return files;
  const pkgIndex = files.findIndex((f) => f.path === "package.json");
  if (pkgIndex === -1) return files; // nothing to merge into — ensurePackageJson runs first in applyScaffoldGuards

  let pkg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(files[pkgIndex].content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return files;
    pkg = parsed as Record<string, unknown>;
  } catch {
    return files; // malformed package.json isn't this guard's job to fix
  }

  const dependencies = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  const devDependencies = { ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}) };
  // "latest" as of whenever this scaffold happens to be installed is not a
  // version — it's whatever npm's registry resolves to that day. React's
  // major is the one piece that genuinely varies per scaffold (18 vs 19+);
  // typescript/@types/node stay on the ^5/^20 majors every currently-
  // supported Next version was actually built and tested against.
  const reactMajor = majorVersion(dependencies.react) ?? 19;
  const requiredTsDevDeps: Record<string, string> = {
    typescript: "^5",
    "@types/node": "^20",
    "@types/react": `^${reactMajor}`,
    "@types/react-dom": `^${reactMajor}`,
  };
  let changed = false;
  for (const [name, version] of Object.entries(requiredTsDevDeps)) {
    if (name in dependencies || name in devDependencies) continue;
    devDependencies[name] = version;
    changed = true;
  }
  if (!changed) return files;

  const updated = [...files];
  updated[pkgIndex] = {
    ...files[pkgIndex],
    content: JSON.stringify({ ...pkg, devDependencies }, null, 2),
  };
  return updated;
}

// Confirmed live, again — same failure class as ensureTypeScriptDeps above,
// just a different package: a model wrote a real, working-looking
// Composer.tsx importing from '@heroicons/react/24/outline' and never
// declared @heroicons/react in package.json at all. typescript and
// @heroicons/react are not a coincidence, they're the same bug — a model
// can import any npm package by name in the code it writes without that
// package ever being guaranteed to land in the dependencies list next to
// it, and each individual missing-package crash looks like a fresh, unique
// bug from the outside (different module name, different stack trace)
// even though the actual defect is identical every time. Patching one
// specific package by name after each crash (first typescript, now this)
// is chasing symptoms — this scans every scaffolded file for bare import/
// require specifiers and makes sure each resolves to *something* in
// dependencies before it ever reaches npm, covering every package a model
// might reach for instead of only the ones already crashed on once.
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "domain",
  "events", "fs", "http", "http2", "https", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
  "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib", "module",
]);

// import ... from "x", export ... from "x", dynamic import("x"), require("x") —
// deliberately not a full parser (this is arbitrary JS/TS/JSX, same
// constraint sanitizeNextConfig above is under), just wide enough to catch
// every specifier shape a scaffold has actually used so far.
const IMPORT_SPECIFIER_RE =
  /(?:\bimport\s+(?:type\s+)?(?:[\s\S]*?)\bfrom\s+|\bexport\s+(?:[\s\S]*?)\bfrom\s+|\brequire\(\s*|\bimport\(\s*)["']([^"']+)["']/g;

function packageNameFromSpecifier(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  if (spec.startsWith("@/")) return null; // this app's own tsconfig path alias, not an npm scope
  if (spec === "next" || spec.startsWith("next/")) return null; // bundled with next itself
  if (spec === "react" || spec.startsWith("react/")) return null;
  if (spec === "react-dom" || spec.startsWith("react-dom/")) return null;
  if (NODE_BUILTINS.has(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const SCANNABLE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/i;

export function ensureImportedPackages(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  if (framework !== "next") return files;
  const pkgIndex = files.findIndex((f) => f.path === "package.json");
  if (pkgIndex === -1) return files;

  let pkg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(files[pkgIndex].content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return files;
    pkg = parsed as Record<string, unknown>;
  } catch {
    return files; // malformed package.json isn't this guard's job either
  }

  const dependencies = { ...((pkg.dependencies as Record<string, string> | undefined) ?? {}) };
  const devDependencies = (pkg.devDependencies as Record<string, string> | undefined) ?? {};

  const referenced = new Set<string>();
  for (const f of files) {
    if (!SCANNABLE_FILE_RE.test(f.path)) continue;
    for (const match of f.content.matchAll(IMPORT_SPECIFIER_RE)) {
      const pkgName = packageNameFromSpecifier(match[1]);
      if (pkgName) referenced.add(pkgName);
    }
  }

  let changed = false;
  for (const name of referenced) {
    if (name in dependencies || name in devDependencies) continue;
    dependencies[name] = "latest";
    changed = true;
  }
  if (!changed) return files;

  const updated = [...files];
  updated[pkgIndex] = {
    ...files[pkgIndex],
    content: JSON.stringify({ ...pkg, dependencies }, null, 2),
  };
  return updated;
}

// Confirmed live against this app's own Supabase data: app/favicon.ico
// persisted at exactly 0 bytes. project_files.content is a text column —
// nothing in this scaffold pipeline (a model's tool call, this app's own
// storage) can carry real binary image bytes through it, so any file at one
// of these paths is guaranteed to be empty or otherwise not a real image no
// matter what wrote it. That's harmless for an ordinary <img src> (just a
// broken image at runtime) but fatal here specifically: Next's App Router
// treats these exact filenames as reserved metadata conventions and wires
// each into a real image route via its own build-time
// next-metadata-image-loader — which throws on non-image content and takes
// the entire app/page compile down with it (confirmed live: "the Next.js
// dev server never came up in time", not a runtime 404 on the icon).
// Dropping the empty file entirely just means Next falls back to no custom
// favicon/icon, same as a scaffold that never included one.
const NEXT_METADATA_IMAGE_BASENAME_RE =
  /^(favicon\.ico|icon\d*\.(ico|jpe?g|png|svg)|apple-icon\d*\.(jpe?g|png)|opengraph-image\d*\.(jpe?g|png|gif)|twitter-image\d*\.(jpe?g|png|gif))$/i;

export function dropEmptyMetadataImages(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  if (framework !== "next") return files;
  return files.filter((f) => {
    if (f.content.length > 0) return true;
    const basename = f.path.split("/").pop() ?? "";
    return !NEXT_METADATA_IMAGE_BASENAME_RE.test(basename);
  });
}

/** Applies every scaffold safety net, in the order that matters (tsconfig's
 * own default depends on nothing else here, but running package.json first
 * keeps the historical ordering from app/api/chat/route.ts intact; the
 * dependency guards must run after both, since they need package.json to
 * exist and read the tsconfig ensureTsConfigPathAlias may have just added).
 * dropEmptyMetadataImages can run anywhere — it only ever removes files,
 * never touches package.json/tsconfig/next.config. */
export function applyScaffoldGuards(
  files: { path: string; content: string }[],
  framework: "static" | "next"
): { path: string; content: string }[] {
  const withPackageJson = ensurePackageJson(files, framework);
  const withTsConfig = ensureTsConfigPathAlias(withPackageJson, framework);
  const withTsDeps = ensureTypeScriptDeps(withTsConfig, framework);
  const withImportedDeps = ensureImportedPackages(withTsDeps, framework);
  const withSaneConfig = sanitizeNextConfig(withImportedDeps, framework);
  return dropEmptyMetadataImages(withSaneConfig, framework);
}
