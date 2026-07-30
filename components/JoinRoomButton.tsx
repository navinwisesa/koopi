"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function JoinRoomButton({
  roomId,
  userId,
  displayName,
}: {
  roomId: string;
  userId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    setError(null);
    setBusy(true);
    try {
      const { error: joinError } = await createClient()
        .from("participants")
        .insert({ room_id: roomId, user_id: userId, display_name: displayName });

      // 23505 = already joined, which is a no-op success.
      if (joinError && joinError.code !== "23505") {
        // RLS rejects the insert when visibility doesn't allow this user in.
        if (joinError.code === "42501") {
          throw new Error("You don't have access to this room.");
        }
        throw joinError;
      }

      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleJoin}
        disabled={busy || isPending}
        className="rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy || isPending ? "Joining…" : "Join this room"}
      </button>
      {error && (
        <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
