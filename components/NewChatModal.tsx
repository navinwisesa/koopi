"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import Avatar from "@/components/Avatar";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember, Thread } from "@/components/RoomView";
import type { Personality } from "@/components/PersonalitySelector";

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: row.id as string,
    createdBy: (row.created_by as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    // create_thread_with_invites' RPC return reflects whatever the row
    // actually has — undefined (not an error) until the migration adding
    // this column is applied, same fallback every other reader of this
    // column uses.
    personality: (row.personality as Personality | null | undefined) ?? "default",
  };
}

export default function NewChatModal({
  roomId,
  currentUserId,
  invitable,
  onCreated,
  onClose,
}: {
  roomId: string;
  currentUserId: string;
  invitable: RoomMember[];
  onCreated: (thread: Thread, participantIds: string[]) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Closing on "click" rather than "mousedown" matters here: the dropdown
    // sits inline (not floating), so collapsing it reflows the buttons below.
    // Closing on mousedown would shift the Create/Cancel buttons out from
    // under the cursor before the click that was meant to hit them lands.
    function onPointerDown(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setDropdownOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("click", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  function toggleInvitee(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);

    const { data, error: rpcError } = await createClient().rpc(
      "create_thread_with_invites",
      {
        p_room_id: roomId,
        p_title: title.trim() || null,
        p_invitee_ids: Array.from(selected),
      }
    );

    setCreating(false);

    if (rpcError || !data) {
      setError(rpcError?.message ?? "Could not create the chat.");
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    onCreated(rowToThread(row as Record<string, unknown>), [
      currentUserId,
      ...Array.from(selected),
    ]);
  }

  const selectedMembers = invitable.filter((m) => selected.has(m.userId));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl"
      >
        <h2 className="font-display text-lg font-bold text-foreground">
          New chat
        </h2>

        <label
          htmlFor="new-chat-title"
          className="mt-4 block font-sans text-xs font-semibold uppercase tracking-wider text-muted"
        >
          Name
        </label>
        <input
          id="new-chat-title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Refund policy"
          className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />

        <label className="mt-4 block font-sans text-xs font-semibold uppercase tracking-wider text-muted">
          Invite people
        </label>
        <div ref={dropdownRef} className="relative mt-1.5">
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
            className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-left text-sm"
          >
            <span className={selected.size ? "text-foreground" : "text-muted"}>
              {selected.size
                ? `${selected.size} invited`
                : invitable.length
                  ? "Choose teammates"
                  : "No other teammates in this room yet"}
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted transition-transform ${
                dropdownOpen ? "rotate-180" : ""
              }`}
              strokeWidth={2}
            />
          </button>

          {dropdownOpen && invitable.length > 0 && (
            <ul
              role="listbox"
              className="mt-1.5 max-h-52 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-xl"
            >
              {invitable.map((m) => {
                const isSelected = selected.has(m.userId);
                return (
                  <li key={m.userId}>
                    <button
                      type="button"
                      onClick={() => toggleInvitee(m.userId)}
                      role="option"
                      aria-selected={isSelected}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-background"
                    >
                      <Avatar name={m.username} src={m.avatarUrl} size="sm" />
                      <span className="min-w-0 flex-1 truncate font-sans text-sm text-foreground">
                        {m.username}
                      </span>
                      {isSelected && (
                        <Check
                          className="h-4 w-4 shrink-0 text-accent"
                          strokeWidth={2.5}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selectedMembers.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedMembers.map((m) => (
              <span
                key={m.userId}
                className="rounded-full bg-accent/15 px-2.5 py-1 font-sans text-xs text-foreground"
              >
                {m.username}
              </span>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 font-display text-sm text-muted transition-colors hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="rounded-md bg-accent px-4 py-2 font-display text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
