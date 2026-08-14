import Groq from "groq-sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SandboxRun, type RunResult } from "@/lib/sandbox";
import { runGuiSession } from "@/lib/desktopSandbox";
import { classifyIntent } from "@/lib/intentClassifier";
import { extractPdf } from "@/lib/pdfExtract";
import type { Personality } from "@/components/PersonalitySelector";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// No single primary provider anymore — Cerebras is gone (not worth the extra
// hop once free-tier Groq/OpenRouter models cover the same ground). Routing
// is a straight three-way split:
//   code request        → cohere/north-mini-code:free on OpenRouter (Groq has
//                          no comparable free code model, so there's no
//                          primary leg to try before this one)
//   non-code, Powerful   → Groq llama-3.3-70b-versatile, falling back to
//                          nvidia/nemotron-3-super-120b-a12b:free on OpenRouter
//   non-code, Efficient  → Groq llama-3.1-8b-instant, falling back to
//                          openai/gpt-oss-20b:free on OpenRouter
// "code" is decided purely from the message content (see isCode below) and
// wins regardless of the Efficient/Powerful tier — once it's code, the tier
// selector stops mattering.
const OPENROUTER_CODE_MODEL = "cohere/north-mini-code:free";
const GROQ_MODEL: Record<"chat" | "build", string> = {
  chat: "llama-3.1-8b-instant",
  build: "llama-3.3-70b-versatile",
};
const OPENROUTER_MODEL: Record<"chat" | "build", string> = {
  chat: "openai/gpt-oss-20b:free",
  build: "nvidia/nemotron-3-super-120b-a12b:free",
};
// Multimodal input (Phase 1 of the debugging-tools build): confirmed via
// audit that NONE of the three models above accept image input — Groq's
// llama-3.1-8b-instant/llama-3.3-70b-versatile are text-only, as is
// cohere/north-mini-code:free and the openai/gpt-oss-20b:free fallback.
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

Before reaching for a native GUI toolkit at all, consider whether what's being
asked for can just be a webpage instead — a single self-contained HTML file
with inline <style> and <script>, no build step, no dependencies. Default to
that for anything that's fundamentally a UI (a calculator, a form, a simple
game, a small dashboard, etc.): write it as one HTML file the normal way (a
fenced code block — it's saved to the project automatically, same as any
other file). Project mode doesn't render a live preview of it, so tell them
to open that file in their own browser once it's saved — never tell them to
save or copy the code themselves, it's already been saved for them by the
time you're describing it. That's instant, costs no infrastructure, and
needs nothing from you beyond the code. Only reach for a native toolkit
(Tkinter, PyQt, etc.) — and therefore open_gui_session, since that's the
only way anyone can actually SEE a native window — when the person
explicitly asks for a native/desktop app, or the task genuinely needs
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

You're given the user's current request, the code's language, the full list of paths already in
the project, and — if one applies — a single candidate file plus a reason it was suggested.

Decide "existing" (the code belongs in the candidate file) vs "new" (it's a distinct, unrelated
task that deserves its own file). Favor "existing" whenever the request is plausibly a
continuation of the candidate — modifying, fixing, or adding to it ("add error handling to this",
"make this support email login", "fix the bug above"), or a retry/rephrasing of the same ask that
produced it in the first place, even if the wording doesn't match verbatim. Only answer "new" when
the request is genuinely about a different task the candidate doesn't already cover. If the
candidate's reason says its last run just failed with an error, weight that even more heavily
toward "existing" — an error followed by essentially the same ask again is almost always a retry,
not a new task. If no candidate is given at all, always answer "new" — there's nothing to
continue.

Whenever target is "new" (or no candidate is given), also suggest a short, descriptive filename
for the code — lowercase, underscores instead of spaces, a sensible extension for the language
(e.g. "palindrome_checker.py", "median_calculator.py"). Base it on what the code actually DOES,
not the literal wording of the request, and avoid picking something that basically duplicates a
name already in the existing-paths list.

