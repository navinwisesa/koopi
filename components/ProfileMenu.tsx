"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, Pencil } from "lucide-react";
import Avatar from "@/components/Avatar";
import { createClient } from "@/lib/supabase/client";

export default function ProfileMenu({
  userId,
  username,
  email,
  avatarUrl,
  onUsernameSaved,
}: {
  userId: string;
  username: string;
  email: string;
  avatarUrl?: string | null;
  onUsernameSaved: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(username);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) setDraft(username);
  }, [username, editing]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
        setError(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setEditing(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function saveUsername() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === username) {
      setDraft(username);
      setEditing(false);
      setError(null);
      return;
    }

    setSaving(true);
    setError(null);

    const { error: updateError } = await createClient()
      .from("profiles")
      .update({ username: trimmed })
      .eq("id", userId);

    setSaving(false);

    if (updateError) {
      setError(
        updateError.code === "23505"
          ? "That username is taken."
          : "Could not save that username."
      );
      return;
    }

    setEditing(false);
    onUsernameSaved(trimmed);
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await createClient().auth.signOut();
    } finally {
      // Full navigation so the server re-reads the cleared session cookies.
      window.location.assign("/");
    }
  }

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your profile and settings"
        title="Your profile and settings"
        className="block rounded-full"
      >
        <Avatar
          name={username}
          src={avatarUrl}
          size="sm"
          className="ring-2 ring-background"
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        >
          <div className="border-b border-border px-4 py-3">
            {editing ? (
              <div>
                <label className="mb-1 block font-sans text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Username
                </label>
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveUsername();
                    if (e.key === "Escape") {
                      setDraft(username);
                      setEditing(false);
                      setError(null);
                    }
                  }}
                  className="w-full rounded-md border border-accent bg-background px-2 py-1.5 font-display text-sm text-foreground focus:outline-none"
                />
                {error && (
                  <p className="mt-1.5 text-xs text-red-400">{error}</p>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(username);
                      setEditing(false);
                      setError(null);
                    }}
                    className="rounded-md px-2.5 py-1 font-display text-xs text-muted transition-colors hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveUsername}
                    disabled={saving}
                    className="rounded-md bg-accent px-2.5 py-1 font-display text-xs font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-display text-sm font-semibold text-foreground">
                    {username}
                  </p>
                  <p className="truncate font-sans text-xs text-muted">
                    {email}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label="Edit username"
                  title="Edit username"
                  className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-background hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex w-full items-center gap-2 px-4 py-3 text-left font-display text-sm text-foreground transition-colors hover:bg-background disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" strokeWidth={1.75} />
            {loggingOut ? "Signing out…" : "Log out"}
          </button>
        </div>
      )}
    </div>
  );
}
