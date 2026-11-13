"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Trash2 } from "lucide-react";
import type { RoomView } from "@/components/DashboardRooms";
import { createClient } from "@/lib/supabase/client";
import styles from "./RoomClubhouse.module.css";

export default function WorldRoomDirectory({ rooms, userId }: { rooms: RoomView[]; userId: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      const { error: failure } = await createClient().from("rooms").delete().eq("id", id);
      if (failure) throw failure;
      setConfirm(null);
      router.refresh();
    } catch { setError("Couldn't delete this room. Please retry."); }
    finally { setBusy(false); }
  }
  return <details className={styles.directory}>
    <summary>Room directory · jump straight in</summary>
    <ul>{rooms.map(room => <li key={room.id}>
      {confirm === room.id ? <div className={styles.deleteConfirmation}>
        <p>Delete <strong>{room.name}</strong>? Its threads, messages and files will be permanently deleted.</p>
        <div className="mt-2 flex gap-2"><button type="button" className={styles.secondary} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => void remove(room.id)}>{busy ? "Deleting…" : "Delete room"}</button></div>
      </div> : <div className="flex items-center gap-3">
        <Link href={`/room/${room.id}`} className="min-w-0 flex-1">{room.name}<ArrowRight size={15} aria-hidden="true" /></Link>
        {room.createdBy === userId && <button type="button" className={styles.directoryDelete} aria-label={`Delete ${room.name}`} onClick={() => setConfirm(room.id)}><Trash2 size={16} /></button>}
      </div>}
    </li>)}</ul>
    {error && <p role="alert" className="px-6 pb-4 text-sm text-red-400">{error}</p>}
  </details>;
}
