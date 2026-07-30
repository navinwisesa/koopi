"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import UpdatePasswordForm from "@/components/UpdatePasswordForm";

type Status = "checking" | "ready" | "expired";

export default function UpdatePasswordGate() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // The recovery link lands here with the session in a URL hash fragment
    // (`#access_token=...&type=recovery`) — GoTrue's hosted /verify redirect
    // still uses this legacy implicit-grant format. This client is configured
    // for the PKCE flow (the default for @supabase/ssr), which only watches
    // for a `?code=` query param, so it never auto-detects a hash fragment —
    // `getSession()` comes back empty and no PASSWORD_RECOVERY event fires.
    // Parsing the fragment and calling setSession() directly sidesteps that.
    async function verify() {
      const hash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const params = new URLSearchParams(hash);
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");

      if (!access_token || !refresh_token) {
        if (!cancelled) setStatus("expired");
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token,
        refresh_token,
      });

      if (cancelled) return;

      if (error) {
        setStatus("expired");
        return;
      }

      // Drop the tokens from the visible URL/history now that they're used.
      window.history.replaceState(null, "", window.location.pathname);
      setStatus("ready");
    }

    void verify();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    return (
      <p className="font-sans text-sm text-muted">Verifying your link…</p>
    );
  }

  if (status === "expired") {
    return (
      <>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          Link expired
        </h1>
        <p className="mt-1 text-sm text-muted">
          That reset link has expired or was already used.
        </p>
        <Link
          href="/auth"
          className="mt-6 inline-block w-full rounded-md bg-accent px-6 py-3 text-center font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Request a new one
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="font-display text-2xl font-bold tracking-tight">
        Set a new password
      </h1>
      <p className="mt-1 text-sm text-muted">
        Choose something you haven&apos;t used before.
      </p>
      <UpdatePasswordForm />
    </>
  );
}
