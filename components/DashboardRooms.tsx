"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, LogIn, X, Users, Copy, Check } from "lucide-react";
import Avatar from "@/components/Avatar";
import { createClient } from "@/lib/supabase/client";

export type RoomView = {
  id: string;
  name: string;
  members: { name: string; avatarUrl?: string | null }[];
  lastActive: string;
};

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default function DashboardRooms({
  rooms,
  workspaceId,
  userId,
  displayName,
  loadError,
}: {
  rooms: RoomView[];
  workspaceId: string | null;
  userId: string;
  displayName: string;
  loadError: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(loadError);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const working = busy || isPending;

  async function handleCreate() {
    setError(null);

    if (!workspaceId) {
      setError("No workspace found for your account — try signing out and back in.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();

      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .insert({
          workspace_id: workspaceId,
          name: "Untitled room",
          created_by: userId,
        })
        .select("id")
        .single();

      if (roomError) throw roomError;

      // Creator joins their own room so it shows up under "your rooms".
      const { error: joinError } = await supabase.from("participants").insert({
        room_id: room.id,
        user_id: userId,
        display_name: displayName,
      });

      if (joinError) throw joinError;

      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the room.");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const roomId = code.match(UUID_RE)?.[0];
    if (!roomId) {
      setError("That doesn't look like a room code. Paste the room's ID or link.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { error: joinError } = await supabase.from("participants").insert({
        room_id: roomId,
        user_id: userId,
        display_name: displayName,
      });

      // 23505 = already a participant, which is a no-op success.
      if (joinError && joinError.code !== "23505") {
        if (joinError.code === "23503") throw new Error("No room with that code.");
        throw joinError;
      }

      setCode("");
      setJoining(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join that room.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId((v) => (v === id ? null : v)), 1500);
    } catch {
      setError("Couldn't copy — select the code manually.");
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={handleCreate}
          disabled={working}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-4 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto"
        >
          <Plus className="h-5 w-5" strokeWidth={2} />
          {busy ? "Working…" : "Create a room"}
        </button>

        {joining ? (
          <form
            onSubmit={handleJoin}
            className="flex w-full flex-1 items-center gap-2 sm:w-auto"
          >
            <label htmlFor="room-code" className="sr-only">
              Room code
            </label>
            <input
              id="room-code"
              autoFocus
              disabled={working}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste a room code"
              className="w-full flex-1 rounded-lg border border-border bg-background px-4 py-4 font-display text-base text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={working}
              className="shrink-0 rounded-lg border border-border px-5 py-4 font-display text-base font-medium transition-colors hover:border-muted disabled:opacity-60"
            >
              Join
            </button>
            <button
              type="button"
              onClick={() => {
                setJoining(false);
                setCode("");
                setError(null);
              }}
              aria-label="Cancel"
              className="shrink-0 rounded-lg border border-border p-4 text-muted transition-colors hover:text-foreground"
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setJoining(true)}
            disabled={working}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-6 py-4 font-display text-base font-medium text-foreground transition-colors hover:border-muted disabled:opacity-60 sm:w-auto"
          >
            <LogIn className="h-5 w-5" strokeWidth={2} />
            Join a room
          </button>
        )}
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <section className="mt-14">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Your rooms
        </h2>

        {rooms.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border px-6 py-14 text-center">
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent">
              <Users className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <p className="font-display text-base font-semibold">No rooms yet</p>
            <p className="mt-1 text-sm text-muted">Create one to get started.</p>
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {rooms.map((room) => (
              <li
                key={room.id}
                className="flex items-center gap-4 rounded-lg border border-border bg-surface px-5 py-4 transition-colors hover:border-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-base font-semibold">
                    {room.name}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted">
                    {room.id}
                  </p>
                </div>

                <div className="flex shrink-0 -space-x-2">
                  {room.members.slice(0, 3).map((m, i) => (
                    <Avatar
                      key={`${room.id}-${m.name}-${i}`}
                      name={m.name}
                      src={m.avatarUrl}
                      size="sm"
                      className="ring-2 ring-surface"
                    />
                  ))}
                  {room.members.length > 3 && (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-border text-[10px] font-medium text-muted ring-2 ring-surface">
                      +{room.members.length - 3}
                    </span>
                  )}
                </div>

                <span className="hidden w-24 shrink-0 text-right text-sm text-muted sm:block">
                  {room.lastActive}
                </span>

                <button
                  type="button"
                  onClick={() => copyCode(room.id)}
                  aria-label="Copy room code"
                  title="Copy room code"
                  className="shrink-0 rounded-md border border-border p-2 text-muted transition-colors hover:text-foreground"
                >
                  {copiedId === room.id ? (
                    <Check className="h-4 w-4 text-accent" strokeWidth={2} />
                  ) : (
                    <Copy className="h-4 w-4" strokeWidth={1.75} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
