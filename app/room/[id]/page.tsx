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
} from "@/components/RoomView";

function firstOf<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

type ParticipantRow = {
  user_id: string;
  display_name: string | null;
  last_seen_at: string | null;
  joined_at: string | null;
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
    .select("id, name, created_by")
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
      "user_id, display_name, last_seen_at, joined_at, profiles(username, avatar_url)"
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
        .select("thread_id, user_id, seq")
        .in("thread_id", threadIds)
        .order("seq", { ascending: true })
    : { data: [] };

  const initialThreadParticipants: Record<string, string[]> = {};
  for (const row of threadParticipantRows ?? []) {
    (initialThreadParticipants[row.thread_id] ??= []).push(row.user_id);
  }

  // Every thread in the room loads at once — switching threads is then a local
  // filter rather than a round trip. Worth revisiting if rooms grow large.
  const { data: messageRows } = await supabase
    .from("messages")
    .select(
      "id, thread_id, sender_type, sender_id, content, status, type, interrupted_by, created_at"
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
  }));

  const initialMembers: RoomMember[] = participants.map((p) => {
    const prof = firstOf(p.profiles);
    return {
      userId: p.user_id,
      username: prof?.username ?? p.display_name ?? "Someone",
      avatarUrl: prof?.avatar_url ?? null,
      lastSeenAt: p.last_seen_at,
      joinedAt: p.joined_at,
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
    />
  );
}
