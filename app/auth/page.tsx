"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import BackgroundGrid from "@/components/BackgroundGrid";
import { GoogleIcon, GitHubIcon } from "@/components/BrandIcons";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { describeAuthError } from "@/lib/authErrors";

type Mode = "signup" | "login" | "forgot";
type Pending = "email" | "google" | "github" | null;

const inputClass =
  "w-full rounded-md border border-border bg-background px-4 py-3 font-display text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";

const oauthButtonClass =
  "flex w-full items-center justify-center gap-2.5 rounded-md border border-border bg-background px-4 py-3 font-display text-sm font-medium text-foreground transition-colors hover:border-muted disabled:opacity-60";

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>("signup");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "oauth_failed") {
      setError("Could not complete that sign-in. Please try again.");
    }
    if (params.get("error") === "reset_expired") {
      setMode("login");
      setError(
        "That reset link has expired or was already used — request a new one below."
      );
    }
  }, []);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setNotice(null);
  }

  function guardConfigured() {
    if (isSupabaseConfigured) return true;
    setError(
      "Supabase isn't configured yet — add your project keys to .env.local."
    );
    return false;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!guardConfigured()) return;

    setPending("email");

    try {
      const supabase = createClient();

      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { username: username.trim() },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (error) throw error;

        // No session means Supabase is waiting on email confirmation.
        if (data.session) {
          window.location.assign("/dashboard");
          return;
        }
        setNotice("Check your email to confirm your account.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        window.location.assign("/dashboard");
        return;
      }
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setPending(null);
    }
  }

  async function handleForgotPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!guardConfigured()) return;

    setPending("email");
    try {
      // Recovery links use Supabase's implicit hash-fragment grant, which
      // only ever exists client-side — routing it through the server-side
      // /auth/callback (built for the PKCE `code` param OAuth uses) would
      // silently drop the token before this page ever saw it.
      const { error } = await createClient().auth.resetPasswordForEmail(
        email.trim(),
        {
          redirectTo: `${window.location.origin}/auth/update-password`,
        }
      );
      if (error) throw error;
      setNotice("Check your email for a link to reset your password.");
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setPending(null);
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    setError(null);
    setNotice(null);
    if (!guardConfigured()) return;

    setPending(provider);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      // On success the browser navigates away to the provider.
    } catch (err) {
      setError(describeAuthError(err));
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="relative flex min-h-screen items-start justify-center overflow-hidden px-6 pb-16 pt-16 sm:pt-20">
      <BackgroundGrid />

      <Link
        href="/"
        className="absolute left-6 top-6 flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        Back
      </Link>

      <div className="w-full max-w-sm">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-display text-sm font-bold text-accent-foreground">
            K
          </span>
          <span className="translate-y-[2px] font-display text-lg font-bold tracking-tight">
            Koopi
          </span>
        </Link>

        <div className="rounded-xl border border-border bg-surface p-8">
          {mode !== "forgot" && (
            <div className="relative mb-6 grid grid-cols-2 rounded-full border border-border bg-background p-1 font-display text-sm font-medium">
              <span
                aria-hidden="true"
                className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-accent transition-transform duration-200 ease-out"
                style={{
                  transform:
                    mode === "login" ? "translateX(100%)" : "translateX(0)",
                }}
              />
              <button
                type="button"
                onClick={() => switchMode("signup")}
                aria-pressed={mode === "signup"}
                className={`relative z-10 rounded-full py-2 transition-colors ${
                  mode === "signup" ? "text-accent-foreground" : "text-muted"
                }`}
              >
                Sign up
              </button>
              <button
                type="button"
                onClick={() => switchMode("login")}
                aria-pressed={mode === "login"}
                className={`relative z-10 rounded-full py-2 transition-colors ${
                  mode === "login" ? "text-accent-foreground" : "text-muted"
                }`}
              >
                Log in
              </button>
            </div>
          )}

          <h1 className="font-display text-2xl font-bold tracking-tight">
            {mode === "signup"
              ? "Create your account"
              : mode === "login"
                ? "Welcome back"
                : "Reset your password"}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {mode === "signup"
              ? "Spin up a squad session in seconds."
              : mode === "login"
                ? "Log in to jump back into your squad."
                : "We'll email you a link to set a new one."}
          </p>

          {error && (
            <p className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </p>
          )}

          {notice && (
            <p className="mt-4 rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
              {notice}
            </p>
          )}

          {mode === "forgot" ? (
            <form
              onSubmit={handleForgotPassword}
              className="mt-6 flex flex-col gap-3"
            >
              <label htmlFor="reset-email" className="sr-only">
                Email
              </label>
              <input
                id="reset-email"
                type="email"
                required
                disabled={busy}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourteam.dev"
                className={inputClass}
              />

              <button
                type="submit"
                disabled={busy}
                className="mt-2 w-full rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {pending === "email" ? "Sending…" : "Send reset link"}
              </button>

              <button
                type="button"
                onClick={() => switchMode("login")}
                className="mt-1 text-center text-sm text-muted transition-colors hover:text-foreground"
              >
                Back to log in
              </button>
            </form>
          ) : (
            <>
              <form
                onSubmit={handleSubmit}
                className="mt-6 flex flex-col gap-3"
              >
                {mode === "signup" && (
                  <>
                    <label htmlFor="username" className="sr-only">
                      Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      required
                      disabled={busy}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Username"
                      className={inputClass}
                    />
                  </>
                )}

                <label htmlFor="email" className="sr-only">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  disabled={busy}
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourteam.dev"
                  className={inputClass}
                />

                <label htmlFor="password" className="sr-only">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  disabled={busy}
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className={inputClass}
                />

                {mode === "login" && (
                  <button
                    type="button"
                    onClick={() => switchMode("forgot")}
                    className="-mt-1 self-end text-sm text-muted transition-colors hover:text-foreground"
                  >
                    Forgot password?
                  </button>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="mt-2 w-full rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {pending === "email"
                    ? "Working…"
                    : mode === "signup"
                      ? "Create account"
                      : "Log in"}
                </button>
              </form>

              <div className="my-6 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted">or continue with</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleOAuth("google")}
                  className={oauthButtonClass}
                >
                  <GoogleIcon className="h-[18px] w-[18px]" />
                  {pending === "google" ? "Redirecting…" : "Google"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleOAuth("github")}
                  className={oauthButtonClass}
                >
                  <GitHubIcon className="h-[18px] w-[18px]" />
                  {pending === "github" ? "Redirecting…" : "GitHub"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
