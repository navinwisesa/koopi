"use client";

import { useCallback, useEffect, useState } from "react";
import { type Carpet, DEFAULT_CARPET, parseCarpet } from "@/lib/accountCarpet";

async function readResponse(response: Response): Promise<Carpet | null> {
  let body;
  try { body = await response.json(); } catch { throw new Error("Couldn't reach your account. Please retry."); }
  if (!response.ok) throw new Error(body.error || "Couldn't reach your account. Please retry.");
  return parseCarpet(body.carpet);
}

export function useAccountCarpet(userId: string, initialCarpet?: Carpet | null) {
  const [carpet, setCarpet] = useState<Carpet>(initialCarpet ?? DEFAULT_CARPET);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setError("");
    setCarpet(initialCarpet ?? DEFAULT_CARPET);
    async function load() {
      try {
        const account = await readResponse(await fetch("/api/account/carpet", { cache: "no-store", signal: controller.signal }));
        if (controller.signal.aborted) return;
        setCarpet(account ?? DEFAULT_CARPET);
        if (!account) {
          // Import the old device value once. It is never the source of truth
          // after migration; an existing account value always wins.
          let legacy: Carpet | null = null;
          try { legacy = parseCarpet(JSON.parse(localStorage.getItem(`koopi:carpet:${userId}`) ?? "null")); } catch { /* No legacy value. */ }
          if (legacy) {
            setCarpet(legacy);
            try {
              const migrated = await readResponse(await fetch("/api/account/carpet", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...legacy, migrate: true }), signal: controller.signal }));
              if (!controller.signal.aborted && migrated) {
                setCarpet(migrated);
                try { localStorage.removeItem(`koopi:carpet:${userId}`); } catch { /* Account save already succeeded. */ }
              }
            } catch (err) {
              if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't import your previous carpet. Save it to retry.");
            }
          }
        }
        if (!controller.signal.aborted) setReady(true);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't load your carpet. Please retry.");
      }
    }
    void load();
    return () => controller.abort();
  }, [userId, retry, initialCarpet]);

  const save = useCallback(async (value: Carpet) => {
    setSaving(true);
    setError("");
    try {
      const saved = await readResponse(await fetch("/api/account/carpet", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }));
      if (!saved) throw new Error("The account returned invalid carpet settings. Please retry.");
      setCarpet(saved);
      try { localStorage.removeItem(`koopi:carpet:${userId}`); } catch { /* Account is the source of truth. */ }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your carpet. Please retry.");
      return false;
    } finally { setSaving(false); }
  }, [userId]);

  return { carpet, ready, saving, error, save, reload: () => setRetry(value => value + 1) };
}
