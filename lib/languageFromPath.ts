// Single source of truth for "what language is this file", derived from its
// actual path/extension — moved out of components/ProjectPanel.tsx (where it
// lived client-side only) so app/api/chat/route.ts can use the exact same
// mapping server-side instead of trusting whatever language string a model's
// tool call happened to self-report. That mismatch was the actual bug: a
// .js file could land with language: "python" because nothing server-side
// ever looked at the extension at all. Extended with the extensions a
// scaffolded web app needs (jsx/tsx/css/html/json/md) — ProjectPanel's
// original version only covered py/js/ts/sh, the sandbox-runnable languages.
export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py":
      return "python";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "sh":
      return "bash";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    default:
      // Unrecognized/extensionless (e.g. a dotfile) — matches the previous
      // fallback every call site already relied on, not a new default.
      return "python";
  }
}
