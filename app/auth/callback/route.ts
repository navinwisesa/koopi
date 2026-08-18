import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Confirmed live (CWE-601 open redirect): the raw `next` param used to get
// concatenated straight into a redirect URL as `${origin}${next}`. That
// string-concat looked safe (an attacker-supplied absolute URL like
// `next=https://evil.com` produces the malformed, non-navigable string
// "https://koopi.apphttps://evil.com" rather than actually redirecting
// anywhere) — but `next=@evil.com/phish` produces
// "https://koopi.app@evil.com/phish", which IS a valid URL, just not the
// one it looks like: `koopi.app` becomes URL userinfo, `evil.com` becomes
// the actual host. Confirmed against `new URL()` directly before writing
// this fix. The result: right after a legitimate Supabase OAuth login
// succeeds, an attacker-crafted link could bounce the now-authenticated
// user's browser straight to a phishing page. Restricting `next` to a
// same-origin relative path (starts with exactly one "/", never "//" —
// that's protocol-relative and escapes the origin just as completely)
// closes this regardless of which URL-parsing quirk might otherwise be
// exploitable, rather than trying to blocklist specific patterns like `@`.
function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // In prod behind a proxy, honour the forwarded host so the redirect isn't localhost.
      const forwardedHost = request.headers.get("x-forwarded-host");
      const isLocalEnv = process.env.NODE_ENV === "development";

      if (isLocalEnv || !forwardedHost) {
        return NextResponse.redirect(`${origin}${next}`);
      }
      return NextResponse.redirect(`https://${forwardedHost}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth?error=oauth_failed`);
}