Respond with ONLY compact JSON: {"target": "existing"|"new", "filename": "short_name.ext"}
(omit filename, or use null, when target is "existing")`;

function extensionFor(language: string): string {
  switch (language.trim().toLowerCase()) {
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

  // maxRetries: 0 — the SDK's default retry-with-backoff would silently eat
  // 30+ seconds retrying a rate-limited call before our own fallback chain
  // ever gets a chance to run. A 429 should surface immediately.
  const groq = groqKey ? new Groq({ apiKey: groqKey, maxRetries: 0 }) : null;
  const openrouter = openrouterKey
    ? new OpenAI({ apiKey: openrouterKey, baseURL: "https://openrouter.ai/api/v1" })
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
  const { data: attachmentRows } = await supabase
    .from("message_attachments")
    .select("storage_path, filename, mime_type, kind")
    .eq("message_id", triggerMessageId);

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

    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL.chat,
        max_completion_tokens: 400,
        messages: [
          { role: "system", content: MEMORY_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Existing summary: ${existingSummary ?? "(none yet)"}\n\n` +
              `New activity since then:\n${formatted}\n\nProduce the updated summary.`,
          },
        ],
      });
      const updated = completion.choices[0]?.message?.content?.trim();
      if (!updated) return existingSummary;

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
  async function getRoomPersonality(): Promise<Personality> {
    const { data: room } = await supabase
      .from("rooms")
      .select("personality")
      .eq("id", roomId)
      .maybeSingle();
    return (room?.personality as Personality | null) ?? "default";
  }

  const [roomMemory, personality] = await Promise.all([
    getRoomMemory(),
    getRoomPersonality(),
  ]);

  const effectiveSystemPrompt =
    (roomMemory
      ? `${SYSTEM_PROMPT}\n\nRoom memory (prior activity in this room, across other threads):\n${roomMemory}`
      : SYSTEM_PROMPT) + personalityBlock(personality);

  const isRateLimited = (err: unknown) =>
    err instanceof Groq.RateLimitError || err instanceof OpenAI.RateLimitError;

  // A genuine API failure (rate limit, network blip, etc.) must never just
  // vanish — the person who tagged Koopi should always see *something*
  // rather than silence that looks like they were ignored.
  async function postFailureNotice(err: unknown) {
    const reason = isRateLimited(err)
      ? "we've hit today's usage limit for the model — try again a bit later."
      : "I hit an error trying to respond — try asking again.";
    console.error(`/api/chat: model call failed for trigger ${triggerMessageId}:`, err);
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
        max_completion_tokens: 40,
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
        max_completion_tokens: 20,
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
  // fallback from resolveContinuationHint below. `existingPaths` is fetched
  // fresh by each call site right before calling this, so a second
  // file-worthy reply in the same turn (tool call + a final text block, say)
  // sees whatever the first one just created and won't collide with it.
  async function chooseFileTarget(
    triggerText: string,
    language: string,
    candidate: FileContinuationCandidate | null,
    existingPaths: string[]
  ): Promise<{ path: string; isNewFile: boolean }> {
    const fallbackToNewFile = () => ({
      path: uniquePath(slugFilename(triggerText, language), existingPaths),
      isNewFile: true,
    });
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

    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL.chat,
        max_completion_tokens: 60,
        messages: [
          { role: "system", content: FILE_TARGET_PROMPT },
          {
            role: "user",
            content: candidate
              ? `User's request:\n${triggerText}\n\nCandidate file: ${candidate.path}\n` +
                `Why it was suggested: ${candidate.reason}\n` +
                `--- its current content (may be empty or unrelated) ---\n${candidate.content.slice(0, 800)}\n\n` +
                `Other existing paths in the project: ${existingPaths.filter((p) => p !== candidate.path).join(", ") || "(none)"}\n\n` +
                `Generated code language: ${language}`
              : `User's request:\n${triggerText}\n\nNo candidate file — nothing open, nothing recent in this thread.\n\n` +
                `Existing paths in the project: ${existingPaths.join(", ") || "(none)"}\n\nGenerated code language: ${language}`,
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      const parsed = safeParse<{ target?: string; filename?: string }>(raw, {});
      if (candidate && parsed.target === "existing") {
        return { path: candidate.path, isNewFile: false };
      }
      const suggested = parsed.filename?.trim();
      // Reject anything that doesn't look like a plausible bare filename
      // (no path separators, no wild characters) rather than trust the
      // model's output verbatim for something that becomes a DB row's key.
      const name = suggested && /^[\w.-]{1,80}$/.test(suggested) ? suggested : slugFilename(triggerText, language);
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
      if (!path) continue;

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
    async function tryOpenrouter(model: string): Promise<{ stream: ChatStream } | { error: unknown }> {
      if (!openrouter) return { error: new Error("OPENROUTER_API_KEY is not set") };
      try {
        return {
          stream: (await openrouter.chat.completions.create({
            model,
            max_completion_tokens: 4096,
            stream: true,
            tools: [RUN_CODE_TOOL, OPEN_GUI_TOOL] as unknown as OpenAI.Chat.ChatCompletionTool[],
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
      const result = await tryOpenrouter(VISION_MODEL);
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
      const result = await tryOpenrouter(OPENROUTER_CODE_MODEL);
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
          max_completion_tokens: 4096,
          stream: true,
          tools: [RUN_CODE_TOOL, OPEN_GUI_TOOL],
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
        const result = await tryOpenrouter(OPENROUTER_MODEL[tier]);
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
      const result = await tryOpenrouter(OPENROUTER_MODEL[tier]);
      if ("error" in result) {
        await postFailureNotice(result.error);
        return { kind: "text", messageId: null, text: "" };
      }
      stream = result.stream;
      provider = "openrouter";
    }

    const ticker = setInterval(async () => {
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
      // Aborting the stream throws — that's the expected shape of a Stop-button
      // interrupt (`interrupted` is already true by the time it happens). Any
      // other error here is a genuine failure (network blip, provider outage)
      // that must not be treated the same way.
      if (!interrupted) streamError = err;
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

    return { kind: "text", messageId: textMessageId, text };
  }

  // Room's Project mode replaced the old per-thread thread_files panel — a
  // single project per room (see 20260815_add_projects.sql), so Koopi's
  // auto-saved code now needs a project_id to write into rather than just a
  // thread_id. Lazily creates the room's project exactly like RoomView's own
  // ensureProject() does client-side; the projects.room_id unique constraint
  // makes a race between the two harmless (loser's insert 23505s, re-selects).
  let cachedProjectId: string | null = null;
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
    const projectId = await ensureRoomProjectId();
    if (!projectId) return null;

    const { data: fileRows } = await supabase
      .from("project_files")
      .select("path, content")
      .eq("project_id", projectId);
    const existingPaths = (fileRows ?? []).map((f) => f.path);
    const candidate = explicitOpenCandidate(fileRows ?? []) ?? (await resolveContinuationHint(projectId));

    const { path } = await chooseFileTarget(triggerText, language, candidate, existingPaths);

    const { error } = await supabase.from("project_files").upsert(
      {
        project_id: projectId,
        path,
        content: code,
        language,
        last_edited_by: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,path" }
    );
    if (error) {
      console.warn(`/api/chat: failed to upsert project_files for room ${roomId}:`, error);
      return null;
    }
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
    // update_room_personality/update_room_memory — rooms' UPDATE RLS policy
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

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          // Only from round 1 onward — round 0 is the reply the user just
          // asked for, and stop_requested_at was just cleared for it above.
          if (round > 0 && (await stopRequested())) break;

          const outcome = await runModelTurn(controller);

          // Every completed text reply gets its own classification pass, independent of
          // whichever round produced it — a tool-use round's follow-up text is just as
          // eligible for either badge as a first-round reply.
          if (outcome.kind === "text" && outcome.messageId && outcome.text) {
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

            // Give the reply's code a persistent home in the room's project
            // instead of (only) living as static text in the transcript.
            // See chooseFileTarget for WHICH file this lands on — no longer
            // a single hardcoded path shared across every unrelated task.
            if (isFileUpdate && block) {
              const projectId = await ensureRoomProjectId();
              let targetPath: string | null = null;
              let fileErr: unknown = projectId ? null : new Error("no project for room");
              if (projectId) {
                const { data: fileRows } = await supabase
                  .from("project_files")
                  .select("path, content")
                  .eq("project_id", projectId);
                const existingPaths = (fileRows ?? []).map((f) => f.path);
                const candidate =
                  explicitOpenCandidate(fileRows ?? []) ?? (await resolveContinuationHint(projectId));
                const target = await chooseFileTarget(triggerText, block.language, candidate, existingPaths);
                targetPath = target.path;

                const { error } = await supabase.from("project_files").upsert(
                  {
                    project_id: projectId,
                    path: target.path,
                    content: block.code,
                    language: block.language,
                    // null = Koopi-authored — the agent has no profiles row, same
                    // convention as sender_id: null on agent messages.
                    last_edited_by: null,
                    updated_at: new Date().toISOString(),
                  },
                  { onConflict: "project_id,path" }
                );
                fileErr = error;
              }
              if (!fileErr) {
                // Replace just the fenced block with a short reference, preserving
                // any surrounding prose — not a duplicate copy of the file in every
                // message once it already lives in the project. Names the actual
                // file now that there's more than one possible target.
                updates.content = outcome.text.replace(
                  block.fullMatch,
                  `📄 Updated ${targetPath} — see it on the right →`
                );
              } else {
                console.warn(
                  `/api/chat: failed to upsert project_files for room ${roomId}:`,
                  fileErr
                );
              }
            }

            await supabase.from("messages").update(updates).eq("id", outcome.messageId);
          }

          if (outcome.kind !== "tool_use") break;
          if (round === MAX_TOOL_ROUNDS) break;

          let stoppedEarly = false;
          for (const call of outcome.calls) {
            const toolOutcome =
              call.name === "open_gui_session" ? await runGuiToolCall(call) : await runToolCall(call);
            if (toolOutcome === "interrupted") {
              stoppedEarly = true;
              break;
            }
          }
          if (stoppedEarly) break;
        }
      } catch (err) {
        console.error(`/api/chat: unhandled error for trigger ${triggerMessageId}:`, err);
      } finally {
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
