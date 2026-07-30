"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Globe, Mail, Lock, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export type Visibility = "public" | "invited" | "private";

const OPTIONS: {
  value: Visibility;
  label: string;
  hint: string;
  icon: typeof Globe;
}[] = [
  {
    value: "public",
    label: "Public",
    hint: "Anyone with the link can join.",
    icon: Globe,
  },
  {
    value: "invited",
    label: "Invited",
    hint: "Only email addresses you list can join.",
    icon: Mail,
  },
  {
    value: "private",
    label: "Private",
    hint: "Only you.",
    icon: Lock,
  },
];

function parseEmails(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@") && e.length > 3)
    )
  );
}

export default function CreateRoomModal({
  workspaceId,
  userId,
  displayName,
  onClose,
}: {
  workspaceId: string | null;
  userId: string;
  displayName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [emailsRaw, setEmailsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!workspaceId) {
      setError("No workspace found — try signing out and back in.");
      return;
    }

    const emails = visibility === "invited" ? parseEmails(emailsRaw) : [];
    if (visibility === "invited" && emails.length === 0) {
      setError("Add at least one email address, or pick a different option.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();

      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .insert({
          workspace_id: workspaceId,
          name: name.trim() || "Untitled room",
          created_by: userId,
          visibility,
        })
        .select("id")
        .single();
      if (roomError) throw roomError;

      const { error: joinError } = await supabase.from("participants").insert({
        room_id: room.id,
        user_id: userId,
        display_name: displayName,
      });
      if (joinError) throw joinError;

      if (emails.length > 0) {
        const { error: inviteError } = await supabase
          .from("room_invites")
          .insert(
            emails.map((email) => ({
              room_id: room.id,
              email,
              invited_by: userId,
            }))
          );
        if (inviteError) throw inviteError;
      }

      router.push(`/room/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the room.");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-12 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-room-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-8"
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <h2
            id="create-room-title"
            className="font-display text-2xl font-bold tracking-tight"
          >
            New room
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="shrink-0 text-muted transition-colors hover:text-foreground disabled:opacity-60"
          >
            <X className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="room-name"
            className="font-display text-sm font-medium"
          >
            Room name
          </label>
          <input
            id="room-name"
            autoFocus
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled room"
            className="mt-2 w-full rounded-md border border-border bg-background px-4 py-3 font-display text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
          />

          <p className="mt-6 font-display text-sm font-medium">Who can join</p>
          <div className="mt-2 flex flex-col gap-2">
            {OPTIONS.map(({ value, label, hint, icon: Icon }) => {
              const active = visibility === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => setVisibility(value)}
                  aria-pressed={active}
                  className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-60 ${
                    active
                      ? "border-accent bg-accent/10"
                      : "border-border hover:border-muted"
                  }`}
                >
                  <Icon
                    className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-accent" : "text-muted"}`}
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0">
                    <span className="block font-display text-sm font-semibold">
                      {label}
                    </span>
                    <span className="block text-xs text-muted">{hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {visibility === "invited" && (
            <div className="mt-4">
              <label
                htmlFor="room-invites"
                className="font-display text-sm font-medium"
              >
                Invite by email
              </label>
              <textarea
                id="room-invites"
                rows={3}
                disabled={busy}
                value={emailsRaw}
                onChange={(e) => setEmailsRaw(e.target.value)}
                placeholder="ana@team.dev, devan@team.dev"
                className="mt-2 w-full resize-y rounded-md border border-border bg-background px-4 py-3 font-display text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
              />
              <p className="mt-1.5 text-xs text-muted">
                Separate with commas or new lines. No email is sent — share the
                room link yourself.
              </p>
            </div>
          )}

          {error && (
            <p className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create room"}
          </button>
        </form>
      </div>
    </div>
  );
}
