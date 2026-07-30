"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { describeAuthError } from "@/lib/authErrors";

const inputClass =
  "w-full rounded-md border border-border bg-background px-4 py-3 font-display text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";

export default function UpdatePasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }

    setPending(true);
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setTimeout(() => window.location.assign("/dashboard"), 1200);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="mt-6 rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
        Password updated — taking you to your dashboard…
      </p>
    );
  }

  return (
    <>
      {error && (
        <p className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        <label htmlFor="password" className="sr-only">
          New password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          disabled={pending}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
          className={inputClass}
        />

        <label htmlFor="confirm" className="sr-only">
          Confirm new password
        </label>
        <input
          id="confirm"
          type="password"
          required
          minLength={6}
          disabled={pending}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm new password"
          className={inputClass}
        />

        <button
          type="submit"
          disabled={pending}
          className="mt-2 w-full rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Updating…" : "Update password"}
        </button>
      </form>
    </>
  );
}
