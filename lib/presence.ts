export const ONLINE_WINDOW_MS = 2 * 60 * 1000;
export const IDLE_WINDOW_MS = 10 * 60 * 1000;

export type Presence = "online" | "idle" | "away";

/**
 * Derived from the 30s heartbeat, so a closed tab ages out rather than
 * reporting a real disconnect.
 */
export function presenceOf(lastSeenAt: string | null, now: number): Presence {
  if (!lastSeenAt) return "away";
  const age = now - new Date(lastSeenAt).getTime();
  if (age < ONLINE_WINDOW_MS) return "online";
  if (age < IDLE_WINDOW_MS) return "idle";
  return "away";
}

export const PRESENCE_DOT: Record<Presence, string> = {
  online: "bg-accent",
  idle: "bg-muted",
  away: "bg-border",
};
