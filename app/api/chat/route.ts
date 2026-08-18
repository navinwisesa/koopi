import Groq from "groq-sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";
import { SandboxRun, type RunResult } from "@/lib/sandbox";
import { runGuiSession } from "@/lib/desktopSandbox";
import { runWebSearch } from "@/lib/webSearch";
import { classifyIntent } from "@/lib/intentClassifier";
import { extractPdf } from "@/lib/pdfExtract";
import { languageFromPath } from "@/lib/languageFromPath";
import { applyScaffoldGuards } from "@/lib/webAppScaffoldGuards";
import { summarizeProjectFileChange } from "@/lib/summarizeProjectFileChange";
import type { Personality } from "@/components/PersonalitySelector";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// No single primary provider anymore — Cerebras is gone (not worth the extra
// hop once free-tier Groq/OpenRouter models cover the same ground). Routing
// is a straight three-way split:
//   code request        → poolside/laguna-s-2.1:free on OpenRouter (Groq has
//                          no comparable free code model, so there's no
//                          primary leg to try before this one; switched off
//                          cohere/north-mini-code:free 2026-08-17 after
//                          repeated unexplained 400s from that provider)
//   non-code, Powerful   → Groq openai/gpt-oss-120b, falling back to
//                          nvidia/nemotron-3-super-120b-a12b:free on OpenRouter
//   non-code, Efficient  → Groq openai/gpt-oss-20b, falling back to
//                          openai/gpt-oss-20b:free on OpenRouter
// "code" is decided purely from the message content (see isCode below) and
// wins regardless of the Efficient/Powerful tier — once it's code, the tier
// selector stops mattering.
//
// Switched off Groq's llama-3.3-70b-versatile/llama-3.1-8b-instant to these
// gpt-oss models 2026-08-16 (the llama models were being deprecated). The
// vendor prefix is NOT optional here — confirmed live that Groq's API 404s
// bare "gpt-oss-20b"/"gpt-oss-120b" with model_not_found; the real IDs are
// "openai/gpt-oss-20b" and "openai/gpt-oss-120b". gpt-oss also introduces a
// real behavior change plain Llama never had: it's a reasoning model, and
// its reasoning tokens count against max_completion_tokens same as visible
// output — confirmed live that a 20-token budget (this file's small
// classifier calls, sized for Llama's no-reasoning output) got entirely
// consumed by reasoning alone, returning empty content every time. See
// REASONING_EFFORT and each classifier's now-larger budget below; every
// Groq call in this file must pass reasoning_effort or risk silently
// starving on its old budget again next time a model changes under it.
const REASONING_EFFORT: Record<"chat" | "build", "low" | "medium"> = {
  chat: "low",
  build: "medium",
};
const OPENROUTER_CODE_MODEL = "poolside/laguna-s-2.1:free";
const GROQ_MODEL: Record<"chat" | "build", string> = {
  chat: "openai/gpt-oss-20b",
  build: "openai/gpt-oss-120b",
};
const OPENROUTER_MODEL: Record<"chat" | "build", string> = {
  chat: "openai/gpt-oss-20b:free",
  build: "nvidia/nemotron-3-super-120b-a12b:free",
};

// Confirmed empirically against Groq's live API (a request with a
// ~2-token prompt and max_completion_tokens: 7000 alone was rejected as
// "Requested 7036" against a 6000 TPM cap): Groq's TPM check is a preflight
// reservation of prompt_tokens + max_completion_tokens, not metered actual
// usage after the fact. llama-3.1-8b-instant (GROQ_MODEL.chat) only has a
// 6000 TPM budget — half of llama-3.3-70b-versatile's 12000 — so reserving
// the same 4096-token completion budget for both tiers meant a normal
// request (system prompt + room memory + history, regularly ~3400+ prompt
// tokens on its own) blew the chat tier's ENTIRE budget on reservation
// alone, near-guaranteed, regardless of how long the actual reply turned
// out to be. Confirmed live in this app's own logs: repeated 413
// rate_limit_exceeded errors on GROQ_MODEL.chat forcing an OpenRouter
// failover on nearly every Efficient-tier reply. Capping the chat tier's
// reservation instead — it's meant to be quick answers, not a budget it
// can never fit under — leaves real headroom (see the two call sites this
// feeds, both Groq and its OpenRouter fallback) without touching prompt
// content/history/room-memory at all. "build" keeps the original budget:
// its 12000 TPM ceiling was never the problem.
const MAX_COMPLETION_TOKENS: Record<"chat" | "build", number> = {
  chat: 1536,
  build: 4096,
};
// Multimodal input (Phase 1 of the debugging-tools build): confirmed via
// audit that NONE of the three models above accept image input — Groq's
// llama-3.1-8b-instant/llama-3.3-70b-versatile are text-only, as is
// poolside/laguna-s-2.1:free and the openai/gpt-oss-20b:free fallback.
// A message with an image or a visually-heavy PDF (see lib/pdfExtract.ts)
// always routes here instead, unconditionally, same "no primary leg to try
// first" reasoning OPENROUTER_CODE_MODEL already uses — there's no vision
// model on Groq to fail over from. Chosen from OpenRouter's free tier for
// its context size and "reasoning" tuning (useful for actually analyzing an
// error screenshot rather than just captioning it) — one reasonable pick
// among a few comparable free vision options at the time this was wired in
// (google/gemma-4-26b-a4b-it:free was the other strong candidate).
const VISION_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";

const MAX_HISTORY = 40;
const FLUSH_MS = 120;
const MAX_TOOL_ROUNDS = 4;

// How long to wait with NO data at all from the model before giving up and
// failing fast. Confirmed live (this session, a real failed request) that
// neither SDK client's own `timeout` option reliably bounds this: that
// request's stream connection opened fine (real response headers came
// back), then sat idle for 138 SECONDS before OpenRouter's own upstream
// proxy finally gave up and returned a 504 embedded in the stream itself —
// a client `timeout` option governs connection setup, not an already-open
// stream going quiet, so nothing on our side was cutting this off early.
// The ticker in runModelTurn already polls every FLUSH_MS for the Stop
// button; it tracks time-since-last-chunk the same way and aborts once
// this elapses, well before a person would give up waiting and assume
// they were ignored.
const IDLE_TIMEOUT_MS = 45_000;

// Thrown (client-side, deliberately, in runModelTurn — never something a
// provider's SDK raises on its own) when IDLE_TIMEOUT_MS elapses with
// nothing received. A distinct class so postFailureNotice can tell "took
// too long" apart from a generic failure and say so plainly, instead of
// both landing on the same unhelpful "I hit an error" text.
class UpstreamIdleTimeoutError extends Error {
  constructor() {
    super("No response from the model for too long.");
    this.name = "UpstreamIdleTimeoutError";
  }
}

// ProjectPanel.tsx's placeholder for representing an otherwise-empty folder
// as a real project_files row (see its own FOLDER_MARKER comment) — never a
// real file, filtered out of every existingPaths list below so it doesn't
// show up as noise in front of the classifier deciding where new code goes.
const FOLDER_MARKER = ".gitkeep";
function isFolderMarker(path: string): boolean {
  return path === FOLDER_MARKER || path.endsWith(`/${FOLDER_MARKER}`);
}

