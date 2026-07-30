"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MoreVertical, PanelLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { presenceOf, PRESENCE_DOT, type Presence } from "@/lib/presence";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember, Thread } from "@/components/RoomView";

const LABEL_MAX_LENGTH = 30;
const PRESENCE_RANK: Record<Presence, number> = { online: 0, idle: 1, away: 2 };

/** Time for threads touched today, calendar date for anything older. */
function updatedLabel(iso: string, now: number) {
  const then = new Date(iso);
  const sameDay = new Date(now).toDateString() === then.toDateString();
  if (sameDay) {
    return then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Alice", "Alice and Bob", "Alice, Bob, and Carl", or "Alice and others". */
function labelForParticipants(
  ids: string[],
  byId: Map<string, RoomMember>,
  currentUserId: string
): string {
  const names = ids.map((id) => byId.get(id)?.username ?? "Former member");

  if (names.length <= 1) {
    const solo = names[0] ?? "Former member";
    return ids[0] === currentUserId ? `${solo} (you)` : solo;
  }
  if (names.length === 2) return `${names[0]} and ${names[1]}`;

  const full = `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  return full.length <= LABEL_MAX_LENGTH ? full : `${names[0]} and others`;
}

type Section = {
  key: string;
  participantIds: string[];
  label: string;
  bestPresence: Presence;
  threads: Thread[];
  activeAt: string;
};

export default function RoomSidebar({
  threads,
  threadParticipants,
  members,
  activeThreadId,
  currentUserId,
  now,
  onSelectThread,
  onNewChat,
  open,
  onClose,
}: {
  threads: Thread[];
  threadParticipants: Record<string, string[]>;
  members: RoomMember[];
  activeThreadId: string | null;
  currentUserId: string;
  now: number;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const menuRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!menuOpenId) return;

    function onPointerDown(e: MouseEvent) {
      const el = menuOpenId ? menuRefs.current.get(menuOpenId) : null;
      if (el && !el.contains(e.target as Node)) setMenuOpenId(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpenId]);

  // Threads group by their exact invite list — everyone in a chat shares one
  // section, labeled with their names, rather than filing it under whoever
  // happened to create it.
  const sections = useMemo<Section[]>(() => {
    const byId = new Map(members.map((m) => [m.userId, m]));
    const groups = new Map<string, { ids: string[]; threads: Thread[] }>();

    for (const t of threads) {
      // Participant data may not have arrived yet for a just-created thread;
      // fall back to the creator alone rather than mis-filing it.
      const ids = threadParticipants[t.id] ?? [t.createdBy ?? "unknown"];
      const key = [...ids].sort().join(",");
      const group = groups.get(key);
      if (group) group.threads.push(t);
      else groups.set(key, { ids, threads: [t] });
    }

    const out: Section[] = [];
    for (const [key, { ids, threads: list }] of groups) {
      const sorted = [...list].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      );
      const bestPresence = ids.reduce<Presence>((best, id) => {
        const presence = presenceOf(byId.get(id)?.lastSeenAt ?? null, now);
        return PRESENCE_RANK[presence] < PRESENCE_RANK[best] ? presence : best;
      }, "away");

      out.push({
        key,
        participantIds: ids,
        label: labelForParticipants(ids, byId, currentUserId),
        bestPresence,
        threads: sorted,
        activeAt: sorted[0]?.updatedAt ?? "",
      });
    }

    // Most recently active conversation floats to the top.
    return out.sort((a, b) => b.activeAt.localeCompare(a.activeAt));
  }, [threads, threadParticipants, members, currentUserId, now]);

  function toggleSection(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function startRename(t: Thread) {
    setMenuOpenId(null);
    setRenamingId(t.id);
    setRenameDraft(t.title?.trim() || "");
  }

  async function saveRename(threadId: string) {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (!trimmed) return;

    setBusyId(threadId);
    await createClient().from("threads").update({ title: trimmed }).eq("id", threadId);
    setBusyId(null);
  }

  async function handleDelete(t: Thread) {
    setMenuOpenId(null);
    const label = t.title?.trim() || "New chat";
    if (!window.confirm(`Delete "${label}"? This can't be undone.`)) return;

    setBusyId(t.id);
    await createClient().from("threads").delete().eq("id", t.id);
    setBusyId(null);
  }

  return (
    <>
      {/* Backdrop — drawer mode only */}
      {open && (
        <div
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full lg:hidden"
        }`}
      >
        {/* ---------- sidebar top bar ---------- */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-3">
          <button
            type="button"
            onClick={onNewChat}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-display text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            New chat
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Hide chat directory"
            title="Hide chat directory"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-background hover:text-foreground"
          >
            <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* ---------- chat directory ---------- */}
        <div className="px-5 pb-2 pt-4">
          <h2 className="font-display text-xs font-semibold uppercase tracking-wider text-muted">
            Chat directory
          </h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {sections.length === 0 ? (
            <p className="px-5 py-2 font-sans text-xs leading-relaxed text-muted">
              No chats yet. Start one to see it here.
            </p>
          ) : (
            sections.map((section) => {
              const isCollapsed = collapsed.has(section.key);

              return (
                <div key={section.key} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={!isCollapsed}
                    className="flex w-full items-center gap-2 px-5 py-2 text-left transition-colors hover:bg-background/60"
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${
                        isCollapsed ? "-rotate-90" : ""
                      }`}
                      strokeWidth={2.5}
                    />
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRESENCE_DOT[section.bestPresence]}`}
                      title={section.bestPresence}
                    />
                    <span className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-foreground">
                      {section.label}
                    </span>
                    <span className="shrink-0 font-sans text-xs text-muted">
                      {section.threads.length}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <ul className="space-y-1 px-3 pb-1">
                      {section.threads.map((t) => {
                        const active = t.id === activeThreadId;
                        const isRenaming = renamingId === t.id;
                        const isBusy = busyId === t.id;
                        const canDelete = t.createdBy === currentUserId;

                        return (
                          <li key={t.id}>
                            <div
                              className={`flex items-center gap-1 rounded-md border pl-3 pr-1.5 py-1.5 transition-colors ${
                                active
                                  ? "border-accent bg-accent/15"
                                  : "border-transparent hover:border-border hover:bg-background/60"
                              }`}
                            >
                              {isRenaming ? (
                                <input
                                  autoFocus
                                  value={renameDraft}
                                  onChange={(e) => setRenameDraft(e.target.value)}
                                  onBlur={() => void saveRename(t.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") void saveRename(t.id);
                                    if (e.key === "Escape") setRenamingId(null);
                                  }}
                                  className="min-w-0 flex-1 rounded border border-accent bg-background px-1.5 py-0.5 font-sans text-sm text-foreground focus:outline-none"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onSelectThread(t.id)}
                                  disabled={isBusy}
                                  aria-current={active ? "true" : undefined}
                                  className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:opacity-50"
                                >
                                  <span
                                    className={`min-w-0 flex-1 truncate font-sans text-sm ${
                                      active ? "text-foreground" : "text-foreground/85"
                                    }`}
                                  >
                                    {t.title?.trim() || "New chat"}
                                  </span>
                                  <span className="shrink-0 font-sans text-[11px] leading-5 text-muted">
                                    {updatedLabel(t.updatedAt, now)}
                                  </span>
                                </button>
                              )}

                              {!isRenaming && (
                                <div
                                  ref={(el) => {
                                    if (el) menuRefs.current.set(t.id, el);
                                    else menuRefs.current.delete(t.id);
                                  }}
                                  className="relative shrink-0"
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setMenuOpenId((cur) => (cur === t.id ? null : t.id))
                                    }
                                    aria-label="Chat options"
                                    aria-haspopup="menu"
                                    aria-expanded={menuOpenId === t.id}
                                    className="rounded p-1 text-muted transition-colors hover:bg-background hover:text-foreground"
                                  >
                                    <MoreVertical className="h-3.5 w-3.5" strokeWidth={1.75} />
                                  </button>

                                  {menuOpenId === t.id && (
                                    <div
                                      role="menu"
                                      className="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-md border border-border bg-surface shadow-xl"
                                    >
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => startRename(t)}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-sm text-foreground transition-colors hover:bg-background"
                                      >
                                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                                        Rename
                                      </button>
                                      {canDelete && (
                                        <button
                                          type="button"
                                          role="menuitem"
                                          onClick={() => void handleDelete(t)}
                                          className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-sm text-red-400 transition-colors hover:bg-background"
                                        >
                                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                                          Delete
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
