export type Intent = "chat" | "build";

const CODE_FENCE = /```|`[^`\n]+`/;

const BUILD_SIGNAL = new RegExp(
  "\\b(" +
    [
      "code",
      "function",
      "script",
      "algorithm",
      "regex",
      "regexp",
      "compile",
      "syntax( error)?",
      "stack ?trace",
      "traceback",
      "exception",
      "debug(ging)?",
      "refactor",
      "implement",
      "compute",
      "calculat\\w*",
      "sort\\w*",
      "loop\\w*",
      "recursion",
      "recursive",
      "array",
      "variable",
      "endpoint",
      "api",
      "database",
      "query",
      "json",
      "yaml",
      "sql",
      "npm",
      "pip",
      "git",
      "docker",
      "python",
      "javascript",
      "typescript",
      "bash",
      "shell",
      "run (this|the|it)",
      "write (a|some) (function|script|code|program)",
      "fix (this|the) bug",
      "test this",
      "prime numbers?",
      "fibonacci",
      "sum of",
      "print\\(",
      "console\\.log",
      "def ",
      "const ",
      // "let " and "class " deliberately removed — confirmed live to
      // false-positive on ordinary English ("don't LET these buttons do
      // anything", "business CLASS", "a CLASS of its own"), not just the
      // JS/TS keyword or OOP term they were meant to catch. That false
      // positive used to just mean a casual message got answered by the
      // wrong Efficient/Powerful tier (cheap, per this file's own "errs
      // toward build" reasoning below) — but isCode now ALSO routes
      // straight to a narrow, free code-completion model instead of either
      // general tier (see app/api/chat/route.ts's isCode branch), and that
      // model can silently return nothing at all for a request it was
      // never suited to handle. A real code request almost always also
      // matches a much less ambiguous signal ("code", "function", "script",
      // "npm", a fenced block, ...), so dropping these two loses little
      // true-positive coverage for a lot less false-positive risk.
      "import ",
    ].join("|") +
    ")\\b",
  "i"
);

/**
 * Cheap pre-model classification so casual chatter never has to pay for the
 * 70B model — deliberately a heuristic rather than a classification LLM
 * call, since that would just move the quota burn instead of relieving it.
 * Errs toward "build" when ambiguous: a wrongly-escalated casual message
 * only costs more tokens, but a wrongly-downgraded build task can silently
 * lose tool access.
 */
export function classifyIntent(text: string): Intent {
  if (CODE_FENCE.test(text)) return "build";
  if (BUILD_SIGNAL.test(text)) return "build";
  return "chat";
}
