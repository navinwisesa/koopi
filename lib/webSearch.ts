export type WebSearchResult = { title: string; url: string; snippet: string };
export type WebSearchOutcome = {
  results: WebSearchResult[];
  answer: string | null;
  error: string | null;
};

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Real web search for Koopi's web_search tool, backed by Tavily
 * (https://tavily.com) — chosen specifically because it's built for LLM
 * agent tool use: results come back as clean {title, url, content} entries
 * plus an optional short synthesized answer, no HTML scraping/cleanup
 * needed on this end. "basic" search depth (not "advanced") deliberately —
 * faster and cheaper, and plenty for the "what's the current X" / "verify
 * this fact" queries this tool exists for; nothing here needs Tavily's
 * deeper, slower crawl.
 */
export async function runWebSearch(query: string): Promise<WebSearchOutcome> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { results: [], answer: null, error: "Web search isn't configured (no TAVILY_API_KEY set)." };
  }
  if (!query.trim()) {
    return { results: [], answer: null, error: "Empty search query." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_answer: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        results: [],
        answer: null,
        error: `Search failed (${res.status}): ${body.slice(0, 300) || res.statusText}`,
      };
    }

    const data = (await res.json()) as {
      answer?: string | null;
      results?: { title?: string; url?: string; content?: string }[];
    };

    const results: WebSearchResult[] = (data.results ?? [])
      .filter((r): r is { title?: string; url: string; content?: string } => Boolean(r.url))
      .map((r) => ({
        title: r.title?.trim() || r.url,
        url: r.url,
        // Trimmed — this goes straight into the model's context on the next
        // turn; Tavily's `content` field can run long and there's no need
        // to spend tokens on more than a snippet per result.
        snippet: (r.content ?? "").trim().slice(0, 500),
      }));

    return { results, answer: data.answer?.trim() || null, error: null };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      results: [],
      answer: null,
      error: timedOut ? "Search timed out." : err instanceof Error ? err.message : "Search failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
