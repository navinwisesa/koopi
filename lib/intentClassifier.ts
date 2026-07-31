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
      "let ",
      "import ",
      "class ",
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
