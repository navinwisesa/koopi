import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BackgroundGrid from "@/components/BackgroundGrid";
import UserMenu from "@/components/UserMenu";
import DashboardRooms, { type RoomView } from "@/components/DashboardRooms";

/** Formatted on the server and passed down, so the string is stable through hydration. */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** PostgREST returns embedded one-to-one rows as an object or a 1-element array. */
function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type ParticipantRow = {
  user_id: string;
  last_seen_at: string | null;
  profiles:
    | { username: string | null; avatar_url: string | null }
    | { username: string | null; avatar_url: string | null }[]
    | null;
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/auth");

  const meta = user.user_metadata ?? {};
  const fallbackName =
    (meta.username as string | undefined) ||
    (meta.user_name as string | undefined) ||
    (meta.full_name as string | undefined) ||
    user.email?.split("@")[0] ||
    "there";

  // Profile is created by the on_auth_user_created trigger.
  const { data: profile } = await supabase
    .from("profiles")
    .select("username, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const username = profile?.username ?? fallbackName;
  const avatarUrl =
    profile?.avatar_url ??
    (meta.avatar_url as string | undefined) ??
    (meta.picture as string | undefined) ??
    null;

  // Personal workspace, provisioned on signup.
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // Scope to rooms this user has actually joined. RLS alone isn't enough here:
  // public rooms are readable by everyone, so an unfiltered select would list
  // other people's rooms too.
  const { data: joined } = await supabase
    .from("participants")
    .select("room_id")
    .eq("user_id", user.id);

  const roomIds = (joined ?? []).map((p) => p.room_id);

  const { data: roomRows, error: roomsError } = roomIds.length
    ? await supabase
        .from("rooms")
        .select(
          "id, name, visibility, created_at, created_by, participants(user_id, last_seen_at, profiles(username, avatar_url))"
        )
        .in("id", roomIds)
        .order("created_at", { ascending: false })
    : { data: [], error: null };

  const rooms: RoomView[] = (roomRows ?? []).map((room) => {
    const participants = (room.participants ?? []) as ParticipantRow[];

    const lastSeen = participants
      .map((p) => p.last_seen_at)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1);

    return {
      id: room.id,
      name: room.name || "Untitled room",
      visibility: (room.visibility ?? "private") as RoomView["visibility"],
      createdBy: room.created_by ?? null,
      members: participants.map((p) => {
        const prof = firstOf(p.profiles);
        return {
          name: prof?.username ?? "Someone",
          avatarUrl: prof?.avatar_url ?? null,
        };
      }),
      lastActive: relativeTime(lastSeen ?? room.created_at),
    };
  });

  return (
    <div className="relative min-h-screen overflow-hidden">
      <BackgroundGrid />

      <header className="border-b border-border/80">
        <nav className="mx-auto flex max-w-4xl items-center px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-display text-sm font-bold text-accent-foreground">
              K
            </span>
            <span className="translate-y-[2px] font-display text-lg font-bold tracking-tight">
              Koopi
            </span>
          </Link>

          <div className="ml-auto">
            <UserMenu
              name={username}
              email={user.email ?? ""}
              avatarUrl={avatarUrl}
            />
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-24 pt-16 sm:pt-20">
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Welcome back, {username}
        </h1>
        <p className="mt-3 text-muted">
          Jump into a room, or start a fresh one.
        </p>

        <div className="mt-10">
          <DashboardRooms
            rooms={rooms}
            workspaceId={membership?.workspace_id ?? null}
            userId={user.id}
            displayName={username}
            loadError={roomsError?.message ?? null}
          />
        </div>
      </main>
    </div>
  );
}
