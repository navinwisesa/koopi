import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Stable per-project preview URL — `{projectId}.preview.<this app's own
// domain>` always rewrites to app/api/preview-proxy, which forwards to
// whichever sandbox is actually live right now (see that route and
// lib/webAppSandbox.ts's resolvePreviewSandboxHost). project id is a
// Postgres uuid, so the subdomain is exactly that shape — nothing else on
// this app ever mints a subdomain, so a strict match here can't collide
// with a real page route.
const PREVIEW_HOST_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.preview\./i;

// Previously encoded as the matcher's own exclusion regex (see config
// below) — moved in here because the matcher can't see the Host header, so
// it had to widen to admit preview-subdomain asset requests too (a
// sandboxed Next.js demo's own /_next/static/... is a real, different
// thing from Koopi's own bundle, and must reach the proxy, not 404 here).
// This is that same exclusion, just applied AFTER the preview check
// instead of before middleware ever runs, so it only ever skips Koopi's
// own asset requests, never a preview one.
const STATIC_ASSET_RE = /^\/(?:_next\/static\/|_next\/image\b|favicon\.ico$|.*\.(?:svg|png|jpg|jpeg|gif|webp)$)/;

export async function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const previewMatch = host.match(PREVIEW_HOST_RE);
  if (previewMatch) {
    const rewritten = request.nextUrl.clone();
    // A bare "/" contributes nothing here — appending it produced
    // "/api/preview-proxy/{id}/" (trailing slash), which the [[...path]]
    // optional catch-all doesn't resolve to an empty path the way the
    // bare, no-slash route does; confirmed live (curl against this exact
    // rewrite) that the trailing-slash form 404'd while the no-slash form
    // matched. Any deeper path ("/foo/bar") is unaffected either way.
    const suffix = request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname;
    rewritten.pathname = `/api/preview-proxy/${previewMatch[1]}${suffix}`;
    return NextResponse.rewrite(rewritten);
  }

  if (STATIC_ASSET_RE.test(request.nextUrl.pathname)) {
    return NextResponse.next({ request });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Before Supabase is configured, pass every request straight through.
  if (!url || !anonKey) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refreshes the auth token and writes it back onto the response cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Signed-out users can't reach the dashboard.
  if (!user && path.startsWith("/dashboard")) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth";
    return NextResponse.redirect(url);
  }

  // Signed-in users skip the auth form. Exact match so /auth/callback still runs.
  if (user && path === "/auth") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

// Was scoped to exclude Koopi's own static-asset paths (still true for
// Koopi's own domain — see STATIC_ASSET_RE above, now applied inside the
// function instead). Widened to match everything because the matcher runs
// before the function ever sees the request and can't inspect the Host
// header — a preview-subdomain request to something that LOOKS like a
// static-asset path (a sandboxed Next.js demo's own /_next/static/...) is
// real content that must reach the proxy, not Koopi's own excluded-path
// shortcut.
export const config = {
  matcher: ["/(.*)"],
};
