import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** False until the Supabase env vars are filled in, so the UI can fail loudly instead of cryptically. */
export const isSupabaseConfigured = Boolean(url && anonKey);

// Most call sites construct a client inline per action (`createClient().from(...)`)
// rather than holding onto one, which used to mean a fresh GoTrueClient — and its own
// auth-state listener — on every rename/delete/personality-change/etc. Supabase logs
// "Multiple GoTrueClient instances detected in the same browser context" the moment a
// second one exists alongside RoomView's memoized instance, which is exactly the kind
// of console warning Next's dev overlay surfaces as an "Issue" badge. Caching the
// client module-level makes every call site share one instance for free, with no
// call-site changes needed.
let cached: SupabaseClient | null = null;

export function createClient() {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local"
    );
  }

  if (!cached) cached = createBrowserClient(url!, anonKey!);
  return cached;
}