// Recognizes a run_code call that's pure filesystem reconnaissance — ls, find,
// cat, head, grep, echo, and the like, with nothing actually created — as
// opposed to real code someone asked to run. Confirmed live as the actual
// mechanism behind a pile of disconnected, numbered "project files"
// (restyle_the_app_with.sh, restyle_the_app_with_2.sh, _3.sh, ...): before
// Koopi had any live view of the project's current files (see
// projectFilesContextBlock), its only way to answer "does this already have
// Tailwind" was to run a shell command and look — and syncProjectFile saves
// EVERY run_code call as its own reviewable file unconditionally, so each
// one-off "let me check" command became its own pending change, with
// chooseFileTarget's classifier reasonably treating each new inspection
// command as a distinct little task and numbering it. A pure lookaround
// command was never a deliverable anyone asked for or would ever want to
// approve as real project history — it shouldn't become a file at all.
// Deliberately conservative (whitelist, not blacklist, and bash/shell/sh
// only — Python or JS "exploration" isn't covered): only skips saving when
// EVERY command segment is unambiguously read-only with nothing written
// anywhere, so a real script that happens to start with `ls` is never
// silently dropped — this only ever makes syncProjectFile skip a save it
// would otherwise have made, never the reverse.
const READONLY_SHELL_VERBS = new Set([
  "ls", "cat", "find", "head", "tail", "grep", "pwd", "echo", "wc", "file", "tree", "which",
]);
function looksLikePureDiagnosticShell(code: string, language: string): boolean {
  if (!["bash", "shell", "sh"].includes(language.trim().toLowerCase())) return false;
  const segments = code
    .split(/\r?\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return false;
  return segments.every((segment) => {
    // 2>/dev/null, >/dev/null, and 2>&1 are the standard "don't clutter the
    // output with noise" idioms every one of the confirmed-live examples
    // used — real, harmless redirects that shouldn't trip the "did this
    // write something" check below.
    const sanitized = segment
      .replace(/2>&1/g, "")
      .replace(/\d*>\s*\/dev\/null/g, "");
    if (/[><]/.test(sanitized)) return false;
    if (/\b(mkdir|touch|rm|cp|mv|npm|pip|git|python|node|npx)\b/.test(segment)) return false;
    const verb = segment.split(/\s+/)[0];
    return READONLY_SHELL_VERBS.has(verb);
  });
}

const SYSTEM_PROMPT = `You are Koopi, a coding agent in a shared multiplayer session.

Several teammates may be in the room at once. Each human turn is prefixed with the
speaker's username — use it to keep track of who asked what. Always start your own
reply by tagging whoever you're responding to, like "@Navin ...", so it's obvious
who the answer is for even when others are talking in the same thread.

Several people may tag you with separate, unrelated questions close together. Always
respond only to the single most recent message addressed to you — never combine
multiple pending questions into one reply, even if an earlier message never got a
response.

Any participant can interrupt you mid-response, so lead with the most useful thing
first rather than building up to it. Be concise and concrete; prefer short code
examples over long prose.

[EVALUATIVE STANCE — core behavior]
When a message involves a decision, plan, or claim — especially one connected to prior
discussion in this room's memory — do not simply validate or agree by default. Actively
evaluate it:
- If it conflicts with something already decided or stated by someone else in this room's
  history, say so explicitly and cite what conflicts and who said it.
- If it has a real risk, tradeoff, or flaw, name it plainly, even if unprompted and even if
  the person asking sounds confident.
- If multiple teammates have expressed different views on the same topic in this room's
  history, reflect that disagreement back rather than picking a side to please whoever's
  currently asking.
- Agreement should only happen when something genuinely holds up to scrutiny against the
  room's actual history — not by default, and not just because one person asked.
This is a core behavior rule, not a style choice: it holds regardless of any tone or
brevity preference stated elsewhere in this prompt. A short reply is still expected to
surface a real conflict or risk, not omit it for the sake of length.
[END EVALUATIVE STANCE]

You have no way to check usage limits, quotas, rate limits, or remaining capacity
for yourself, any tool, or any model — nothing available to you exposes that.
Never tell someone you've "hit a quota," "hit a rate limit," "run out of usage
for today," or anything similar, and never use that as a reason to decline or
pause a task — you would have no way to know it was true. If a call genuinely
fails, you'll see the actual failure (an error, a missing tool result, a system
message reporting it) — respond to that specific, real failure, not an invented
explanation for it. This holds even when an earlier reply further up in THIS
SAME conversation already said something like "we've hit today's usage limit
for the model" — confirmed live: that's the app's own fallback message,
inserted only when a real rate-limit error actually happened at that specific
moment, and its presence in the history is exactly why this instruction needs
repeating here, not a reason to relax it. It does not mean the limit is still
in effect now, and seeing it sit there is never grounds to repeat, paraphrase,
or agree with it as your own new answer — if you're asked directly whether
you're rate-limited or "okay right now," the honest answer is that you
genuinely cannot know one way or the other, so say exactly that, plainly,
rather than guessing yes.

When a message includes an attached image or PDF, this is explicitly a debugging aid —
usually a screenshot of an error, a stack trace, or a spec/requirements doc — not
decoration. Reference what's ACTUALLY visible in it specifically (the exact error text,
the exact line/value shown, a specific diagram element) rather than a generic guess at
what that kind of image "probably" shows. If a PDF's extracted text is included below a
message, treat it exactly like text the person typed themselves. If an image genuinely
isn't legible or the attachment failed to come through, say so plainly instead of
inventing plausible-sounding content for it.

You have a run_code tool that actually executes code in an isolated sandbox and
returns its stdout, stderr, and exit code. Only call it when the task genuinely
requires computation, data transformation, running an algorithm, or testing logic
that can't be reliably answered through reasoning alone. Do NOT call it just to
format, organize, or "print out" a text answer — opinions, explanations,
comparisons, and general-knowledge questions should be answered directly as plain
text, never wrapped in a code execution. If you're unsure whether a question needs
code, default to answering as plain text. Supported languages: python, javascript,
typescript, bash. The sandbox persists for the whole room — files and state from
an earlier run_code call anywhere in this room, in ANY thread, are still there
(it's the same working environment), so you can build on or modify something
created earlier instead of rewriting it from scratch. If a call reconnects to a
stale or expired sandbox, it transparently falls back to a fresh one — don't
assume persistence succeeded if output suggests a clean state. run_code's sandbox
has no display and cannot show anyone anything visual — if the code opens a
window (Tkinter, Pygame, or any other GUI toolkit), it will crash there with a
"no display" error. There is no workaround for this inside run_code: don't try
to fake a display by opening a browser, generating a URL yourself, writing an
image to disk, or any other trick — none of that makes a GUI visible to the
person.

Do NOT use run_code to look around this room's Project — an "ls", "find", or
"cat" just to check what files already exist or what they contain. The
[PROJECT FILES] listing later in this prompt (when this room has one) already
shows you every current file and its actual live content on every single
turn; check that first. Every run_code call becomes its own saved, reviewable
project file — a one-off lookaround command isn't a deliverable anyone asked
for, and several of them back-to-back for the same underlying question
becomes a pile of disconnected, numbered files nobody will ever approve as
real change history. Only reach for run_code to genuinely inspect something
the file listing can't show you (e.g. what's actually installed in the
sandbox's runtime environment).

You also have a web_search tool that performs a REAL web search and returns
actual results (title, url, a short snippet of the page) plus a short
synthesized answer when one's available. Use it whenever a question needs
current information (news, prices, versions, recent events, anything that
could plausibly have changed since your training), something you're not
confident about, or something explicitly asked to be looked up — don't
guess or answer from stale memory when a real check is one call away. When
you use what a search turned up, name the source (site or page title) so
the person can verify it themselves, and never invent a url, title, or fact
that wasn't actually in the tool result — only ever report what it really
returned. If it failed or came back empty, say so plainly instead of
answering as if the search had succeeded.

Before reaching for a native GUI toolkit at all, consider whether what's being
asked for can just be a webpage or web app instead. You have a
scaffold_web_app tool for exactly this: give it every file the app needs
(path + content for each) and a framework — "static" for a self-contained
HTML/CSS/JS site (use a Tailwind CDN <script> tag if styling is wanted; no
build step, no dependencies) or "next" for a real React/Next.js app, only
when the request genuinely needs client-side routing, component state
shared across pages, or something a static page can't do. Default to
"static" for anything that's fundamentally a single page or a handful of
pages (a calculator, a form, a landing page, a small dashboard, etc.) — it
starts almost instantly, unlike installing a whole framework for something
that doesn't need one. If the project already has real files in it (see the
"currently contains these files" listing elsewhere in this prompt, when
present) — especially a framework's own structure like app/page.tsx,
app/layout.tsx, package.json — a request to restyle, fix, or add to "the
app" is virtually always about THAT app, not a reason to scaffold a second,
disconnected one from scratch. Match its existing framework (don't scaffold
"static" into a project that's already "next", or vice versa), reuse its
existing filenames for anything you're editing, and pass its other
untouched files through with their content exactly as shown — the same
"never regenerate an untouched file from memory" rule that listing itself
states applies to scaffold_web_app too, not just a plain fenced-file edit.
Only scaffold an entirely fresh set of files when the project is genuinely
empty or the request is for a new, unrelated app. When you do use "next", the sandbox always installs
the latest Next.js (currently 15.x), where the App Router (the app/
directory) is the stable default — it needs no opt-in. Do NOT write a
next.config.js containing experimental: { appDir: true } or any other
appDir flag; that was only ever valid on Next 13.0–13.3 and current Next
rejects it outright as an unrecognized config option, crashing the dev
server before it ever serves a single page. Most scaffolds don't need a
next.config.js at all — only include one if the app genuinely needs to
configure something real (e.g. image domains), and if you do, keep it to
options that are valid on the latest Next.js. Call scaffold_web_app as an actual tool call, the
same way you'd call run_code — never as a fenced code block containing
its own {"files": [...], "framework": ...} arguments; writing the call out
as text instead of making it is not a shortcut, it does nothing at all —
no file is created, nobody sees anything, and the whole reply is wasted
describing a call that never happened. scaffold_web_app writes every file
for real — it does NOT start a live preview itself and its tool result
never contains a url. The Project panel's own Run button is the one and
only way anyone
sees it live (clicking Run installs/serves it and shows the link right
there) — after scaffold_web_app succeeds, tell them to open the Project
panel and click Run, nothing more. This applies to every tool, not only
scaffold_web_app: never write literal angle-bracket tags like
function=NAME wrapped around text into a reply, including when summarizing
a tool result you already received — that's not how a real call is made,
and echoing a result back inside fake tags only adds visual noise around a
sentence that was already fine on its own. Just say what happened, in plain
text. Never tell someone to open a file
themselves, run npm install, start a dev server by hand, or follow any
other manual setup step — that instruction is never correct here either;
"click Run in the panel" is the complete instruction, not a step toward a
longer one. Never invent, guess, or claim a live url exists — this tool
never returns one, so one is never yours to share. Only reach for a
native toolkit (Tkinter, PyQt, etc.) — and therefore open_gui_session, since
that's the only way anyone can actually SEE a native window — when the
person explicitly asks for a native/desktop app, or the task genuinely needs
something a browser can't do.

When open_gui_session is genuinely the right call, call it with the actual,
complete application code (the same code you'd otherwise put in run_code or
a project file — e.g. if they're asking to see something already built
earlier in this room, pass that exact code, not a placeholder or a new
unrelated snippet). It returns a real streamUrl in its tool result. Never write
out, guess, or invent a link yourself — only ever share the exact streamUrl a
tool result actually returned this turn, and only after that tool call
succeeded. If open_gui_session's result has no streamUrl (it failed), say so
plainly instead of claiming a link exists.

[PROJECT FILES — core behavior]
This room has a shared Project workspace (the panel on the right) that holds
many files, not one. Whenever you write real, runnable code for a coding
task — a script, an algorithm, a small app, anything more than a single
line used to illustrate a concept in passing conversation — it is saved to
a real file in that project automatically, the instant your reply finishes.
(A multi-file web app is the one exception to "write it as a fenced code
block" below — that's what scaffold_web_app is for, see above. It saves
every file directly; don't also paste those same files into your reply as
code blocks.)
You do not need to ask, name a file, or do anything else to make that
happen, and you must NEVER tell someone to copy your code and save it
themselves, name a file for them to create by hand, or say something like
"save this as x.py and run it" — that instruction is never correct, since
the saving already happened before they could even read it. Write the
complete code as a normal fenced code block; a short note afterward that
it's ready (e.g. "written to fizzbuzz.py — run it from the panel on the
right") is fine, repeating the code or giving manual save/run instructions
is not, ever, for anything in Project mode.

This holds no matter how short or simple the task is. A five-line FizzBuzz
is exactly as much "a real file" as a hundred-line script — it is never a
"just an example, here's a snippet" case to hand-hold someone through
manually. If the request is a genuine coding task — asking you to write,
build, or fix something that runs — assume it belongs in the project and
write it as a complete file, full stop.

The fenced block must always be the COMPLETE current file, never a partial
diff or "just add this line" fragment — it fully replaces whatever was
there before. If the request is clearly about modifying the file the
sender already has open in their Project panel, write out that whole file
with the change applied, not just the changed lines; if it's an unrelated
new task, it becomes its own new, sensibly-named file automatically — you
never need to pick a filename or ask which file to use.
This is a core behavior rule, not a style choice: it holds regardless of
any tone or brevity preference stated elsewhere in this prompt.
[END PROJECT FILES]

After a tool result, only add a follow-up message if it genuinely adds something
the output didn't already convey (e.g. tying it back to what was asked). Don't
restate the raw stdout/stderr verbatim — if the output already speaks for itself,
a short reply or none at all is better than repeating it.`;

const MEMORY_SYSTEM_PROMPT = `You maintain a short rolling summary of a shared team chat
room's activity across all its threads. Given the existing summary (if any) and new
messages since then, write an updated summary. Focus only on: key decisions made, what
was built or changed, and notable constraints or preferences any participant stated.
Skip small talk and routine back-and-forth. Keep it tight — a few sentences, not a
transcript. Write neutral third-person notes, not addressed to anyone.

Attribute key statements, decisions, and opinions to the specific person who made them,
by name — e.g. "Navin proposed using Postgres; test2 later suggested MongoDB instead" —
never collapse them into an unattributed group statement like "the team discussed
database options." If two participants expressed conflicting views on the same topic,
preserve both positions and who holds each one; do not resolve them into a single
consensus. This attribution is required, not optional — another part of the system
relies on knowing who said what to detect disagreement against this summary later, not
just knowing that a topic came up.`;

// Regenerate the room summary once a summary already exists and this many new
// messages have accrued since — frequent enough to stay useful, far cheaper
// than redoing it on every single message.
const MEMORY_REGEN_THRESHOLD = 20;

// Powers the "🧠 Room memory" / "⚠ Flagged" badges on a reply. Deliberately a
// classification of the FINISHED reply text against what was actually available —
// not "was room memory present in the prompt" (a room accrues a memory_summary almost
// immediately, so that would be true on nearly every message and the badge would stop
// meaning anything) and not a marker embedded in the model's own output (the stream is
// enqueued to the client character-by-character as it arrives, well before there's any
// chance to inspect or strip an inline tag).
const SIGNAL_CLASSIFIER_PROMPT = `You are a strict binary classifier. You will be given optional
room-memory context and a single assistant reply. Decide two independent yes/no facts about
ONLY that reply:

1. used_room_memory: does the reply draw on specific content from the room-memory context below
   — e.g. referencing a decision, statement, or fact that came from another thread — rather than
   just generically continuing the current conversation? If no room-memory context is given
   below, this must be false.
2. flagged: does the reply explicitly push back on something — surfacing a conflict or
   disagreement between named people, or naming a concrete risk/flaw/tradeoff — rather than
   simply agreeing, answering neutrally, or making small talk?

Respond with ONLY a compact JSON object and nothing else: {"used_room_memory": true|false, "flagged": true|false}`;

// A dedicated classifier call, deliberately WITHOUT room-memory context — tested
// empirically against this project's actual (code-heavy) room-memory summaries and
// found to flip unreliably when folded into SIGNAL_CLASSIFIER_PROMPT above (that
// summary text itself talks about prior code/files, which confuses a single combined
// judgment). Kept as its own focused call with just the trigger + reply instead.
const FILE_UPDATE_CLASSIFIER_PROMPT = `You are a strict binary classifier deciding ONE fact about
an assistant's reply in a coding chat: does this reply present a fenced code block that IS (or
fully replaces) a persistent project file the user is building or iterating on in this
conversation — as opposed to a short illustrative snippet used only to answer a narrow question
or demonstrate one idea?

Signals that this IS a file update:
- The user's message asks to build, write, create, update, fix, or add to "the" script/file/app/project.
- The reply's code block is a complete, substantial, self-contained unit (not a one-liner or a
  single function shown in isolation to explain a concept).

Signals that this is NOT a file update:
- The code is a short example embedded in an explanation, answering "how would I do X" in the
  abstract.
- The reply contains no fenced code block at all — this must always be false in that case.

Respond with ONLY a compact JSON object and nothing else: {"is_file_update": true|false}`;

// Largest fenced code block wins when a reply has more than one — "the file" is
// assumed to be the substantial one, not an inline one-liner elsewhere in the reply.
const FENCE_RE = /```(\w+)?\n([\s\S]*?)```/g;

// At or above this many lines, a fenced block is unambiguously "the file" —
// save it to the project unconditionally instead of spending an LLM call
// asking classifyFileUpdate to guess something a line count already
// answers. Below it, a block could still be a short illustrative snippet
// worth the classifier's judgment call — but only when the message wasn't
// already routed as a coding task (isCode); see where this is used below
// for why a short block bypasses both this and the classifier in that case.
const FILE_UPDATE_LINE_THRESHOLD = 10;

function extractFileUpdateBlock(
  text: string
): { code: string; language: string; fullMatch: string } | null {
  let best: { code: string; language: string; fullMatch: string } | null = null;
  for (const match of text.matchAll(FENCE_RE)) {
    const code = match[2] ?? "";
    if (!code.trim()) continue;
    if (!best || code.length > best.code.length) {
      best = {
        code,
        language: (match[1] ?? "").trim().toLowerCase() || "python",
        fullMatch: match[0],
      };
    }
  }
  return best;
}

// Every top-level {...} object in text, found by tracking brace depth and
// string literals (so a brace inside a quoted JSON string, e.g. inside a
// scaffolded file's own HTML content, never miscounts) — not a regex, since
// no regex reliably balances nested braces. Needed because a leaked
// scaffold payload (see extractLeakedScaffoldPayload below) isn't always
// fenced; confirmed live in a second, even rawer variant: `@scaffold_web_app
// {"files": [...], ...}` with no code fence around it at all.
function findTopLevelJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

// Moved to lib/webAppScaffoldGuards.ts (ensurePackageJson, ensureTsConfigPathAlias,
// sanitizeNextConfig, applyScaffoldGuards) so app/api/projects/run-webapp/route.ts
// can apply the same guards at run time, not just when a scaffold is first written —
// see that file's header comment for why.

function parseScaffoldShape(
  raw: string
): { files: { path: string; content: string }[]; framework: "static" | "next" } | null {
  const parsed = safeParse<{ files?: unknown; framework?: unknown }>(raw, {});
  if (parsed.framework !== "static" && parsed.framework !== "next") return null;
  if (!Array.isArray(parsed.files)) return null;
  const files = parsed.files.filter(
    (f): f is { path: string; content: string } =>
      Boolean(
        f &&
          typeof f === "object" &&
          typeof (f as { path?: unknown }).path === "string" &&
          (f as { path: string }).path &&
          typeof (f as { content?: unknown }).content === "string"
      )
  );
  if (!files.length) return null;
  return { files, framework: parsed.framework };
}

// A third raw shape, confirmed live 2026-08-16: after a REAL tool call
// already executed, the model's own wrap-up reply echoed the tool result
// back as `<function=scaffold_web_app>{...}</function>` — the literal
// syntax some open function-calling fine-tunes use internally for a call,
// imitated here in plain content instead of going through the API's actual
// function-calling field. Sometimes the tag wraps genuine unexecuted args
// (same failure as the fenced/bare-JSON shapes below — nothing was ever
// written); other times, per this session's live case, it wraps prose that
// was already the correct, already-executed outcome message, just spuriously
// tagged. LEAKED_FUNCTION_TAG_RE only isolates the wrapper; which of those
// two cases it is gets decided where it's used (extractLeakedScaffoldPayload
// tries to parse the inside as real args first; stripHallucinatedFunctionTags
// below is the fallback for when it isn't).
const LEAKED_FUNCTION_TAG_RE = /<function=([\w.-]+)>([\s\S]*?)<\/function>/gi;

// Safety net for a confirmed-live failure mode: a smaller/free model (seen
// with OpenRouter's free Efficient-tier fallback specifically) can narrate
// scaffold_web_app's JSON arguments as plain reply text instead of actually
// invoking the tool via the API's real function-calling mechanism.
// Confirmed by direct testing in THREE different shapes: once as a whole
// {"files": [...], "framework": ...} blob dressed up as a fenced ```json
// code block, once as a bare `@scaffold_web_app {...}` mention with no
// fence at all, once wrapped in a `<function=scaffold_web_app>...</function>`
// pseudo-tag. Either way, if the tag/fence/bare object actually contains
// unexecuted scaffold args, zero files ever reached project_files — the
// reply just streamed the tool's own parameter shape as prose,
// indistinguishable from success at a glance. Checks fenced blocks first
// (the common case), then tag-wrapped content, then falls back to scanning
// for any bare top-level JSON object in the whole reply — and if found,
// treats it as the tool call it was clearly meant to be (actually writing
// the files) rather than silently losing the whole request to a model that
// got the calling convention wrong.
function extractLeakedScaffoldPayload(
  text: string
): { files: { path: string; content: string }[]; framework: "static" | "next"; fullMatch: string } | null {
  for (const match of text.matchAll(FENCE_RE)) {
    const parsed = parseScaffoldShape(match[2] ?? "");
    if (parsed) return { ...parsed, fullMatch: match[0] };
  }
  for (const match of text.matchAll(LEAKED_FUNCTION_TAG_RE)) {
    if (match[1]?.toLowerCase() !== "scaffold_web_app") continue;
    const parsed = parseScaffoldShape(match[2] ?? "");
    if (parsed) return { ...parsed, fullMatch: match[0] };
  }
  for (const candidate of findTopLevelJsonObjects(text)) {
    const parsed = parseScaffoldShape(candidate);
    if (parsed) return { ...parsed, fullMatch: candidate };
  }
  return null;
}

// Fallback for the same <function=NAME>...</function> imitation when what's
// inside ISN'T executable args (extractLeakedScaffoldPayload above already
// had first crack at that case) — just a tool name/result the model echoed
// into its own reply with fake tags around it. Not scaffold_web_app-specific:
// the same imitation can happen after run_code, open_gui, or web_search just
// as easily, so this unwraps any tool name, keeping whatever text was inside
// (normally the exact outcome sentence Koopi already produced) and dropping
// only the fake tags around it.
function stripHallucinatedFunctionTags(text: string): string {
  return text
    .replace(LEAKED_FUNCTION_TAG_RE, (_m, _name: string, inner: string) => inner.trim())
    .replace(/<\/?function(?:=[\w.-]+)?>/gi, "")
    .trim();
}

// Decides WHICH project_files row a piece of generated code targets — a
// question extractFileUpdateBlock/classifyFileUpdate above never answered
// at all, which was the original bug: every file-worthy reply landed on the
// same hardcoded "koopi_scratch" path regardless of whether it was a new,
// unrelated task or a continuation of what was already open, silently
// overwriting whatever came before.
//
// The FIRST fix for that (chooseFileTarget below, trusting only the client's
// "currently open file") overcorrected: the open-file selection is sticky
// client state (see ProjectPanel's selectedId) that does NOT follow a file
// Koopi itself just created, so a retry or rephrase of the exact same task —
// with nothing new selected in the panel — had no "existing" signal to land
// on and got its own new file every time. `FileContinuationCandidate` below
// widens what counts as a candidate to continue: the explicit open file when
// there is one, otherwise a same-thread fallback resolved server-side (see
// resolveContinuationHint) that chooseFileTarget never used to see at all.
type FileContinuationCandidate = {
  path: string;
  content: string;
  // Shown to the classifier so it knows WHY this file was suggested —
  // an explicit selection is trusted differently than an inferred one.
  reason: string;
  // Skip the classifier and target this file directly. Reserved for the one
  // case narrow and unambiguous enough to not need an LLM's judgment call at
  // all: the project's last run errored very recently and nothing has
  // touched the project since — see resolveContinuationHint.
  forceExisting: boolean;
};

const FILE_TARGET_PROMPT = `You decide where generated code belongs in a shared multi-file
coding project.

You're given the user's current request, the code's language, a short content preview of every
OTHER file already in the project, and — if one applies — a single candidate file (the file Koopi
most recently touched in this conversation) plus a reason it was suggested.

Decide "existing" (the code belongs in a file already in the project — the candidate, or a
DIFFERENT existing file if one of the previews is a clearly better match) vs "new" (it's a
distinct task nothing already in the project covers). The candidate is a recency guess, not a
content guarantee — before defaulting to it, check whether the request is actually about
something a DIFFERENT existing file's preview shows (e.g. asked to rename a button whose exact
text only appears in one specific file's preview, not the candidate's) — a real content match
beats a recency guess every time. Within that, still favor "existing" whenever the request is
plausibly a continuation of whichever file it actually matches — modifying, fixing, or adding to
it ("add error handling to this", "make this support email login", "fix the bug above"), or a
retry/rephrasing of the same ask that produced it in the first place, even if the wording doesn't
match verbatim. Only answer "new" when the request is genuinely about a task nothing already in
the project — candidate or any preview — already covers. If the candidate's reason says its last
run just failed with an error, weight that even more heavily toward the candidate specifically —
an error followed by essentially the same ask again is almost always a retry, not a new task.
If no candidate is given AND no preview matches either, answer "new" — there's nothing to
continue.

When target is "existing", filename MUST be exactly one of the paths you were shown (the
candidate's own path, or one of the other existing paths named above its preview) — never a path
you're inventing or guessing at.

Whenever target is "new", also suggest a short, descriptive filename for the code — lowercase,
underscores instead of spaces, a sensible extension for the language (e.g.
"palindrome_checker.py", "median_calculator.py"). Base it on what the code actually DOES, not the
literal wording of the request, and avoid picking something that basically duplicates a name
already in the project.

Paths in this project can be nested ("utils/helpers.py", "src/api/routes.py") — reflecting the
project's real folder structure, not just flat filenames. If a new file's purpose clearly fits an
existing folder (a small helper when a "utils/" or "helpers/" folder already exists, an API route
when "src/api/" already has other routes in it), prefix your suggested filename with that same
folder path so it lands alongside its siblings, instead of defaulting to the project root. Don't
invent a NEW folder that doesn't already appear among the existing paths — only place a file into
a folder that's already there.

Respond with ONLY compact JSON: {"target": "existing"|"new", "filename": "path.ext"}`;

// How much of each OTHER existing file's content to show the classifier above — enough to
// recognize "this is clearly the file that has the text/element being asked about" without
// pricing in every file's full content on every single file-target decision (this call happens
// on every code-worthy reply, not just once per turn like projectFilesContextBlock).
const FILE_TARGET_PREVIEW_CHARS_PER_FILE = 400;
const FILE_TARGET_PREVIEW_TOTAL_CHARS = 6000;

function extensionFor(language: string | undefined | null): string {
  // Confirmed live: a run_code tool call can reach here with `language`
  // missing entirely (the model omitted the argument despite it being
  // `required` in RUN_CODE_TOOL's own schema — tool-call argument JSON isn't
  // guaranteed to match its declared schema just because the schema says
  // so) — .trim() on undefined threw, uncaught by this function's own two
  // call sites, and only survived because one of them happened to sit
  // inside a try/catch with a fallback. Defaulting here means neither call
  // site needs to know that could ever happen.
  switch ((language ?? "").trim().toLowerCase()) {
    case "python":
      return ".py";
    case "javascript":
      return ".js";
    case "typescript":
      return ".ts";
    case "bash":
    case "shell":
      return ".sh";
    default:
      return ".py";
  }
}

// Deterministic fallback filename — used when there's no OPENROUTER... no
// Groq key configured, or the classifier call itself fails/returns
// garbage. Crude (first few words of the request, slugified) but never
// silently reuses a hardcoded name the way the bug being fixed here did.
function slugFilename(text: string, language: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .split("_")
    .filter(Boolean)
    .slice(0, 4);
  const base = words.join("_") || "snippet";
  return `${base}${extensionFor(language)}`;
}

// Guards an LLM-suggested filename before it becomes a DB row's key. A bare
// filename ("calculator.py") is a one-segment relative path and always
// passes; "/" is only ever a folder separator between clean segments — no
// leading slash (not project-root-relative already, by construction), no
// ".."/empty segment (no escaping the project via a relative traversal),
// no segment containing anything outside [\w.-]. This is what actually
// keeps FILE_TARGET_PROMPT's new folder-nesting suggestions ("utils/x.py")
// working instead of silently defeating them — the old bare-filename-only
// regex here would have stripped every suggested "/" right back out.
function isPlausibleRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 120) return false;
  if (p.startsWith("/") || p.endsWith("/")) return false;
  const segments = p.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && /^[\w.-]+$/.test(seg));
}

