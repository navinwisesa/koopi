"use client";

import { useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Plus, LogIn, X } from "lucide-react";
import type { Carpet } from "@/lib/accountCarpet";
import CreateRoomModal, { type Visibility } from "@/components/CreateRoomModal";
import { createClient } from "@/lib/supabase/client";

export type RoomView = {
  id: string;
  name: string;
  visibility: Visibility;
  createdBy: string | null;
  members: { name: string; avatarUrl?: string | null }[];
  lastActive: string;
};

const RoomClubhouse = dynamic(() => import("@/components/RoomClubhouse"), {
  loading: () => <p className="py-20 text-center text-muted" role="status">Opening the clubhouse…</p>,
});

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default function DashboardRooms({
  rooms,
  workspaceId,
  userId,
  displayName,
  loadError,
  initialCarpet,
}: {
  rooms: RoomView[];
  workspaceId: string | null;
  userId: string;
  displayName: string;
  loadError: string | null;
  initialCarpet?: Carpet | null;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(loadError);
  const working = busy;

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
      const { error: joinError } = await createClient()
        .from("participants")
        .insert({ room_id: roomId, user_id: userId, display_name: displayName });

      // 23505 = already joined, treated as success.
      if (joinError && joinError.code !== "23505") {
        // RLS blocks the insert when the room's visibility excludes you.
        if (joinError.code === "42501") {
          throw new Error("That room is private or you weren't invited.");
        }
        if (joinError.code === "23503") {
          throw new Error("No room with that code.");
        }
        throw joinError;
      }

      setCode("");
      setJoining(false);
      router.push(`/room/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join that room.");
      setBusy(false);
    }
  }

  return (
    <>
      {showCreate && (
        <CreateRoomModal
          workspaceId={workspaceId}
          userId={userId}
          displayName={displayName}
          onClose={() => setShowCreate(false)}
        />
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          disabled={working}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-4 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto"
        >
          <Plus className="h-5 w-5" strokeWidth={2} />
          Create a room
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
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">Your rooms</h2>
        <RoomClubhouse rooms={rooms} userId={userId} displayName={displayName} initialCarpet={initialCarpet}
          onCreate={() => setShowCreate(true)} active={!showCreate && !joining} />
      </section>
    </>
  );
}
