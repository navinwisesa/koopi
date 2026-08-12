import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import BackgroundGrid from "@/components/BackgroundGrid";
import JoinRoomButton from "@/components/JoinRoomButton";
import RoomView, {
  type ChatMessage,
  type RoomMember,
  type Thread,
  type Project,
  type ProjectFile,
} from "@/components/RoomView";
import { type Personality } from "@/components/PersonalitySelector";

function firstOf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

type ParticipantRow = {
  user_id: string;
  display_name: string | null;
  last_seen_at: string | null;
  joined_at: string | null;
  role: "owner" | "admin" | "member";
  profiles:
    | { username: string | null; avatar_url: string | null }
    | { username: string | null; avatar_url: string | null }[]
    | null;
};

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth");

  const { data: room } = await supabase
    .from("rooms")
    .select("id, name, created_by, personality")
    .eq("id", id)
    .maybeSingle();

  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  const username = profile?.username ?? user.email?.split("@")[0] ?? "Someone";

  if (!room) {
    return (
      <div className="relative min-h-screen overflow-hidden px-6 pt-16 sm:pt-20">
        <BackgroundGrid />
        <div className="mx-auto max-w-2xl">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            Back to rooms
          </Link>
          <h1 className="mt-8 font-display text-3xl font-bold tracking-tight">
            Room not found
          </h1>
          <p className="mt-3 text-muted">
            It may have been deleted, or you don&apos;t have access to it.
          </p>
        </div>
      </div>
    );
  }

  const { data: participantRows } = await supabase
    .from("participants")
    .select(
      "user_id, display_name, last_seen_at, joined_at, role, profiles(username, avatar_url)"
    )
    .eq("room_id", id);

  const participants = (participantRows ?? []) as ParticipantRow[];
  const isParticipant = participants.some((p) => p.user_id === user.id);

  // Visitors who are allowed in but haven't joined get a join gate rather than
  // being silently added — joining is what grants read access to messages.
  if (!isParticipant) {
    return (
      <div className="relative min-h-screen overflow-hidden px-6 pt-16 sm:pt-20">
        <BackgroundGrid />
        <div className="mx-auto max-w-2xl">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            Back to rooms
          </Link>
          <h1 className="mt-8 font-display text-3xl font-bold tracking-tight">
            {room.name || "Untitled Room"}
          </h1>
          <p className="mt-3 text-muted">
            Join this room to see the session and take part.
          </p>
          <div className="mt-8">
            <JoinRoomButton
              roomId={room.id}
              userId={user.id}
              displayName={username}
            />
          </div>
        </div>
      </div>
    );
  }

  const { data: threadRows } = await supabase
    .from("threads")
    .select("id, created_by, title, created_at, updated_at")
    .eq("room_id", id)
    .order("updated_at", { ascending: false });

  const initialThreads: Thread[] = (threadRows ?? []).map((t) => ({
    id: t.id,
    createdBy: t.created_by,
    title: t.title,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  const threadIds = initialThreads.map((t) => t.id);
  // Invites made in the same request share one transaction timestamp, so
  // `added_at` can't break ties — `seq` is a real insertion-order column.
  const { data: threadParticipantRows } = threadIds.length
    ? await supabase
        .from("thread_participants")
        .select("thread_id, user_id, seq, last_read_at, koopi_active")
        .in("thread_id", threadIds)
        .order("seq", { ascending: true })
    : { data: [] };

  const initialThreadParticipants: Record<string, string[]> = {};
  // Only the current user's own last_read_at is meaningful client-side — unread state
  // is per-viewer, not a shared property of the thread.
  const initialLastReadAt: Record<string, string | null> = {};
  // The current user's own "Ask Koopi" setting per thread — what actually gates whether
  // their own messages trigger a reply.
  const initialKoopiActive: Record<string, boolean> = {};
  // Every participant's setting, per thread — powers the "who else Koopi answers" hint
  // next to the toggle, since each person's setting is independent.
  const initialParticipantKoopiActive: Record<string, Record<string, boolean>> = {};
  for (const row of threadParticipantRows ?? []) {
    (initialThreadParticipants[row.thread_id] ??= []).push(row.user_id);
    if (row.user_id === user.id) {
      initialLastReadAt[row.thread_id] = row.last_read_at;
      initialKoopiActive[row.thread_id] = row.koopi_active;
    }
    (initialParticipantKoopiActive[row.thread_id] ??= {})[row.user_id] = row.koopi_active;
  }

  // Every thread in the room loads at once — switching threads is then a local
  // filter rather than a round trip. Worth revisiting if rooms grow large.
  const { data: messageRows } = await supabase
    .from("messages")
    .select(
      "id, thread_id, sender_type, sender_id, content, status, type, interrupted_by, created_at, model_tier, model_provider, used_room_memory, flagged"
    )
    .eq("room_id", id)
    .order("created_at", { ascending: true });

  const initialMessages: ChatMessage[] = (messageRows ?? []).map((m) => ({
    id: m.id,
    threadId: m.thread_id,
    senderType: m.sender_type,
    senderId: m.sender_id,
    content: m.content ?? "",
    status: m.status,
    type: m.type ?? "text",
    interruptedBy: m.interrupted_by ?? null,
    createdAt: m.created_at,
    modelTier: m.model_tier ?? null,
    modelProvider: m.model_provider ?? null,
    usedRoomMemory: m.used_room_memory ?? false,
    flagged: m.flagged ?? false,
  }));

  // Project mode: one project per room (not per thread) — replaces the old
  // thread_files single-file-per-thread model. Not lazily created here;
  // RoomView creates it client-side the first time anyone opens the panel,
  // so a room nobody has opened Project on yet simply has no project row.
  const { data: projectRow } = await supabase
    .from("projects")
    .select(
      "id, room_id, name, created_by, run_status, run_entry_path, last_run_stdout, last_run_stderr, last_run_exit_code, last_run_at, last_run_by"
    )
    .eq("room_id", id)
    .maybeSingle();

  const initialProject: Project | null = projectRow
    ? {
        id: projectRow.id,
        roomId: projectRow.room_id,
        name: projectRow.name ?? "Project",
        createdBy: projectRow.created_by,
        status: (projectRow.run_status as "idle" | "running") ?? "idle",
        entryPath: projectRow.run_entry_path,
        lastRunStdout: projectRow.last_run_stdout,
        lastRunStderr: projectRow.last_run_stderr,
        lastRunExitCode: projectRow.last_run_exit_code,
        lastRunAt: projectRow.last_run_at,
        lastRunBy: projectRow.last_run_by,
      }
    : null;

  const { data: projectFileRows } = projectRow
    ? await supabase
        .from("project_files")
        .select("id, project_id, path, content, language, last_edited_by, updated_at")
        .eq("project_id", projectRow.id)
    : { data: [] };

  const initialProjectFiles: ProjectFile[] = (projectFileRows ?? []).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    content: row.content ?? "",
    language: row.language ?? "python",
    lastEditedBy: row.last_edited_by,
    updatedAt: row.updated_at,
  }));

  const initialMembers: RoomMember[] = participants.map((p) => {
    const prof = firstOf(p.profiles);
    return {
      userId: p.user_id,
      username: prof?.username ?? p.display_name ?? "Someone",
      avatarUrl: prof?.avatar_url ?? null,
      lastSeenAt: p.last_seen_at,
      joinedAt: p.joined_at,
      role: p.role ?? "member",
    };
  });

  return (
    <RoomView
      roomId={room.id}
      initialName={room.name || "Untitled Room"}
      isOwner={room.created_by === user.id}
      currentUserId={user.id}
      currentUserEmail={user.email ?? ""}
      initialMessages={initialMessages}
      initialMembers={initialMembers}
      initialThreads={initialThreads}
      initialThreadParticipants={initialThreadParticipants}
      initialLastReadAt={initialLastReadAt}
      initialKoopiActive={initialKoopiActive}
      initialParticipantKoopiActive={initialParticipantKoopiActive}
      initialProject={initialProject}
      initialProjectFiles={initialProjectFiles}
      initialPersonality={(room.personality as Personality | null) ?? "default"}
    />
  );
}