// Confirmed live as the actual mechanism behind a working index.html
// silently getting replaced with plain CSS text: a reply that writes out
// TWO files (a labeled "here's index.html" block, then a separate "here's
// style.css" block) only ever has ONE of them survive — extractFileUpdateBlock
// keeps just the single largest fenced block per reply, and chooseFileTarget
// still has to pick ONE target for it. Nothing anywhere checked that the
// content being saved actually belonged in a file with that extension, so
// the CSS block landed under the index.html path and nobody — Koopi
// included — noticed until the page rendered as a wall of raw text.
// Deliberately narrow (checks the one specific mismatch that's actually
// been confirmed to happen, not a general "is this valid X" validator) to
// keep false positives near zero: empty/placeholder content is never
// judged, and anything not html/css passes through untouched.
function looksLikeExtensionMismatch(path: string, content: string): boolean {
  if (!content.trim()) return false;
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "html" || ext === "htm") {
    // Real HTML, complete or partial, always has at least one "<" — plain
    // CSS (or anything else that isn't markup) never does.
    return !content.includes("<");
  }
  if (ext === "css") {
    return /<!doctype|<html[\s>]/i.test(content);
  }
  return false;
}

// Appends _2, _3, ... until the name doesn't collide with an existing file
// in the project — two unrelated "calculator" tasks land as calculator.py
// and calculator_2.py, never one silently replacing the other.
function uniquePath(name: string, existingPaths: string[]): string {
  if (!existingPaths.includes(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}${ext}`;
    if (!existingPaths.includes(candidate)) return candidate;
  }
}

// Tone/style only — deliberately says nothing about tools, scoping, or what
// Koopi is allowed to do. That's enforced entirely by SYSTEM_PROMPT above and
// must never be reweighted by a personality choice.
const PERSONALITY_PROMPTS: Record<Exclude<Personality, "default">, string> = {
  concise:
    "Be as brief as possible. No preamble, no restating the question, no " +
    "closing summary unless it genuinely adds something. Lead with the direct " +
    "answer or result over explanation.",
  explanatory:
    "Walk through your reasoning, not just the answer. When you run code, " +
    "briefly explain what it does and why, both before and after showing the " +
    "output. Optimize for the person understanding the decision, not just " +
    "receiving a result.",
  casual:
    "Use a relaxed, informal, warm tone. Stay fully competent and accurate — " +
    "this changes wording and warmth, not correctness or effort. No slang that " +
    "obscures meaning, no forced jokes.",
  direct:
    "Be blunt and matter-of-fact. State findings plainly, including " +
    "disagreement or problems with what was asked, without softening. Stay " +
    "respectful, just not diplomatic-by-default.",
};

// Appended after every other section, never before — a personality choice
// must never be positioned where it could compete with or precede the
// tool-use and scoping rules in SYSTEM_PROMPT.
function personalityBlock(personality: Personality): string {
  if (personality === "default") return "";
  return (
    `\n\n[STYLE PREFERENCE — affects tone and phrasing only]\n` +
    `${PERSONALITY_PROMPTS[personality]}\n` +
    `[END STYLE PREFERENCE — the above does not override any instructions ` +
    `elsewhere in this prompt regarding tool use, scoping, or behavior]`
  );
}

const RUN_CODE_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_code",
    description:
      "Execute a code snippet in an isolated sandbox and return its stdout, stderr, " +
      "and exit code. Use ONLY for genuine computation, data transformation, running " +
      "an algorithm, or testing logic — never to format or present a plain-text answer " +
      "(opinions, explanations, comparisons, general knowledge) that doesn't need code " +
      "to actually run. The sandbox persists across calls for this whole room, across " +
      "every thread in it (same filesystem, so files from an earlier call — in this " +
      "thread or another one — are still there).",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The full source code to execute." },
        language: {
          type: "string",
          enum: ["python", "javascript", "typescript", "bash"],
          description: "The language to run the code as.",
        },
      },
      required: ["code", "language"],
    },
  },
};

const SCAFFOLD_WEB_APP_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "scaffold_web_app",
    description:
      "Write a full runnable web app or page (one or many files) into the project. Use " +
      "this instead of a plain HTML code block or manual setup instructions for anything " +
      "that's fundamentally a webpage or web app — a landing page, a form, a small " +
      "dashboard, a full React/Next.js app. This does NOT start a live preview and its " +
      "result never contains a url — the Project panel's Run button is the only place " +
      "anyone sees it live; tell the person to click Run there. Prefer framework: " +
      "'static' (plain HTML/CSS/JS, e.g. Tailwind via a CDN <script> tag — no build " +
      "step) unless the request genuinely needs React/Next's routing or component " +
      "state, in which case use framework: 'next' and include a package.json listing " +
      "'next'/'react'/'react-dom' as dependencies. The sandbox always installs the " +
      "latest Next.js, where the App Router needs no opt-in — never write a " +
      "next.config.js with experimental appDir (valid only on old 13.0-13.3, rejected " +
      "as an unrecognized option on current Next and crashes the dev server on boot); " +
      "skip next.config.js entirely unless the app genuinely needs to configure " +
      "something real. Every file's full, current content " +
      "must be included every call — this is not a diff. You MUST invoke this as a real " +
      "function/tool call through the API's own tool-calling mechanism — never write " +
      "out {\"files\": [...], \"framework\": ...} as plain reply text (in a code block or " +
      "otherwise). That is not how tool calls work and nothing will be built from it — " +
      "it just wastes the whole reply describing a call that never actually happened.",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Every file the app needs, each with its full current content.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative file path, e.g. 'index.html' or 'app/page.tsx'." },
              content: { type: "string", description: "The file's complete content." },
            },
            required: ["path", "content"],
          },
        },
        framework: {
          type: "string",
          enum: ["static", "next"],
          description: "'static' for plain HTML/CSS/JS (default, fastest). 'next' for a real React/Next.js app.",
        },
      },
      required: ["files", "framework"],
    },
  },
};

const WEB_SEARCH_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web (via Tavily) and return real results — title, url, and a short " +
      "snippet per result — plus a brief synthesized answer when one's available. Use this " +
      "for current events, anything that could have changed since training, a fact you're " +
      "not confident about, or anything explicitly asked to be looked up. Never fabricate a " +
      "url or claim to have searched without actually calling this.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
};

const OPEN_GUI_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "open_gui_session",
    description:
      "Run code that needs an actual graphical display to work — Tkinter, Pygame, or any " +
      "other GUI toolkit. run_code's sandbox is headless and this kind of code will crash " +
      "there with a 'no display' error, so use this instead whenever the code opens a " +
      "window. This does NOT return stdout/stderr to read — it opens a real virtual desktop " +
      "and hands back a link the person can open in a new tab to watch (and interact with) " +
      "the app live, for a few minutes. Never use this for anything that can run headlessly.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The full source code to run." },
        language: {
          type: "string",
          enum: ["python", "bash"],
          description: "The language to run the code as.",
        },
      },
      required: ["code", "language"],
    },
  },
};

// Groq and OpenRouter both speak the same OpenAI-compatible chunk format,
// so the streaming/interrupt logic below can treat either provider's
// response identically once cast to this shape.
type ChatStream = AsyncIterable<Groq.Chat.ChatCompletionChunk> & { controller: AbortController };

type MessageRow = {
  id: string;
  sender_type: "user" | "agent";
  content: string;
  sender_id: string | null;
  type: "text" | "tool_call" | "tool_result";
  profiles: { username: string | null } | { username: string | null }[] | null;
};

function firstOf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function historyToTurns(
  rows: MessageRow[],
  triggerMessageId: string
): Groq.Chat.ChatCompletionMessageParam[] {
  const turns: Groq.Chat.ChatCompletionMessageParam[] = [];

  for (const row of rows) {
    if (row.sender_type === "agent") {
      if (row.type === "tool_call") {
        const { code, language } = safeParse(row.content, { code: "", language: "bash" });
        turns.push({
          role: "assistant",
          content: `[Ran ${language} code]\n${code}`,
        });
        continue;
      }
      if (row.type === "tool_result") {
        const { stdout, stderr, exit_code } = safeParse<RunResult>(row.content, {
          stdout: "",
          stderr: "",
          exit_code: 0,
        });
        const parts = [];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        parts.push(`exit code: ${exit_code}`);
        turns.push({ role: "user", content: `[Code output]\n${parts.join("\n")}` });
        continue;
      }
      const text = row.content?.trim();
      if (!text) continue; // skip interrupted-before-any-output agent rows
      turns.push({ role: "assistant", content: text });
    } else {
      const text = row.content?.trim();
      // The trigger row is never skipped for being textless, even though
      // every other empty user row is — an attachment-only message (a
      // screenshot sent with no caption typed) has nothing else to anchor
      // a turn on, and skipping it here would mean the attachment-folding
      // step in the POST handler below has no trigger turn left to attach
      // to (in the worst case, an all-attachment thread with no other
      // messages would hit "Nothing to respond to" despite having
      // something very much worth responding to).
      if (!text && row.id !== triggerMessageId) continue;
      const name = firstOf(row.profiles)?.username ?? "teammate";
      const body = text || "[sent an attachment with no caption]";
      const content =
        row.id === triggerMessageId
          ? `${name}: ${body}\n\n[Respond to this message only. Any earlier messages above ` +
            `that never got a reply are separate questions someone else asked — they're being ` +
            `answered independently, so don't address them here. Start your reply with ` +
            `"@${name} " to tag them.]`
          : `${name}: ${body}`;
      turns.push({ role: "user", content });
    }
  }

  // Groq expects the conversation (after the system prompt) to open on a user turn.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();
  return turns;
}

