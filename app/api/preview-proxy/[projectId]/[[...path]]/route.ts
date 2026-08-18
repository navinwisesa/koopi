import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolvePreviewSandboxHost } from "@/lib/webAppSandbox";

// Reached only via middleware.ts's rewrite from a `{projectId}.preview.
// <domain>` request — never a URL anyone types directly. Node runtime
// (not Edge): needs a real streaming fetch with request-body passthrough
// (POST/PUT et al., for whatever the sandboxed app itself does server-
// side), which Edge's fetch doesn't support in the same way.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A single proxied request should behave like a normal page/asset load,
// not need this route's own long-running budget — the underlying fetch to
// the sandbox has no timeout of its own beyond the platform default, which
// is already generous enough for a dev-server response.
export const maxDuration = 60;

// Headers that describe THIS hop (Koopi -> sandbox) rather than the
// content itself — forwarding them verbatim would either be meaningless
// on the new hop (`host`) or actively wrong once `fetch` renegotiates its
// own transport (`content-length`/`accept-encoding`, since we never touch
// or re-encode the body ourselves, but Node's fetch may pick a different
// encoding than the original client asked for).
const STRIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding"]);
// Same idea in the other direction — these describe how upstream (the
// sandbox's own dev/static server) framed ITS response to us, not how
// NextResponse should frame what we send back out; forwarding them
// verbatim can produce a response whose headers and actual body framing
// disagree (e.g. a stale content-length after body streaming).
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

function notRunningResponse(detail?: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Preview not running</title></head>` +
      `<body style="font-family:system-ui,sans-serif;padding:4rem 2rem;text-align:center;color:#555">` +
      `<h1 style="color:#111;font-size:1.25rem">This preview isn't running right now</h1>` +
      `<p>Ask whoever's working on this project to click Run in the Project panel.</p>` +
      (detail ? `<p style="margin-top:2rem;font-size:12px;color:#999">${escapeHtml(detail)}</p>` : "") +
      `</body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function proxy(req: NextRequest, projectId: string, path: string[] | undefined): Promise<NextResponse> {
  // Bypasses RLS by design — see 20260902_add_preview_proxy_target.sql's
  // own comment: this must work for a visitor with no Koopi session at
  // all, same as the raw sandbox link it replaces already did.
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("get_preview_target", { p_project_id: projectId })
    .maybeSingle<{ sandbox_id: string | null; status: string | null }>();

  if (error || !data) return notRunningResponse();
  if (data.status !== "running" || !data.sandbox_id) return notRunningResponse();

  const resolved = await resolvePreviewSandboxHost(data.sandbox_id);
  if (resolved.host === null) return notRunningResponse(resolved.reason);

  const targetPath = (path ?? []).map(encodeURIComponent).join("/");
  const targetUrl = `https://${resolved.host}/${targetPath}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Required by undici whenever a fetch body is a stream rather than a
    // buffered value — not yet reflected in the DOM RequestInit type.
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    return notRunningResponse(err instanceof Error ? err.message : "Could not reach the sandbox.");
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
}

type RouteContext = { params: Promise<{ projectId: string; path?: string[] }> };

async function handle(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { projectId, path } = await ctx.params;
  return proxy(req, projectId, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