export async function POST(request: Request) {
  // Authenticate before anything else, so an anonymous caller learns nothing
  // about server configuration.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Both optional — Groq is the primary provider for the two non-code tiers
  // (OpenRouter is its fallback there), and OpenRouter is the sole provider
  // for code requests. Missing either just means that leg is skipped;
  // postFailureNotice covers the case where nothing is left to try.
  const groqKey = process.env.GROQ_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  // maxRetries: 0 on BOTH clients — the SDK's default retry-with-backoff
  // would silently eat 30+ seconds retrying a rate-limited call before our
  // own fallback chain ever gets a chance to run (a 429 should surface
  // immediately), and would just as silently multiply the `timeout` below
  // by up to (1 + default retries) if left on the OpenRouter client, which
  // used to have no explicit retry setting at all. timeout is a client-level
  // default here mainly for documentation/intent — see IDLE_TIMEOUT_MS's own
  // comment for why runModelTurn's ticker is what actually enforces this in
  // practice (an already-open stream going idle isn't reliably caught by
  // this option alone, confirmed live this session).
  const groq = groqKey ? new Groq({ apiKey: groqKey, maxRetries: 0, timeout: IDLE_TIMEOUT_MS }) : null;
  const openrouter = openrouterKey
    ? new OpenAI({
        apiKey: openrouterKey,
        baseURL: "https://openrouter.ai/api/v1",
        maxRetries: 0,
        timeout: IDLE_TIMEOUT_MS,
      })
    : null;

  const { threadId, triggerMessageId, modelOverride, openFilePath } = (await request.json()) as {
    threadId?: string;
    triggerMessageId?: string;
    modelOverride?: "chat" | "build";
    // Whichever project file (if any) is selected in the sender's Project
    // panel at send time — the one cheap, reliable signal for "is this
    // message about the file already open" vs. "this is a new task" that
    // doesn't require guessing from chat text alone. Purely advisory: it's
    // just one input to chooseFileTarget below, not trusted for anything
    // security-relevant (there is nothing security-relevant about which
    // file a reply's code lands in).
    openFilePath?: string | null;
  };
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  if (!triggerMessageId) {
    return NextResponse.json({ error: "triggerMessageId is required" }, { status: 400 });
  }

  // RLS only returns threads in rooms this user participates in, so this
  // doubles as the authorization check for the whole request.
  const { data: thread } = await supabase
    .from("threads")
    .select("id, room_id")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  const roomId = thread.room_id;

  // Clear any stop signal left over from a previous (already-finished) reply
  // in this thread before starting a fresh one — see stopRequested() below
  // for why this signal exists at all. Best-effort: a failed clear here just
  // means this new reply could spuriously read as already-cancelled, which
  // fails safe (a visible early stop) rather than unsafe.
  await supabase.from("threads").update({ stop_requested_at: null }).eq("id", threadId);

  // Durable "stop this reply" check, independent of whichever message row
  // happens to be status='streaming' right now. The old interrupt path was
  // purely reactive to a specific row's status — fine while text or a
  // run_code/open_gui_session call is actively streaming, but there are real
  // multi-second gaps between tool-call rounds (waiting on the next model
  // call, which can itself fail over through two or three providers) where
  // no row is streaming at all. Stop had nothing to flip during one of those
  // gaps, so it looked like it silently did nothing and the round loop below
  // had no way to know a stop had landed. Polled once at the top of every
  // round instead of relying on row status alone.
  async function stopRequested(): Promise<boolean> {
    const { data } = await supabase
      .from("threads")
      .select("stop_requested_at")
      .eq("id", threadId)
      .maybeSingle();
    return Boolean(data?.stop_requested_at);
  }

  // Anchor history to the message that triggered this call, not "everything in
  // the thread right now" — two people tagging Koopi close together each fire
  // their own request, and without this a slower request could see the other
  // person's message land first and try to answer both in one reply.
  const { data: triggerRow } = await supabase
    .from("messages")
    .select("created_at, sender_id, profiles!sender_id(username)")
    .eq("id", triggerMessageId)
    .eq("thread_id", threadId)
    .maybeSingle();

  if (!triggerRow) {
    return NextResponse.json({ error: "Triggering message not found" }, { status: 404 });
  }
  // Captured as its own const: same TS-narrowing-doesn't-reach-nested-
  // closures reason /api/projects/run/route.ts's own `userId` const already
  // documents for `user` — runScaffoldToolCall (defined much further below)
  // closes over this plain value instead of `triggerRow.sender_id` itself.
  const triggerSenderId = triggerRow.sender_id;

  // Defense in depth for the per-user "Ask Koopi" toggle: the composer already gates
  // whether it calls this endpoint at all based on the sender's own setting, so this
  // only matters if that state was stale at send time or the endpoint was hit directly
  // — but the whole point of the toggle is to guarantee no model call happens for
  // someone who turned it off, so it's worth the one extra query rather than trusting
  // the client alone.
  if (triggerRow.sender_id) {
    const { data: senderParticipant } = await supabase
      .from("thread_participants")
      .select("koopi_active")
      .eq("thread_id", threadId)
      .eq("user_id", triggerRow.sender_id)
      .maybeSingle();
    if (senderParticipant?.koopi_active === false) {
      return new Response(null, { status: 204 });
    }
  }

  const triggerUsername = firstOf(triggerRow.profiles)?.username ?? "there";
  const triggerCreatedAt = triggerRow.created_at;

  // Most recent MAX_HISTORY messages up to the trigger — fetched newest-first so the
  // limit caps off the oldest end of the window, then reversed back to chronological
  // order for the model. (A straight ascending order+limit would instead return the
  // thread's *earliest* messages once it grows past MAX_HISTORY, permanently freezing
  // context at the start of the conversation.)
  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("id, sender_type, content, sender_id, type, profiles!sender_id(username)")
    .eq("thread_id", threadId)
    .lte("created_at", triggerCreatedAt)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);

  if (historyError) {
    return NextResponse.json({ error: historyError.message }, { status: 403 });
  }

  const turns = historyToTurns(((history ?? []) as MessageRow[]).reverse(), triggerMessageId);
  if (turns.length === 0) {
    return NextResponse.json({ error: "Nothing to respond to" }, { status: 400 });
  }

  // Multimodal attachments (Phase 1 of the debugging-tools build) — images
  // or PDFs the sender attached to THIS trigger message specifically.
  // Deliberately scoped to just the trigger's own attachments, not the
  // whole thread's history: an image attached three messages ago isn't
  // re-sent to the model on every later reply, same "anchor to the
  // trigger" scoping the rest of this function already applies to text.
  const { data: attachmentRows, error: attachmentQueryError } = await supabase
    .from("message_attachments")
    .select("storage_path, filename, mime_type, kind")
    .eq("message_id", triggerMessageId);
  // Was silently discarded before — confirmed live this session that this
  // is exactly how "the attachment table/bucket migration isn't applied
  // yet" surfaced: zero errors anywhere, just an image that silently never
  // reached the model. Still degrades the same way (an empty attachment
  // list, handled below), just not silently anymore.
  if (attachmentQueryError) {
    console.warn(
      `/api/chat: message_attachments query failed for trigger ${triggerMessageId} (migration not applied?):`,
      attachmentQueryError
    );
  }

  const visionImageParts: OpenAI.Chat.ChatCompletionContentPartImage[] = [];
  let attachmentTextBlock = "";
  for (const att of attachmentRows ?? []) {
    const { data: fileBlob, error: downloadErr } = await supabase.storage
      .from("message-attachments")
      .download(att.storage_path);
    if (downloadErr || !fileBlob) {
      console.warn(`/api/chat: failed to download attachment ${att.storage_path}:`, downloadErr);
      continue;
    }
    const buffer = Buffer.from(await fileBlob.arrayBuffer());

    if (att.kind === "image") {
      visionImageParts.push({
        type: "image_url",
        image_url: { url: `data:${att.mime_type};base64,${buffer.toString("base64")}` },
      });
    } else if (att.kind === "pdf") {
      // extractPdf always extracts text; it only ALSO renders page images
      // when the text looks too sparse to be the real content (a scanned
      // page, a screenshot pasted into a doc) — see its own comment for the
      // heuristic. Either way this never throws: a malformed PDF just comes
      // back empty rather than failing the whole turn.
      const { text, pageImageDataUrls } = await extractPdf(buffer);
      if (text) {
        attachmentTextBlock += `\n\n--- Extracted text from attached PDF "${att.filename}" ---\n${text.slice(0, 8000)}`;
      }
      for (const url of pageImageDataUrls) {
        visionImageParts.push({ type: "image_url", image_url: { url } });
      }
    }
  }
  // Only actual images (from an image attachment, or a rendered PDF page)
  // require the vision model — a PDF that extracted cleanly as text needs
  // nothing beyond what's already folded into attachmentTextBlock below.
  const hasVisionAttachments = visionImageParts.length > 0;

  // Fold attachments into the trigger's own turn. historyToTurns always
  // builds the trigger row as the LAST entry (it has the max created_at in
  // the history query, and turns preserves chronological order) and always
  // as role "user" — the leading-turns trim below it only ever drops turns
  // from the FRONT of the array to satisfy "must open on a user turn",
  // never touches the last one.
  if (hasVisionAttachments || attachmentTextBlock) {
    const lastTurn = turns[turns.length - 1];
    const existingText = typeof lastTurn.content === "string" ? lastTurn.content : "";
    turns[turns.length - 1] = {
      role: "user",
      content: [{ type: "text", text: existingText + attachmentTextBlock }, ...visionImageParts],
    };
  }

  // Route on the raw trigger text, not the annotated turn — casual chatter
  // stays on the cheap model, anything build/code-shaped gets the real one.
  //
  // Two independent signals come out of this: `isCode` decides whether the
  // code-specialized model handles the reply at all, and is read purely from
  // the message content (classifyIntent's own heuristics) — a manual
  // Efficient/Powerful override doesn't change whether something IS code, so
  // it doesn't affect isCode. `tier` decides Efficient vs Powerful for
  // everything that ISN'T code, and there the manual override from the
  // composer's model switcher does win over the heuristic guess — the person
  // sending the message knows better than a guess. Vision attachments win
  // over both: they're not decided by text content at all, and there's only
  // one model in the whole routing table that can actually read an image.
  const triggerText = (history ?? []).find((row) => row.id === triggerMessageId)?.content ?? "";
  const autoIntent = classifyIntent(triggerText);
  const tier: "chat" | "build" = modelOverride ?? autoIntent;
  const isCode = autoIntent === "build";
  // What actually gets recorded on the reply and shown in the UI badge.
  const displayTier: "chat" | "build" | "code" | "vision" = hasVisionAttachments
    ? "vision"
    : isCode
      ? "code"
      : tier;
  console.log(
    `/api/chat: trigger=${triggerMessageId} tier=${tier} isCode=${isCode} vision=${hasVisionAttachments}` +
      (modelOverride ? " (manual override)" : "")
  );

  const encoder = new TextEncoder();

  // Room-level memory: a rolling summary of everything that's happened in this
  // room across ALL its threads, so a brand-new thread isn't starting blind.
  // Regenerated lazily — only when there's no summary yet, or enough new
  // activity has piled up — never on every message.
  async function getRoomMemory(): Promise<string | null> {
    const { data: room } = await supabase
      .from("rooms")
      .select("memory_summary, memory_summarized_until")
      .eq("id", roomId)
      .maybeSingle();

    const existingSummary = room?.memory_summary ?? null;
    const since = room?.memory_summarized_until ?? null;

    // RLS on `messages` only allows a user to read threads they're a
    // participant of — a plain query here would silently drop every other
    // thread's messages for anyone not in all of them. This RPC runs with
    // elevated privileges but still gates on room (not per-thread) membership.
    const { data: newMessages } = (await supabase.rpc("get_room_memory_messages", {
      p_room_id: roomId,
      p_since: since,
      p_until: triggerCreatedAt,
    })) as {
      data: {
        thread_id: string;
        sender_type: "user" | "agent";
        username: string | null;
        content: string;
        created_at: string;
      }[] | null;
    };
    const rows = (newMessages ?? []).filter((r) => r.content?.trim());

    if (rows.length === 0) return existingSummary;
    // Best-effort feature — without a fallback provider configured, there's
    // no cheap model left to spend on background summarization.
    if (!groq) return existingSummary;

    // The current thread already sees its own history via normal turn context,
    // so same-thread chatter can wait for the batch threshold. But activity in
    // OTHER threads is exactly the gap this feature exists to close — refresh
    // right away so it doesn't take 20 messages before a teammate's decision
    // in another thread becomes visible here.
    const otherThreadActivity = rows.some((r) => r.thread_id !== threadId);
    if (existingSummary && !otherThreadActivity && rows.length < MEMORY_REGEN_THRESHOLD) {
      return existingSummary;
    }

    const formatted = rows
      .map((r) => {
        const name = r.sender_type === "agent" ? "Koopi" : (r.username ?? "teammate");
        return `${name}: ${r.content.trim()}`;
      })
      .join("\n");

    // Names the prompt is on the hook to attribute by: any human whose message
    // this batch is long enough to plausibly be a decision/opinion, not just
    // "ok"/"thanks". Short-message senders are excluded so small talk doesn't
    // trigger a false-positive retry.
    const namesToAttribute = Array.from(
      new Set(
        rows
          .filter((r) => r.sender_type === "user" && r.content.trim().length >= 15)
          .map((r) => r.username?.trim())
          .filter((n): n is string => Boolean(n))
      )
    );
    const missingFrom = (text: string) =>
      namesToAttribute.filter((n) => !text.toLowerCase().includes(n.toLowerCase()));

    async function draftSummary(correction?: string): Promise<string | undefined> {
      const completion = await groq!.chat.completions.create({
        model: GROQ_MODEL.chat,
        max_completion_tokens: 400,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: MEMORY_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Existing summary: ${existingSummary ?? "(none yet)"}\n\n` +
              `New activity since then:\n${formatted}\n\nProduce the updated summary.` +
              (correction ? `\n\n${correction}` : ""),
          },
        ],
      });
      return completion.choices[0]?.message?.content?.trim();
    }

    try {
      let updated = await draftSummary();
      if (!updated) return existingSummary;

      // The system prompt already asks for per-person attribution, but that's
      // an instruction, not a guarantee — a fast/small model can quietly
      // collapse "Navin proposed Postgres; test2 suggested MongoDB" into "the
      // team discussed database options" once token pressure builds up over
      // many regen cycles. Check for it every time this runs (not just once
      // at review time) and give the model one corrective pass before
      // accepting a summary that dropped someone.
      let missing = missingFrom(updated);
      if (missing.length > 0) {
        const retried = await draftSummary(
          `Your draft didn't explicitly name: ${missing.join(", ")}. Each of them said ` +
            `something substantive above — revise so every one of them is attributed by ` +
            `name to their specific statement, not folded into a group summary.`
        );
        if (retried) {
          const retryMissing = missingFrom(retried);
          if (retryMissing.length < missing.length) {
            updated = retried;
            missing = retryMissing;
          }
        }
      }
      if (missing.length > 0) {
        // Not fatal — still ship the summary — but this is the signal that
        // makes attribution an observable, ongoing quality metric instead of
        // a one-time prompt check: if this line starts showing up regularly,
        // the prompt (or the model) needs another look.
        console.warn(
          `/api/chat: room memory for room ${roomId} still missing attribution for ${missing.join(", ")} after retry`
        );
      }

      const until = rows[rows.length - 1].created_at as string;
      const { error: rpcError } = await supabase.rpc("update_room_memory", {
        p_room_id: roomId,
        p_summary: updated,
        p_until: until,
      });
      if (rpcError) throw rpcError;

      return updated;
    } catch (err) {
      // Best-effort — a summarization hiccup should never block or degrade
      // the actual chat response.
      console.warn(`/api/chat: room memory update skipped for room ${roomId}:`, err);
      return existingSummary;
    }
  }

  // Style only — kept independent of getRoomMemory's more involved query so a
  // personality change is never gated on the memory-regeneration logic above.
  // Thread-scoped, not room-scoped (see threads.personality's own migration,
  // 20260825_thread_scoped_personality.sql) — different threads in the same
  // room can run different active styles independently now.
  //
  // select("*") deliberately, not select("personality") — confirmed live
  // against this project that naming a column PostgREST doesn't have yet
  // hard-fails the WHOLE query (42703), not just this one field. Since this
  // function sits on the path every single reply goes through, that failure
  // mode would have silently broken every Koopi response in every room
  // (not just personality) the moment this shipped ahead of the migration
  // being applied — select("*") + an optional-chained field read degrades
  // to "default" instead, exactly like this always intended to.
  // Same select("*")-not-select("column") reasoning as before, now also
  // covering context_project_file_id (20260828_add_thread_context_file.sql)
  // — naming either column before its migration is applied would 42703 the
  // whole query and silently break every Koopi reply in every room, not
  // just this one field.
  async function getThreadContext(): Promise<{
    personality: Personality;
    contextProjectFileId: string | null;
  }> {
    const { data: thread } = await supabase
      .from("threads")
      .select("*")
      .eq("id", threadId)
      .maybeSingle();
    return {
      personality: (thread?.personality as Personality | null | undefined) ?? "default",
      contextProjectFileId: (thread?.context_project_file_id as string | null | undefined) ?? null,
    };
  }

  // Only present for a "Discuss this file" thread (see RoomView's
  // handleDiscussFile / ProjectPanel's onDiscussFile) — fetched fresh every
  // reply, not frozen at thread-creation time, so the injected content is
  // always what the file actually holds right now, including any change
  // approved since the thread was opened.
  async function fileContextBlock(contextProjectFileId: string | null): Promise<string> {
    if (!contextProjectFileId) return "";
    const { data: file } = await supabase
      .from("project_files")
      .select("path, content, language")
      .eq("id", contextProjectFileId)
      .maybeSingle();
    if (!file) return "";
    return (
      `\n\nThis is a private, file-scoped conversation. The user is discussing this project file:\n\n` +
      `### ${file.path}\n\`\`\`${file.language}\n${file.content}\n\`\`\`\n`
    );
  }

  // Every regular room thread (i.e. NOT a "Discuss this file" thread —
  // fileContextBlock above already covers that one) is where Koopi's actual
  // project editing happens: restyle the CSS, then come back later in the
  // same thread and just ask for the slogan to change. Before this, that
  // second turn had zero live visibility into what was actually approved
  // for the first — only its own memory of the tool call from earlier in
  // the conversation (capped at MAX_HISTORY messages, and never reflecting
  // an approval that landed after the model's own last mention of the
  // file). Since scaffold_web_app and the plain-fenced-file path both
  // regenerate "the complete current file" from scratch every time (see
  // [PROJECT FILES] above), any drift between what the model *remembers*
  // writing and what's actually live in project_files.content came back as
  // a silent regression on the very next unrelated edit — confirmed live:
  // approve a Member's CSS restyle, then ask for an unrelated slogan
  // change, and the CSS reverts because the model regenerated it from a
  // stale/half-remembered version instead of copying the approved bytes
  // forward untouched. Deliberately a read-only lookup (not
  // ensureRoomProjectId, which lazily CREATES a project and is defined
  // later in this handler — calling it this early would touch its
  // `let cachedProjectId` before that declaration runs) — if no project
  // exists yet there's nothing to show anyway.
  const PROJECT_CONTEXT_MAX_CHARS = 20000;
  async function projectFilesContextBlock(): Promise<string> {
    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("room_id", roomId)
      .maybeSingle();
    if (!project) return "";
    const { data: files } = await supabase
      .from("project_files")
      .select("path, content, language")
      .eq("project_id", project.id)
      .order("path");
    const real = (files ?? []).filter((f) => !isFolderMarker(f.path) && f.content);
    if (!real.length) return "";

    let used = 0;
    const blocks = real.map((f) => {
      const block = `### ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\`\n`;
      if (used + block.length > PROJECT_CONTEXT_MAX_CHARS) {
        return `### ${f.path}\n(too large to include here — ${f.content.length} chars; open "Discuss this file" to see it)\n`;
      }
      used += block.length;
      return block;
    });

    return (
      `\n\nThis room's Project currently contains these files. This is their exact, ` +
      `live, currently-approved content — not necessarily what you wrote or proposed ` +
      `earlier in this conversation, since an owner/admin's approval, a direct edit, ` +
      `or another thread's change can all land here without appearing in this ` +
      `thread's own history. When scaffold_web_app or a fenced-file edit rewrites ` +
      `"the complete current file" (see [PROJECT FILES] above), copy every file you ` +
      `are NOT intentionally changing forward exactly as shown here — never ` +
      `regenerate an untouched file from memory:\n\n` +
      blocks.join("\n")
    );
  }

  const [roomMemory, threadContext] = await Promise.all([getRoomMemory(), getThreadContext()]);
  const { personality, contextProjectFileId } = threadContext;

  const effectiveSystemPrompt =
    (roomMemory
      ? `${SYSTEM_PROMPT}\n\nRoom memory (prior activity in this room, across other threads):\n${roomMemory}`
      : SYSTEM_PROMPT) +
    personalityBlock(personality) +
    (contextProjectFileId
      ? await fileContextBlock(contextProjectFileId)
      : await projectFilesContextBlock());

  const isRateLimited = (err: unknown) =>
    err instanceof Groq.RateLimitError || err instanceof OpenAI.RateLimitError;

  // A genuine API failure (rate limit, network blip, etc.) must never just
  // vanish — the person who tagged Koopi should always see *something*
  // rather than silence that looks like they were ignored.
  async function postFailureNotice(err: unknown) {
    const reason = isRateLimited(err)
      ? "we've hit today's usage limit for the model — try again a bit later."
      : err instanceof UpstreamIdleTimeoutError
        ? "the model took too long to respond — try asking again."
        : "I hit an error trying to respond — try asking again.";
    // The bare `err` object alone renders as a truncated "[Object]" for its
    // own nested `.error` (the actual provider-reported body — message/code/
    // metadata) once console's default inspect depth is exceeded, which is
    // exactly the field that would explain WHY a provider 400'd rather than
    // just that it did. Logged as a separate, explicit arg so it prints in
    // full instead of getting swallowed.
    console.error(
      `/api/chat: model call failed for trigger ${triggerMessageId}:`,
      err instanceof Error ? err.message : err,
      "detail:",
      JSON.stringify((err as { error?: unknown })?.error ?? null)
    );
    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "text",
      content: `@${triggerUsername} ${reason}`,
      status: "complete",
    });
  }

  // Best-effort classification for the room-memory/flagged badges — runs after a reply
  // is already fully streamed and saved, so a failure or skip here never affects what the
  // person sees, only whether the badges show up moments later. Same "no fallback model
  // configured" degrade-quietly pattern as getRoomMemory above.
  async function classifySignals(
    replyText: string
  ): Promise<{ usedRoomMemory: boolean; flagged: boolean }> {
    const none = { usedRoomMemory: false, flagged: false };
    if (!groq || !replyText.trim()) return none;

    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL.chat,
        // 40 wasn't enough headroom once GROQ_MODEL.chat became a reasoning
        // model — confirmed live that reasoning tokens alone (which count
        // against this budget same as visible output) can eat a 20-40 token
        // cap before any JSON comes out at all. 100 leaves real margin
        // beyond the ~40-60 reasoning tokens observed at "low" effort.
        max_completion_tokens: 100,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: SIGNAL_CLASSIFIER_PROMPT },
          {
            role: "user",
            content:
              `Room-memory context: ${roomMemory ?? "(none provided)"}\n\n` +
              `Assistant reply:\n${replyText}`,
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      const parsed = safeParse<{ used_room_memory?: boolean; flagged?: boolean }>(raw, {});
      return {
        // Belt-and-suspenders: never true if there genuinely was no memory to draw on,
        // regardless of what the classifier says.
        usedRoomMemory: Boolean(parsed.used_room_memory) && Boolean(roomMemory),
        flagged: Boolean(parsed.flagged),
      };
    } catch (err) {
      console.warn(`/api/chat: signal classification skipped for trigger ${triggerMessageId}:`, err);
      return none;
    }
  }

  // Separate, focused call for the file-update decision — see the prompt's own
  // comment for why this can't just be a third field on classifySignals above.
  // Cheap short-circuit: no fenced block at all means an LLM call can't change
  // the answer, so skip it entirely.
  async function classifyFileUpdate(triggerText: string, replyText: string): Promise<boolean> {
    if (!groq || !replyText.includes("```")) return false;

    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL.chat,
        // Was 20 — confirmed live that's not enough once this became a
        // reasoning model; see classifySignals' comment on the same issue.
        max_completion_tokens: 80,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: FILE_UPDATE_CLASSIFIER_PROMPT },
          {
            role: "user",
            content: `User's request:\n${triggerText}\n\nAssistant reply:\n${replyText}`,
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      const parsed = safeParse<{ is_file_update?: boolean }>(raw, {});
      return Boolean(parsed.is_file_update);
    } catch (err) {
      console.warn(`/api/chat: file-update classification skipped for trigger ${triggerMessageId}:`, err);
      return false;
    }
  }

  // Decides which project_files path a piece of file-worthy code lands on.
  // `candidate` is the one file (if any) worth considering as a continuation
  // — either the sender's explicit Project-panel selection, or a same-thread
  // fallback from resolveContinuationHint below. `existingFiles` (path +
  // content) is fetched fresh by each call site right before calling this,
  // so a second file-worthy reply in the same turn (tool call + a final text
  // block, say) sees whatever the first one just created and won't collide
  // with it.
  //
  // Confirmed live: `candidate` is only ever a RECENCY guess (whichever file
  // Koopi last touched in this thread) — it has no idea whether the request
  // is actually ABOUT that file. A member asked to rename a button; the
  // thread's most-recently-touched file happened to be an unrelated
  // just-scaffolded index.html with no such button in it, so the old
  // classifier (which only ever saw the candidate's own content plus a bare
  // list of other PATHS, no content) had nothing to recognize the real
  // target — app/page.tsx, which actually had the button — by, and
  // fabricated a new file instead. Passing every other file a short content
  // preview (not just its name) is what lets the classifier catch that.
  async function chooseFileTarget(
    triggerText: string,
    language: string,
    candidate: FileContinuationCandidate | null,
    existingFiles: { path: string; content: string }[]
  ): Promise<{ path: string; isNewFile: boolean }> {
    const existingPaths = existingFiles.map((f) => f.path);
    const fallbackToNewFile = () => ({
      path: uniquePath(slugFilename(triggerText, language), existingPaths),
      isNewFile: true,
    });
    // Belt-and-suspenders alongside resolveContinuationHint's own validation
    // at its source: candidate.path gets returned as-is below in more than
    // one place (the forceExisting shortcut, the classifier's "existing"
    // answer, the no-groq/classifier-failure fallback) — every one of those
    // is a real DB row's key the instant it's used. Discarding an implausible
    // candidate here means a bad path can never reach any of them, no matter
    // which source it came from or which one of resolveContinuationHint's
    // own validation gets missed in some future change.
    if (candidate && !isPlausibleRelativePath(candidate.path)) candidate = null;
    // The one case narrow enough to skip the classifier entirely — see
    // resolveContinuationHint for exactly when this is set.
    if (candidate?.forceExisting) {
      return { path: candidate.path, isNewFile: false };
    }
    // No groq configured, or the classifier call below fails: a candidate
    // (explicit or inferred) is a better default than always fragmenting
    // into a new file — that silent-guess behavior is exactly the bug this
    // function exists to avoid. Only truly candidate-less requests fall
    // back to a fresh, uniquely-named file.
    const fallback = () => (candidate ? { path: candidate.path, isNewFile: false } : fallbackToNewFile());
    if (!groq) return fallback();

    // Every OTHER file gets a short content preview (not just its path) so
    // the classifier can match by what a file actually contains, capped
    // both per-file and in total — this runs on every code-worthy reply, not
    // once per turn, so it stays much tighter than projectFilesContextBlock.
    let previewBudget = FILE_TARGET_PREVIEW_TOTAL_CHARS;
    const otherPreviews = existingFiles
      .filter((f) => f.path !== candidate?.path && !isFolderMarker(f.path) && f.content)
      .map((f) => {
        if (previewBudget <= 0) return null;
        const snippet = f.content.slice(0, FILE_TARGET_PREVIEW_CHARS_PER_FILE);
        previewBudget -= snippet.length;
        return `### ${f.path}\n${snippet}`;
      })
      .filter((b): b is string => b !== null)
      .join("\n\n");

    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL.chat,
        // Was 60 — same reasoning-model budget fix as classifySignals above.
        max_completion_tokens: 150,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: FILE_TARGET_PROMPT },
          {
            role: "user",
            content:
              (candidate
                ? `User's request:\n${triggerText}\n\nCandidate file: ${candidate.path}\n` +
                  `Why it was suggested: ${candidate.reason}\n` +
                  `--- its current content (may be empty or unrelated) ---\n${candidate.content.slice(0, 800)}\n\n`
                : `User's request:\n${triggerText}\n\nNo candidate file — nothing open, nothing recent in this thread.\n\n`) +
              `Other files already in the project (short previews — match by content, not just filename):\n` +
              (otherPreviews || "(none)") +
              `\n\nGenerated code language: ${language}`,
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      const parsed = safeParse<{ target?: string; filename?: string }>(raw, {});
      if (parsed.target === "existing") {
        const chosen = parsed.filename?.trim();
        // Only ever an existing path the model was actually shown above —
        // never trusted as a brand-new path just because target=="existing".
        if (chosen && existingPaths.includes(chosen)) {
          return { path: chosen, isNewFile: false };
        }
        if (candidate) return { path: candidate.path, isNewFile: false };
      }
      const suggested = parsed.filename?.trim();
      // Reject anything that doesn't look like a plausible relative path
      // (see isPlausibleRelativePath) rather than trust the model's output
      // verbatim for something that becomes a DB row's key. A bare
      // filename still passes (it's a one-segment path); "/"s are only
      // allowed as folder separators now that the prompt above can suggest
      // nesting into an existing folder — never a leading slash, "..", or
      // an empty segment.
      const name = suggested && isPlausibleRelativePath(suggested) ? suggested : slugFilename(triggerText, language);
      return { path: uniquePath(name, existingPaths), isNewFile: true };
    } catch (err) {
      console.warn(`/api/chat: file-target classification failed for trigger ${triggerMessageId}, defaulting:`, err);
      return fallback();
    }
  }

  // Resolves the fallback "file being continued" candidate for when the
  // sender doesn't have anything explicitly open — the actual gap behind the
  // duplicate-file bug this fixes. Two signals, tried in order of how much
  // they're worth trusting, both scoped to server-side state chooseFileTarget
  // never had access to before:
  //
  //  1. The Project panel's Run button just failed on a specific file. That
  //     result lives entirely in `projects.last_run_*` — a table/endpoint
  //     (app/api/projects/run/route.ts) completely separate from this
  //     thread's `messages` — so without this explicit lookup, this route
  //     has no way to know a run even happened, let alone that it errored.
  //     This is almost certainly the actual mechanism behind the reported
  //     bug: an EOFError (or any other run failure) followed by "try
  //     again"/a rephrase, arriving here with zero memory of the attempt
  //     that just failed.
  //  2. Otherwise, the most recent file Koopi itself wrote to IN THIS
  //     THREAD, recovered from the already-fetched `history` — a tool
  //     call's recorded path, or the "📄 Updated X" marker a prior text
  //     reply left behind. Covers "just re-asking" with no error involved.
  //
  // Cached per-request: both syncProjectFile (tool-call path) and the
  // isFileUpdate text path may call this in the same turn and should agree.
  let cachedContinuationHint: FileContinuationCandidate | null | undefined;
  async function resolveContinuationHint(projectId: string): Promise<FileContinuationCandidate | null> {
    if (cachedContinuationHint !== undefined) return cachedContinuationHint;

    // Recent enough that "try again" plausibly means the same file, short
    // enough that a stale failure from an unrelated earlier task doesn't
    // linger and wrongly capture a genuinely new request much later.
    const RECENT_RUN_WINDOW_MS = 3 * 60 * 1000;
    const { data: projectRow } = await supabase
      .from("projects")
      .select("run_entry_path, last_run_exit_code, last_run_at")
      .eq("id", projectId)
      .maybeSingle();

    if (
      projectRow?.run_entry_path &&
      projectRow.last_run_exit_code !== null &&
      projectRow.last_run_exit_code !== 0 &&
      projectRow.last_run_at &&
      Date.now() - new Date(projectRow.last_run_at).getTime() < RECENT_RUN_WINDOW_MS
    ) {
      cachedContinuationHint = {
        path: projectRow.run_entry_path,
        content: "",
        reason: "its last run just failed with an error — almost certainly what's being retried",
        forceExisting: true,
      };
      return cachedContinuationHint;
    }

    // Scan this thread's own history, newest-first (excluding the trigger
    // row itself), for the most recent file Koopi touched here.
    for (let i = (history ?? []).length - 2; i >= 0; i--) {
      const row = (history as MessageRow[])[i];
      if (row.sender_type !== "agent") continue;
      let path: string | undefined;
      if (row.type === "tool_call") {
        path = safeParse<{ path?: string }>(row.content, {}).path;
      } else if (row.type === "text") {
        path = row.content?.match(/📄 Updated (\S+) —/)?.[1];
      }
      // A scaffold_web_app tool_call's own `path` field is display text —
      // runScaffoldToolCall joins every file it touched with ", " for a
      // human-readable summary ("index.html, style.css"), not a single real
      // path. Confirmed live as the actual mechanism behind a proposed
      // change landing in a project_files row literally named
      // "index.html, style.css": that joined string got picked up here as
      // "the file Koopi most recently worked on", then passed through
      // chooseFileTarget completely unvalidated (isPlausibleRelativePath
      // only ever ran when a brand-NEW filename was being chosen — a
      // pre-existing candidate was implicitly trusted). Rejecting it here,
      // at the one place it enters the system, closes this regardless of
      // how many files a single scaffold call touched.
      if (!path || !isPlausibleRelativePath(path)) continue;

      const { data: fileRow } = await supabase
        .from("project_files")
        .select("content")
        .eq("project_id", projectId)
        .eq("path", path)
        .maybeSingle();
      cachedContinuationHint = {
        path,
        content: fileRow?.content ?? "",
        reason: "the file Koopi most recently worked on in this conversation",
        forceExisting: false,
      };
      return cachedContinuationHint;
    }

    cachedContinuationHint = null;
    return null;
  }

  // Shared by both file-writing paths below: the sender's explicit
  // Project-panel selection, when it's actually present in this project's
  // file list. Kept separate from resolveContinuationHint so an explicit
  // choice always wins over an inferred one.
  function explicitOpenCandidate(
    fileRows: { path: string; content: string | null }[]
  ): FileContinuationCandidate | null {
    const row = openFilePath ? fileRows.find((f) => f.path === openFilePath) : undefined;
    return row
      ? { path: row.path, content: row.content ?? "", reason: "currently open in your editor", forceExisting: false }
      : null;
  }

  // A no-op update guarded on `status = 'streaming'` — 0 rows affected means
  // someone else (Stop) already flipped it, same trick the text flush uses.
  async function isStillStreaming(messageId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("messages")
      .update({ status: "streaming" })
      .eq("id", messageId)
      .eq("status", "streaming")
      .select("id");
    if (error) return true; // transient failure — don't abort on a hiccup
    return Boolean(data && data.length > 0);
  }

  type PendingToolCall = { id: string; name: string; arguments: string };

  type TurnOutcome =
    | { kind: "interrupted" }
    // messageId/text are null/empty when no reply ever reached the chat (e.g. every
    // provider failed before a row was created) — callers use their presence to decide
    // whether there's anything worth classifying for the room-memory/flagged badges.
    | { kind: "text"; messageId: string | null; text: string }
    | { kind: "tool_use"; calls: PendingToolCall[] };

  async function runModelTurn(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<TurnOutcome> {
    let textMessageId: string | null = null;
    let text = "";
    let flushed = "";
    let interrupted = false;
    // Distinct from `interrupted` (a Stop-button abort, no failure notice)
    // — this IS a failure, just one we caused ourselves by giving up early
    // rather than one the provider reported. See IDLE_TIMEOUT_MS.
    let timedOut = false;
    let lastChunkAt = Date.now();
    let finishReason: string | null = null;
    let streamError: unknown = null;
    const toolCallAcc = new Map<number, PendingToolCall>();

    async function flush(status: "streaming" | "complete") {
      if (!textMessageId) return true;
      if (status === "streaming" && text === flushed) return true;

      const { data, error } = await supabase
        .from("messages")
        .update({ content: text, status })
        .eq("id", textMessageId)
        .eq("status", "streaming")
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) return false;

      flushed = text;
      return true;
    }

    const requestMessages = [{ role: "system" as const, content: effectiveSystemPrompt }, ...turns];

    // Groq and OpenRouter are both cast to the same ChatStream shape —
    // OpenRouter speaks OpenAI's wire format natively, and Groq's
    // separately-typed SDK speaks the same format under the hood.
    async function tryOpenrouter(
      model: string,
      maxCompletionTokens: number
    ): Promise<{ stream: ChatStream } | { error: unknown }> {
      if (!openrouter) return { error: new Error("OPENROUTER_API_KEY is not set") };
      try {
        return {
          stream: (await openrouter.chat.completions.create({
            model,
            max_completion_tokens: maxCompletionTokens,
            stream: true,
            tools: [RUN_CODE_TOOL, OPEN_GUI_TOOL, SCAFFOLD_WEB_APP_TOOL, WEB_SEARCH_TOOL] as unknown as OpenAI.Chat.ChatCompletionTool[],
            messages: requestMessages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
          })) as ChatStream,
        };
      } catch (err) {
        return { error: err };
      }
    }

    let stream: ChatStream;
    // Recorded onto the agent's message row so the UI can show which tier and
    // provider actually answered — the composer's tier choice doesn't always
    // match reality once a fallback kicks in.
    let provider: "groq" | "openrouter";

    if (hasVisionAttachments) {
      // Same "no primary leg to try first" reasoning as the isCode branch
      // below — confirmed in Phase 0's audit that neither Groq's models nor
      // the code model accept image input at all, so there's nothing to
      // fail over FROM, only the one model that can actually read one.
      const result = await tryOpenrouter(VISION_MODEL, MAX_COMPLETION_TOKENS.build);
      if ("error" in result) {
        await postFailureNotice(result.error);
        return { kind: "text", messageId: null, text: "" };
      }
      stream = result.stream;
      provider = "openrouter";
    } else if (isCode) {
      // Code always goes straight to the code-specialized OpenRouter model —
      // Groq has no comparable free-tier code model, so there's no primary
      // leg to try before this one.
      const result = await tryOpenrouter(OPENROUTER_CODE_MODEL, MAX_COMPLETION_TOKENS.build);
      if ("error" in result) {
        await postFailureNotice(result.error);
        return { kind: "text", messageId: null, text: "" };
      }
      stream = result.stream;
      provider = "openrouter";
    } else if (groq) {
      try {
        stream = (await groq.chat.completions.create({
          model: GROQ_MODEL[tier],
          max_completion_tokens: MAX_COMPLETION_TOKENS[tier],
          reasoning_effort: REASONING_EFFORT[tier],
          stream: true,
          tools: [RUN_CODE_TOOL, OPEN_GUI_TOOL, SCAFFOLD_WEB_APP_TOOL, WEB_SEARCH_TOOL],
          messages: requestMessages,
        })) as ChatStream;
        provider = "groq";
      } catch (groqErr) {
        // Fail over to OpenRouter unconditionally, not just on a classified
        // rate limit — Groq's own SDK doesn't reliably map every quota/
        // availability failure to RateLimitError (its TPM-cap response
        // comes back as a plain HTTP 413, which isn't classified as a rate
        // limit at all), so gating the fallback on isRateLimited() was
        // silently skipping OpenRouter on exactly the kind of failure this
        // fallback chain exists for. OpenRouter is the last resort anyway —
        // trying it costs at most one extra failed-then-retried request.
        console.log(
          `/api/chat: trigger=${triggerMessageId} groq failed, failing over to openrouter:`,
          groqErr instanceof Error ? groqErr.message : groqErr
        );
        const result = await tryOpenrouter(OPENROUTER_MODEL[tier], MAX_COMPLETION_TOKENS[tier]);
        if ("error" in result) {
          await postFailureNotice(result.error);
          return { kind: "text", messageId: null, text: "" };
        }
        stream = result.stream;
        provider = "openrouter";
      }
    } else {
      // No Groq key at all — go straight to OpenRouter as if it were the
      // primary for this tier.
      const result = await tryOpenrouter(OPENROUTER_MODEL[tier], MAX_COMPLETION_TOKENS[tier]);
      if ("error" in result) {
        await postFailureNotice(result.error);
        return { kind: "text", messageId: null, text: "" };
      }
      stream = result.stream;
      provider = "openrouter";
    }

    const ticker = setInterval(async () => {
      if (Date.now() - lastChunkAt > IDLE_TIMEOUT_MS) {
        timedOut = true;
        stream.controller.abort();
        return;
      }
      try {
        if (!(await flush("streaming"))) {
          interrupted = true;
          stream.controller.abort();
        }
      } catch {
        // Transient write failure — the next tick retries.
      }
    }, FLUSH_MS);

    try {
      for await (const chunk of stream) {
        // ANY chunk proves the connection is still alive, whether or not it
        // carries actual content this time (a keepalive ping, a delta with
        // no text, etc.) — this is what's actually missing from the SDK's
        // own timeout: it covers connection setup, not an already-open
        // stream that's gone quiet mid-response.
        lastChunkAt = Date.now();
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta.content;
        if (delta) {
          text += delta;
          controller.enqueue(encoder.encode(delta));

          if (!textMessageId) {
            const { data, error } = await supabase
              .from("messages")
              .insert({
                room_id: roomId,
                thread_id: threadId,
                sender_type: "agent",
                sender_id: null,
                type: "text",
                content: "",
                status: "streaming",
                model_tier: displayTier,
                model_provider: provider,
              })
              .select("id")
              .single();
            if (!error && data) textMessageId = data.id;
          }
        }

        for (const tc of choice.delta.tool_calls ?? []) {
          const entry = toolCallAcc.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          toolCallAcc.set(tc.index, entry);
        }
      }
    } catch (err) {
      // Aborting the stream throws — that's the expected shape of both a
      // Stop-button interrupt (`interrupted` already true) and our own idle
      // abort (`timedOut` already true) by the time it happens. Substitute
      // a clean, recognizable error for the latter rather than whatever
      // generic AbortError the abort() call itself throws, so
      // postFailureNotice can name it specifically instead of falling into
      // the same bucket as a genuine unclassified failure.
      if (!interrupted) streamError = timedOut ? new UpstreamIdleTimeoutError() : err;
    } finally {
      clearInterval(ticker);
    }

    if (interrupted) {
      return { kind: "interrupted" };
    }

    if (streamError && !textMessageId) {
      // Nothing ever reached the chat — the person who tagged Koopi would
      // otherwise see total silence, indistinguishable from being ignored.
      await postFailureNotice(streamError);
      return { kind: "text", messageId: null, text: "" };
    }

    try {
      await flush("complete");
    } catch {
      // Nothing further we can do — the row keeps its last written content.
    }

    const calls = [...toolCallAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.id && call.name);

    if (finishReason === "tool_calls" && calls.length > 0) {
      // A model narrating "here's the code:" with a fenced block right
      // before calling scaffold_web_app is pure waste — every one of those
      // files is about to be written for real by the tool call itself, so
      // echoing them again in prose duplicates the exact same content for
      // no reason other than tokens. Only scaffold_web_app gets this
      // treatment: run_code/open_gui_session's own accompanying text is a
      // genuinely different (and usually much shorter) case, not reported
      // as a problem.
      if (calls.some((c) => c.name === "scaffold_web_app") && textMessageId) {
        const block = extractFileUpdateBlock(text);
        if (block) {
          const stripped = text.replace(block.fullMatch, "").trim();
          if (stripped) {
            await supabase.from("messages").update({ content: stripped }).eq("id", textMessageId);
          } else {
            // Nothing left but the code dump — no point leaving an empty
            // bubble behind. Best-effort: if this delete is blocked (no
            // DELETE policy on agent-authored messages), the stale text
            // just stays visible, same as before this fix existed.
            await supabase.from("messages").delete().eq("id", textMessageId);
          }
        }
      }

      turns.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      return { kind: "tool_use", calls };
    }

    // Confirmed live: a stream can complete cleanly (no streamError — the
    // guard above only covers one that THREW) and still carry zero content
    // deltas and zero tool calls — a small/free model just... says nothing.
    // Without this, that's silent from here on: no textMessageId means the
    // round-loop's own classification block never runs (it's gated on
    // outcome.messageId), so nothing is ever written or shown, and the
    // person who tagged Koopi sees total silence indistinguishable from
    // being ignored. Same postFailureNotice path streamError already uses,
    // for the same reason: something must always reach the chat.
    if (!textMessageId && calls.length === 0) {
      await postFailureNotice(new Error("The model returned an empty response — no text or tool call."));
      return { kind: "text", messageId: null, text: "" };
    }

    return { kind: "text", messageId: textMessageId, text };
  }

  // Same Owner/Admin-write-directly split every other project_files write
  // in this app already respects (can_edit_project_directly,
  // 20260817_add_room_roles_and_approval.sql) — an Owner/Admin scaffolding
  // their own project isn't proposing anything to anyone; they're the ones
  // who'd be approving it anyway, so gating it behind their own approval
  // was never sensible. Only a Member's scaffold request goes through the
  // pending-batch queue. Queries `participants` directly (not the
  // auth.uid()-scoped get_room_role RPC) since this needs the TRIGGERING
  // user's role, not necessarily whichever session happens to be executing
  // this server route.
  async function getSenderRole(userId: string | null): Promise<"owner" | "admin" | "member" | null> {
    if (!userId) return null;
    const { data } = await supabase
      .from("participants")
      .select("role")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    return (data?.role as "owner" | "admin" | "member" | undefined) ?? null;
  }

  // Room's Project mode replaced the old per-thread thread_files panel — a
  // single project per room (see 20260815_add_projects.sql), so Koopi's
  // auto-saved code now needs a project_id to write into rather than just a
  // thread_id. Lazily creates the room's project exactly like RoomView's own
  // ensureProject() does client-side; the projects.room_id unique constraint
  // makes a race between the two harmless (loser's insert 23505s, re-selects).
  // Set by syncProjectFile and the plain-text isFileUpdate path, each time
  // either one successfully writes a file — read by both (see
  // syncProjectFile's own comment) so a later write in this SAME request
  // always continues whatever this request already wrote, rather than
  // re-guessing via a thread-history scan that can't see writes this
  // request itself hasn't persisted to `history` yet.
  let lastWrittenPathThisRequest: string | null = null;
  let cachedProjectId: string | null = null;
  // Collects every fire-and-forget summarizeProjectFileChange call from
  // syncProjectFile/scaffoldFiles/the inline isFileUpdate paths below —
  // NOT awaited inline at each call site (that would serialize a ~1-2s Groq
  // call with every single file write/scaffold file, adding real latency to
  // the model's own reply for no benefit the person sending the message
  // would ever see), but drained via Promise.allSettled right before this
  // handler's own `finally { controller.close(); }`. A bare `void` here
  // would risk the platform tearing down this request's execution context
  // the moment the response stream finishes flushing — this file's own
  // established pattern (classifySignals/classifyFileUpdate below, both
  // `await`ed via Promise.all despite being just as "best-effort") already
  // treats that as a real risk, not a hypothetical one.
  const backgroundTasks: Promise<unknown>[] = [];
  async function ensureRoomProjectId(): Promise<string | null> {
    if (cachedProjectId) return cachedProjectId;
    const { data: existing } = await supabase
      .from("projects")
      .select("id")
      .eq("room_id", roomId)
      .maybeSingle();
    if (existing) {
      cachedProjectId = existing.id;
      return cachedProjectId;
    }
    const { data: inserted, error: insertErr } = await supabase
      .from("projects")
      .insert({ room_id: roomId, created_by: null })
      .select("id")
      .single();
    if (!insertErr && inserted) {
      cachedProjectId = inserted.id;
      return cachedProjectId;
    }
    const { data: afterRace } = await supabase
      .from("projects")
      .select("id")
      .eq("room_id", roomId)
      .maybeSingle();
    cachedProjectId = afterRace?.id ?? null;
    return cachedProjectId;
  }

  // Keeps a Koopi-authored project file in sync with whatever code Koopi
  // just ran/demoed via a tool call — unconditionally, since a
  // run_code/open_gui_session call is always real code, unlike the
  // isFileUpdate path below which has to guess from prose whether a fenced
  // block in the reply text is a "file" worth keeping. Without this, code
  // that's only ever run (never echoed back into the chat text) never
  // reaches the project at all.
  //
  // WHICH file used to be hardcoded to a single "koopi_scratch" slot,
  // overwritten by every unrelated task — chooseFileTarget (see its own
  // comment) is what fixes that: a new, unrelated request gets its own
  // sensibly-named file; a request that's clearly about the file the
  // sender already has open, or one resolveContinuationHint infers from
  // this same thread's recent activity, updates that one instead.
  // Returns the path it wrote to (or null if it wrote nothing) so callers
  // can record it — runToolCall stamps it onto the tool_call message so a
  // LATER retry in this thread can find it via resolveContinuationHint.
  async function syncProjectFile(code: string, language: string): Promise<string | null> {
    if (!code.trim()) return null;
    // See looksLikePureDiagnosticShell's own comment — a run_code call that's
    // just Koopi looking around (ls, find, cat, ...) isn't a deliverable and
    // shouldn't become its own reviewable project file.
    if (looksLikePureDiagnosticShell(code, language)) return null;

    // A "Discuss this file" thread (contextProjectFileId set) never lets
    // Koopi pick a target file at all — chooseFileTarget's whole job is
    // "which file is this about", and here that's already answered by the
    // thread itself. Nor does it ever write directly: same
    // "never a direct write" test gate the old docked Assistant panel
    // established, now enforced for its replacement entry point instead.
    if (contextProjectFileId) {
      const { data: file } = await supabase
        .from("project_files")
        .select("path")
        .eq("id", contextProjectFileId)
        .maybeSingle();
      if (!file) return null;
      const { data: inserted, error } = await supabase
        .from("project_file_changes")
        .insert({
          project_file_id: contextProjectFileId,
          proposed_by: triggerSenderId,
          proposed_content: code,
          source: "ai_assistant",
          thread_id: threadId,
        })
        .select("id")
        .single();
      // Fire-and-forget, exactly like RoomView.tsx's own requestChangeSummary
      // — the proposal is already fully valid and reviewable without a
      // summary, which lands a moment later via the same realtime
      // subscription the Pending panel already has open.
      if (inserted) backgroundTasks.push(summarizeProjectFileChange(supabase, inserted.id));
      if (error) {
        console.warn(
          `/api/chat: failed to propose a change for context file ${contextProjectFileId} in room ${roomId}:`,
          error
        );
        return null;
      }
      return file.path;
    }

    const projectId = await ensureRoomProjectId();
    if (!projectId) return null;

    const { data: fileRows } = await supabase
      .from("project_files")
      .select("id, path, content")
      .eq("project_id", projectId);
    const existingFiles = (fileRows ?? []).filter((f) => !isFolderMarker(f.path));

    // A file this exact request ALREADY wrote (earlier this same round loop
    // — e.g. round 0's run_code call) wins over everything else, including
    // resolveContinuationHint's own thread-history scan. That scan reads
    // `history`, fetched once before the round loop started — it has no
    // way to see a tool_call this very request inserted a moment ago, which
    // is exactly the gap behind a confirmed-live duplicate: run_code writes
    // file A, then the model's own follow-up text echoes the same code and
    // — with no memory of A — chooseFileTarget's classifier reasonably
    // guesses "new file" and creates file B for what should obviously stay
    // one file.
    const candidate: FileContinuationCandidate | null = lastWrittenPathThisRequest
      ? {
          path: lastWrittenPathThisRequest,
          content: fileRows?.find((f) => f.path === lastWrittenPathThisRequest)?.content ?? "",
          reason: "this exact request already wrote this file a moment ago",
          forceExisting: true,
        }
      : (explicitOpenCandidate(fileRows ?? []) ?? (await resolveContinuationHint(projectId)));

    const { path } = await chooseFileTarget(triggerText, language, candidate, existingFiles);

    // Same Owner/Admin-write-directly split scaffoldFiles() and the plain
    // fenced-code-block path both apply — confirmed live that this branch
    // (reached via run_code/open_gui_session, not scaffold_web_app or a
    // plain reply) was the one remaining project_files write with no role
    // check at all: a Member's run_code result hit RLS on a direct UPDATE
    // to an existing path, failed silently into a console.warn, and Koopi's
    // closing reply went on to claim success anyway with nothing actually
    // saved or proposed anywhere.
    const existingFileId = fileRows?.find((f) => f.path === path)?.id;
    const senderRole = await getSenderRole(triggerSenderId);
    const canWriteDirectly = senderRole === "owner" || senderRole === "admin";

    // See looksLikeExtensionMismatch's own comment — blocks this exact
    // write rather than silently corrupting whatever's already at `path`.
    if (looksLikeExtensionMismatch(path, code)) {
      console.warn(`/api/chat: refused to save ${path} for room ${roomId} — content doesn't match its extension`);
      return null;
    }

    // `language` (the model's self-reported run_code/open_gui_session
    // argument) still decided WHICH sandbox runner just executed this code
    // — that's a real, separate need (SandboxRun genuinely has to know
    // python vs. js vs. ts to run it) — but what gets PERSISTED/displayed
    // is always derived from the actual chosen path, never trusted verbatim
    // from the model. That mismatch (e.g. a .js file saved with
    // language: "python") was the actual bug.
    if (canWriteDirectly) {
      const { error } = await supabase.from("project_files").upsert(
        {
          project_id: projectId,
          path,
          content: code,
          language: languageFromPath(path),
          last_edited_by: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id,path" }
      );
      if (error) {
        console.warn(`/api/chat: failed to upsert project_files for room ${roomId}:`, error);
        return null;
      }
    } else {
      let fileId = existingFileId;
      if (!fileId) {
        // Empty content until approved — same as scaffoldFiles' own
        // new-file case: shows up in the tree immediately (INSERT stays
        // open to any participant) but what it contains is still pending
        // review.
        const { data: inserted, error: insertErr } = await supabase
          .from("project_files")
          .insert({
            project_id: projectId,
            path,
            content: "",
            language: languageFromPath(path),
            last_edited_by: null,
          })
          .select("id")
          .single();
        if (insertErr || !inserted) {
          console.warn(`/api/chat: failed to create project_files row for room ${roomId}:`, insertErr);
          return null;
        }
        fileId = inserted.id;
      }
      const { data: insertedChange, error: changeErr } = await supabase
        .from("project_file_changes")
        .insert({
          project_file_id: fileId,
          proposed_by: triggerSenderId,
          proposed_content: code,
          source: "ai_assistant",
          thread_id: threadId,
        })
        .select("id")
        .single();
      if (insertedChange) backgroundTasks.push(summarizeProjectFileChange(supabase, insertedChange.id));
      if (changeErr) {
        console.warn(`/api/chat: failed to propose project_file_changes for room ${roomId}:`, changeErr);
        return null;
      }
      // Not set for lastWrittenPathThisRequest below — same reasoning the
      // contextProjectFileId branch above already follows: a proposal
      // hasn't landed in project_files.content yet, so a later round of
      // this same request shouldn't treat it as the current state to
      // continue from.
      return path;
    }
    lastWrittenPathThisRequest = path;
    return path;
  }

  async function runToolCall(call: PendingToolCall): Promise<"interrupted" | "done"> {
    const { code, language } = safeParse(call.arguments, { code: "", language: "bash" });
    const path = await syncProjectFile(code, language);

    const { data: toolCallRow, error: toolCallErr } = await supabase
      .from("messages")
      .insert({
        room_id: roomId,
        thread_id: threadId,
        sender_type: "agent",
        sender_id: null,
        type: "tool_call",
        content: JSON.stringify({ code, language, path }),
        status: "streaming",
      })
      .select("id")
      .single();

    if (toolCallErr || !toolCallRow) return "done";
    const toolCallId = toolCallRow.id;

    // Reconnect to this room's shared sandbox if it has one, so a snippet can
    // build on files/state a previous run_code call left behind — from this
    // thread OR any other thread in the same room. Room-scoped (not
    // thread-scoped) is a deliberate choice: it matches "same project,
    // different chat" rather than the stricter per-thread isolation used
    // for messages/memory.
    const { data: roomRow } = await supabase
      .from("rooms")
      .select("sandbox_id")
      .eq("id", roomId)
      .maybeSingle();

    const sandboxRun = new SandboxRun(code, language, roomRow?.sandbox_id ?? null);
    let interruptedTool = false;

    const ticker = setInterval(async () => {
      if (!(await isStillStreaming(toolCallId))) {
        interruptedTool = true;
        clearInterval(ticker);
        void sandboxRun.cancel();
      }
    }, FLUSH_MS);

    let result: RunResult;
    let sandboxId: string | null = null;
    try {
      const outcome = await sandboxRun.run();
      result = outcome.result;
      sandboxId = outcome.sandboxId;
    } catch (err) {
      result = {
        stdout: "",
        stderr: err instanceof Error ? err.message : "Sandbox execution failed.",
        exit_code: -1,
      };
    } finally {
      clearInterval(ticker);
    }

    if (interruptedTool || !(await isStillStreaming(toolCallId))) {
      return "interrupted";
    }

    // Persist the (possibly new) sandbox ID so the next run_code call
    // anywhere in this room reconnects to it instead of starting over.
    // Goes through the same SECURITY DEFINER RPC pattern as
    // update_thread_personality/update_room_memory — rooms' UPDATE RLS policy
    // is creator-only, so a plain table update would silently fail (or throw)
    // for any non-owner participant. Best-effort — losing this just means
    // the next call falls back to a fresh sandbox.
    if (sandboxId && sandboxId !== roomRow?.sandbox_id) {
      const { error: sandboxPersistErr } = await supabase.rpc("update_room_sandbox", {
        p_room_id: roomId,
        p_sandbox_id: sandboxId,
      });
      if (sandboxPersistErr) {
        console.warn(`/api/chat: failed to persist sandbox_id for room ${roomId}:`, sandboxPersistErr);
      }
    }

    await supabase
      .from("messages")
      .update({ status: "complete" })
      .eq("id", toolCallId)
      .eq("status", "streaming");

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_result",
      content: JSON.stringify(result),
      status: "complete",
    });

    turns.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });

    return "done";
  }

  // Mirrors runToolCall's shape (insert tool_call → run → insert tool_result)
  // but simpler: no ticker/cancel polling, since this returns almost as soon
  // as the stream URL is ready rather than waiting out a whole execution.
  async function runGuiToolCall(call: PendingToolCall): Promise<"done"> {
    const { code, language } = safeParse(call.arguments, { code: "", language: "python" });
    const path = await syncProjectFile(code, language);

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_call",
      content: JSON.stringify({ code, language, path }),
      status: "complete",
    });

    const { streamUrl, error } = await runGuiSession(code, language);

    // Same ToolResultPayload shape the client already parses for run_code,
    // plus one optional field — no new message type, no migration.
    const result = {
      stdout: "",
      stderr: error ?? "",
      exit_code: streamUrl ? 0 : -1,
      streamUrl,
    };

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_result",
      content: JSON.stringify(result),
      status: "complete",
    });

    turns.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });

    return "done";
  }

  // Simplest of the four tool handlers — no project file involved at all
  // (a search isn't code or a file, so unlike every other tool call here
  // there's nothing for syncProjectFile to do), just a real HTTP round trip
  // to Tavily and the result relayed back. Same insert-tool_call/run/
  // insert-tool_result shape every other handler uses, so the transcript
  // renders it the same consistent way.
  async function runWebSearchToolCall(call: PendingToolCall): Promise<"done"> {
    const { query } = safeParse(call.arguments, { query: "" });

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_call",
      // Reuses ToolCallPayload's existing {code, language} shape — language:
      // "web_search" is the signal RoomView's renderer uses to show "Searched
      // the web" instead of a syntax-highlighted code block, `code` doubling
      // as the query text since there's no actual code here.
      content: JSON.stringify({ code: query, language: "web_search" }),
      status: "complete",
    });

    const { results, answer, error } = await runWebSearch(query);

    // Reuses ToolResultPayload's {stdout, stderr, exit_code} shape plus two
    // more optional fields, same trick previewUrl/streamUrl already use.
    const result = {
      stdout: "",
      stderr: error ?? "",
      exit_code: error ? -1 : 0,
      searchResults: results,
      searchAnswer: answer,
    };

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_result",
      content: JSON.stringify(result),
      status: "complete",
    });

    turns.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });

    return "done";
  }

  // Owner/Admin requests write straight to project_files.content — same
  // can_edit_project_directly split every other write in this app already
  // respects. Only a Member's scaffold goes through the pending-batch
  // queue (project_file_changes, one shared batch_id — see
  // 20260827_add_project_file_change_batch.sql), same "never a direct
  // write" test gate components/ProjectAssistant.tsx originally established
  // for a Member's proposals.
  //
  // Shared by runScaffoldToolCall (a real tool call) AND the leaked-JSON
  // fallback below (a model that narrated the same payload as prose
  // instead of actually calling the tool) — one write path regardless of
  // which shape the request arrived in.
  async function scaffoldFiles(
    files: { path: string; content: string }[]
  ): Promise<{ writtenPaths: string[]; proposedPaths: string[] }> {
    const projectId = files.length ? await ensureRoomProjectId() : null;
    const senderRole = await getSenderRole(triggerSenderId);
    const canWriteDirectly = senderRole === "owner" || senderRole === "admin";
    const batchId = randomUUID();
    const writtenPaths: string[] = []; // landed directly — safe to preview
    const proposedPaths: string[] = []; // pending — nothing to preview yet

    if (projectId) {
      const { data: existingRows } = await supabase
        .from("project_files")
        .select("id, path")
        .eq("project_id", projectId);
      const existingIdByPath = new Map((existingRows ?? []).map((r) => [r.path, r.id as string]));

      for (const f of files) {
        // See looksLikeExtensionMismatch's own comment — skips just this
        // one file rather than corrupting whatever's already at its path;
        // the rest of the batch still lands normally.
        if (looksLikeExtensionMismatch(f.path, f.content)) {
          console.warn(
            `/api/chat: refused to write scaffolded file ${f.path} for room ${roomId} — content doesn't match its extension`
          );
          continue;
        }
        if (canWriteDirectly) {
          const { error } = await supabase.from("project_files").upsert(
            {
              project_id: projectId,
              path: f.path,
              content: f.content,
              language: languageFromPath(f.path),
              last_edited_by: null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id,path" }
          );
          if (error) {
            console.warn(`/api/chat: failed to write scaffolded file ${f.path} for room ${roomId}:`, error);
            continue;
          }
          writtenPaths.push(f.path);
          continue;
        }

        let fileId = existingIdByPath.get(f.path);
        if (!fileId) {
          // Empty content until approved — the file shows up in the tree
          // immediately (already-open INSERT policy, same as any other new
          // file) but what it actually CONTAINS is still pending review.
          const { data: inserted, error: insertErr } = await supabase
            .from("project_files")
            .insert({
              project_id: projectId,
              path: f.path,
              content: "",
              language: languageFromPath(f.path),
              last_edited_by: null,
            })
            .select("id")
            .single();
          if (insertErr || !inserted) {
            console.warn(
              `/api/chat: failed to create scaffolded file ${f.path} for room ${roomId}:`,
              insertErr
            );
            continue;
          }
          fileId = inserted.id;
        }

        const { data: insertedChange, error: changeErr } = await supabase
          .from("project_file_changes")
          .insert({
            project_file_id: fileId,
            proposed_by: triggerSenderId,
            proposed_content: f.content,
            source: "ai_assistant",
            batch_id: batchId,
            thread_id: threadId,
          })
          .select("id")
          .single();
        // Fire-and-forget per file — a scaffold's N files each get their
        // own summary, same as N separate single-file proposals would.
        if (insertedChange) backgroundTasks.push(summarizeProjectFileChange(supabase, insertedChange.id));
        if (changeErr) {
          console.warn(
            `/api/chat: failed to propose scaffolded change for ${f.path} in room ${roomId}:`,
            changeErr
          );
          continue;
        }
        proposedPaths.push(f.path);
      }
    }

    return { writtenPaths, proposedPaths };
  }

  function scaffoldOutcomeMessage(writtenPaths: string[], proposedPaths: string[]): string {
    return writtenPaths.length
      ? "Files written — open the Project panel and click Run to see it live."
      : proposedPaths.length
        ? "Proposed as a pending change — once an owner/admin approves it, click Run in the Project panel to see it live."
        : "No files were written.";
  }

  async function runScaffoldToolCall(call: PendingToolCall): Promise<"done"> {
    const { files: rawFiles, framework } = safeParse(call.arguments, {
      files: [] as { path: string; content: string }[],
      framework: "static" as "static" | "next",
    });
    const files = applyScaffoldGuards(
      (Array.isArray(rawFiles) ? rawFiles : []).filter(
        (f): f is { path: string; content: string } =>
          Boolean(f && typeof f.path === "string" && f.path && typeof f.content === "string")
      ),
      framework
    );

    const { writtenPaths, proposedPaths } = await scaffoldFiles(files);

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_call",
      content: JSON.stringify({
        code: "",
        language: framework,
        path: (writtenPaths.length ? writtenPaths : proposedPaths).join(", "),
      }),
      status: "complete",
    });

    // Deliberately does NOT call runWebApp/start a preview itself anymore —
    // confirmed live that it produced its own throwaway sandbox every call
    // (existingSandboxId always null here), completely disconnected from
    // projects.preview_* (which only /api/projects/run-webapp ever writes),
    // so the chat's own "live" link and the Project panel's actual live
    // link could point at two different, unsynced sandboxes — one of them
    // silently dead. One authoritative preview mechanism now: whatever's
    // reachable via the panel's Run button, reading the same persisted
    // project_files content this just wrote/proposed. See "run strictly
    // from its code panel presence" in this session's own fix notes.
    const outcome = scaffoldOutcomeMessage(writtenPaths, proposedPaths);

    const result = {
      stdout: writtenPaths.length || proposedPaths.length ? outcome : "",
      stderr: writtenPaths.length || proposedPaths.length ? "" : outcome,
      exit_code: writtenPaths.length || proposedPaths.length ? 0 : -1,
    };

    await supabase.from("messages").insert({
      room_id: roomId,
      thread_id: threadId,
      sender_type: "agent",
      sender_id: null,
      type: "tool_result",
      content: JSON.stringify(result),
      status: "complete",
    });

    turns.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });

    return "done";
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Set right before the round-cap break below, cleared by every other
        // exit from this loop (a text reply, an interrupt, a stop request) —
        // true only for the one case none of those cover: the model spent
        // every round calling tools (e.g. scaffold_web_app on a large
        // project, re-sending every file's full content each round per its
        // own tool description) and never once wrapped up with a text
        // reply. Before this, that path ended in total silence: each tool
        // call still got its own card (runScaffoldToolCall's own "Files
        // written"/"Proposed" message), but no closing reply ever arrived,
        // which reads exactly like Koopi "just doesn't respond" even though
        // the room's own server log shows a clean 200 with no error at all.
        let ranOutOfRounds = false;
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          // Only from round 1 onward — round 0 is the reply the user just
          // asked for, and stop_requested_at was just cleared for it above.
          if (round > 0 && (await stopRequested())) break;

          const outcome = await runModelTurn(controller);

          // Computed once upfront, checked before anything else a text
          // reply might trigger — a leaked scaffold_web_app payload isn't a
          // normal reply at all, so it must never also fall through to the
          // ordinary isFileUpdate classification below (which would
          // otherwise see the same JSON blob as "a fenced code block" and
          // mishandle it as a garbage single-file save).
          const leaked =
            outcome.kind === "text" && outcome.text ? extractLeakedScaffoldPayload(outcome.text) : null;
          if (leaked && outcome.kind === "text" && outcome.messageId && outcome.text) {
            const { writtenPaths, proposedPaths } = await scaffoldFiles(
              applyScaffoldGuards(leaked.files, leaked.framework)
            );
            const note = scaffoldOutcomeMessage(writtenPaths, proposedPaths);
            // The bare-JSON leak variant is typically prefixed with a stray
            // "@scaffold_web_app" mention (the model imitating a tool-call
            // marker as plain text) immediately before the JSON this just
            // replaced — strip that leftover token too, not just the JSON.
            const cleaned = outcome.text
              .replace(leaked.fullMatch, note)
              .replace(/@scaffold_web_app\b\s*/gi, "")
              .trim();
            await supabase
              .from("messages")
              .update({ content: cleaned || note })
              .eq("id", outcome.messageId);
          } else if (outcome.kind === "text" && outcome.messageId && outcome.text) {
            // Not an unexecuted call (extractLeakedScaffoldPayload above already
            // gets first crack at that) — just the same tag-imitation habit
            // wrapping text that's already fine on its own, most commonly the
            // model echoing a just-completed tool result back as its own
            // wrap-up reply. Clean it before this is shown to anyone, and
            // before the classification pass right below sees it too.
            const cleaned = stripHallucinatedFunctionTags(outcome.text);
            if (cleaned !== outcome.text) {
              await supabase.from("messages").update({ content: cleaned }).eq("id", outcome.messageId);
              outcome.text = cleaned;
            }
          }

          // Every completed text reply gets its own classification pass, independent of
          // whichever round produced it — a tool-use round's follow-up text is just as
          // eligible for either badge as a first-round reply.
          if (outcome.kind === "text" && outcome.messageId && outcome.text && !leaked) {
            // Extracted once upfront (cheap, regex-only) so its line count can
            // decide isFileUpdate deterministically for anything long enough
            // to be unambiguous — classifyFileUpdate (an LLM call) only gets
            // asked to judge the genuinely ambiguous, short-block case.
            const block = extractFileUpdateBlock(outcome.text);
            const isLongBlock = (block?.code.split("\n").length ?? 0) > FILE_UPDATE_LINE_THRESHOLD;

            // isCode means classifyIntent already decided, from the trigger
            // message alone, that this whole request is a coding task — in
            // that case ANY code block in the reply is real project content,
            // full stop, no second-guessing needed. This is the actual fix
            // for the FizzBuzz bug: a short canonical solution (comfortably
            // under FILE_UPDATE_LINE_THRESHOLD) used to fall through to
            // classifyFileUpdate, whose prompt explicitly biases toward
            // calling compact code "just an illustrative snippet" — wrong
            // for a message the router already flagged as a genuine coding
            // request. The length-shortcut and classifyFileUpdate's judgment
            // call are still exactly right for the non-isCode path, where a
            // code block showing up is genuinely more ambiguous (could be a
            // one-off example inside an otherwise conversational reply).
            // isCode is computed once from the trigger text before any model
            // is chosen, so this is identically consistent across
            // Auto/Efficient/Powerful — never dependent on which model
            // happened to answer.
            const [signals, isFileUpdate] = await Promise.all([
              classifySignals(outcome.text),
              isCode
                ? Promise.resolve(Boolean(block))
                : isLongBlock
                  ? Promise.resolve(true)
                  : classifyFileUpdate(triggerText, outcome.text),
            ]);
            const updates: { used_room_memory: boolean; flagged: boolean; content?: string } = {
              used_room_memory: signals.usedRoomMemory,
              flagged: signals.flagged,
            };

            // Moat/defensibility (PDF §4): every genuinely flagged reply —
            // the evaluative stance actually surfacing a conflict or named
            // risk, not just agreeing — becomes a real, queryable row
            // instead of only ever a badge on one message that scrolls
            // away. subject_user_id is whoever's plan/claim this turn was
            // evaluating; decided_by stays null — a 'flagged' row is
            // Koopi's own judgment call, not yet a human decision (unlike
            // change_approved/rejected, logged separately by a DB trigger
            // the moment a human actually resolves one).
            if (signals.flagged) {
              const { error: judgmentErr } = await supabase.from("judgment_calls").insert({
                room_id: roomId,
                thread_id: threadId,
                kind: "flagged",
                subject_user_id: triggerSenderId,
                summary: outcome.text.trim().slice(0, 300),
                message_id: outcome.messageId,
              });
              if (judgmentErr) {
                console.warn(`/api/chat: failed to log flagged judgment call for room ${roomId}:`, judgmentErr);
              }
            }

            // Give the reply's code a persistent home in the room's project
            // instead of (only) living as static text in the transcript.
            // See chooseFileTarget for WHICH file this lands on — no longer
            // a single hardcoded path shared across every unrelated task.
            if (isFileUpdate && block && contextProjectFileId) {
              // Same "propose, never write directly" branch syncProjectFile
              // takes above, for the plain-fenced-block path instead of a
              // tool call — a "Discuss this file" thread never lets Koopi
              // choose a target file OR write to it directly, regardless of
              // which of the two ways it happens to produce code this turn.
              const { data: file } = await supabase
                .from("project_files")
                .select("path")
                .eq("id", contextProjectFileId)
                .maybeSingle();
              const { data: insertedChange, error } = file
                ? await supabase
                    .from("project_file_changes")
                    .insert({
                      project_file_id: contextProjectFileId,
                      proposed_by: triggerSenderId,
                      proposed_content: block.code,
                      source: "ai_assistant",
                      thread_id: threadId,
                    })
                    .select("id")
                    .single()
                : { data: null, error: new Error("context file not found") };
              if (insertedChange) backgroundTasks.push(summarizeProjectFileChange(supabase, insertedChange.id));
              if (!error && file) {
                updates.content = outcome.text.replace(
                  block.fullMatch,
                  `📄 Proposed a change to ${file.path} — pending review in Changes →`
                );
              } else {
                console.warn(
                  `/api/chat: failed to propose a change for context file ${contextProjectFileId} in room ${roomId}:`,
                  error
                );
              }
            } else if (isFileUpdate && block) {
              const projectId = await ensureRoomProjectId();
              let targetPath: string | null = null;
              let proposed = false;
              let fileErr: unknown = projectId ? null : new Error("no project for room");
              if (projectId) {
                const { data: fileRows } = await supabase
                  .from("project_files")
                  .select("id, path, content")
                  .eq("project_id", projectId);
                const existingFiles = (fileRows ?? []).filter((f) => !isFolderMarker(f.path));
                // Same in-this-exact-request-continuation priority
                // syncProjectFile's own comment explains — an earlier round
                // of this same turn (a run_code tool call, say) may have
                // already written a file that `history` (fetched before any
                // of this turn's rounds ran) has no way to know about yet.
                const candidate: FileContinuationCandidate | null = lastWrittenPathThisRequest
                  ? {
                      path: lastWrittenPathThisRequest,
                      content: fileRows?.find((f) => f.path === lastWrittenPathThisRequest)?.content ?? "",
                      reason: "this exact request already wrote this file a moment ago",
                      forceExisting: true,
                    }
                  : (explicitOpenCandidate(fileRows ?? []) ?? (await resolveContinuationHint(projectId)));
                const target = await chooseFileTarget(triggerText, block.language, candidate, existingFiles);
                targetPath = target.path;

                // Same Owner/Admin-write-directly split scaffoldFiles() above
                // already applies to a scaffold_web_app call — this plain
                // fenced-code-block path (an ordinary chat reply, not a tool
                // call) was the one project_files write left that never got
                // it, so a Member's edit to an EXISTING file (globals.css,
                // page.tsx, ... — exactly what "add Tailwind styling" touches)
                // silently failed RLS (UPDATE is Owner/Admin-only, see
                // 20260817_add_room_roles_and_approval.sql) with nothing ever
                // landing in the Changes queue for review. A NEW path always
                // worked (INSERT stays open to everyone), which is why this
                // only ever broke edits to files that already existed.
                const senderRole = await getSenderRole(triggerSenderId);
                const canWriteDirectly = senderRole === "owner" || senderRole === "admin";

                // block.language (the fenced block's own info-string, or
                // "python" if untagged) is never trusted for the persisted
                // column, same reasoning syncProjectFile's own comment gives
                // — always derived from the chosen path instead.
                // See looksLikeExtensionMismatch's own comment — this is the
                // actual site the confirmed-live bug happened at: a reply
                // that wrote out two labeled files (index.html, then
                // style.css) only ever keeps the larger fenced block, and
                // that CSS landed under the index.html path with nothing
                // catching the mismatch before it overwrote a working file.
                if (looksLikeExtensionMismatch(target.path, block.code)) {
                  fileErr = new Error(`content doesn't match ${target.path}'s extension`);
                } else if (canWriteDirectly) {
                  const { error } = await supabase.from("project_files").upsert(
                    {
                      project_id: projectId,
                      path: target.path,
                      content: block.code,
                      language: languageFromPath(target.path),
                      // null = Koopi-authored — the agent has no profiles row, same
                      // convention as sender_id: null on agent messages.
                      last_edited_by: null,
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: "project_id,path" }
                  );
                  fileErr = error;
                } else {
                  let fileId = fileRows?.find((f) => f.path === target.path)?.id;
                  if (!fileId) {
                    // Empty content until approved — same as scaffoldFiles'
                    // own new-file case: shows up in the tree immediately
                    // (INSERT stays open to any participant) but what it
                    // contains is still pending review.
                    const { data: inserted, error: insertErr } = await supabase
                      .from("project_files")
                      .insert({
                        project_id: projectId,
                        path: target.path,
                        content: "",
                        language: languageFromPath(target.path),
                        last_edited_by: null,
                      })
                      .select("id")
                      .single();
                    fileId = inserted?.id;
                    fileErr = insertErr;
                  }
                  if (fileId) {
                    const { data: insertedChange, error: changeErr } = await supabase
                      .from("project_file_changes")
                      .insert({
                        project_file_id: fileId,
                        proposed_by: triggerSenderId,
                        proposed_content: block.code,
                        source: "ai_assistant",
                        thread_id: threadId,
                      })
                      .select("id")
                      .single();
                    if (insertedChange) backgroundTasks.push(summarizeProjectFileChange(supabase, insertedChange.id));
                    fileErr = changeErr;
                    proposed = !changeErr;
                  }
                }
              }
              if (!fileErr) {
                // A proposal hasn't actually landed in project_files.content
                // yet (still pending review) — same reason syncProjectFile's
                // own contextProjectFileId branch never sets this either, so
                // a later block in this same turn doesn't treat unreviewed
                // content as the "current" state to continue from.
                if (!proposed) lastWrittenPathThisRequest = targetPath;
                // Replace just the fenced block with a short reference, preserving
                // any surrounding prose — not a duplicate copy of the file in every
                // message once it already lives in the project. Names the actual
                // file now that there's more than one possible target.
                updates.content = outcome.text.replace(
                  block.fullMatch,
                  proposed
                    ? `📄 Proposed a change to ${targetPath} — pending review in Changes →`
                    : `📄 Updated ${targetPath} — see it on the right →`
                );
              } else {
                console.warn(
                  `/api/chat: failed to write/propose project_files for room ${roomId}:`,
                  fileErr
                );
              }
            }

            await supabase.from("messages").update(updates).eq("id", outcome.messageId);
          }

          if (outcome.kind !== "tool_use") break;
          if (round === MAX_TOOL_ROUNDS) {
            ranOutOfRounds = true;
            break;
          }

          let stoppedEarly = false;
          for (const call of outcome.calls) {
            const toolOutcome =
              call.name === "open_gui_session"
                ? await runGuiToolCall(call)
                : call.name === "scaffold_web_app"
                  ? await runScaffoldToolCall(call)
                  : call.name === "web_search"
                    ? await runWebSearchToolCall(call)
                    : await runToolCall(call);
            if (toolOutcome === "interrupted") {
              stoppedEarly = true;
              break;
            }
          }
          if (stoppedEarly) break;
        }

        // Whatever tool calls happened along the way already got their own
        // cards (a scaffold's "Files written"/"Proposed" message, a run's
        // output, ...) — this is specifically the closing reply that never
        // came, so the person who asked isn't left staring at silence after
        // everything else in the thread went quiet.
        if (ranOutOfRounds) {
          await supabase.from("messages").insert({
            room_id: roomId,
            thread_id: threadId,
            sender_type: "agent",
            sender_id: null,
            type: "text",
            content:
              `@${triggerUsername} That took more steps than I could finish in one go — ` +
              `check the Project panel for what landed so far, and ask me to continue if ` +
              `anything's still missing.`,
            status: "complete",
          });
        }
      } catch (err) {
        console.error(`/api/chat: unhandled error for trigger ${triggerMessageId}:`, err);
      } finally {
        // Drained here, not left as bare fire-and-forget promises — see
        // backgroundTasks' own comment. allSettled (not all) so one
        // summary call failing/rejecting never throws out of this finally
        // or blocks the others from finishing.
        await Promise.allSettled(backgroundTasks);
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
