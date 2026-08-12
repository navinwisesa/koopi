"use client";

import { useEffect } from "react";
import { Crown, Shield, User as UserIcon, X } from "lucide-react";
import Avatar from "@/components/Avatar";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember, RoomRole } from "@/components/RoomView";

const ROLE_ICON: Record<RoomRole, typeof Crown> = {
  owner: Crown,
  admin: Shield,
  member: UserIcon,
};

// Promote/demote here is purely a convenience call into
// set_participant_role() — the actual "only the Owner can do this" and
// "the Owner's own role can never change" rules are enforced by that RPC
// and the participants_enforce_role trigger regardless of what this UI
// shows (see 20260817_add_room_roles_and_approval.sql). Rendering the
// dropdown only for `isOwner` just keeps the common case tidy; it's not
// the security boundary.
export default function RoomMembersModal({
  roomId,
  members,
  currentUserId,
  isOwner,
  onClose,
}: {
  roomId: string;
  members: RoomMember[];
  currentUserId: string;
  isOwner: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function changeRole(userId: string, role: "admin" | "member") {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_participant_role", {
      p_room_id: roomId,
      p_user_id: userId,
      p_role: role,
    });
    if (error) console.error("RoomMembersModal: failed to set role", error);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-base font-semibold">Room members</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="max-h-96 space-y-1 overflow-y-auto">
          {members.map((m) => {
            const RoleIcon = ROLE_ICON[m.role];
            return (
              <div key={m.userId} className="flex items-center gap-2.5 rounded-md px-1.5 py-2">
                <Avatar name={m.username} src={m.avatarUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {m.username}
                    {m.userId === currentUserId && <span className="text-muted"> (you)</span>}
                  </p>
                </div>
                {isOwner && m.role !== "owner" ? (
                  <select
                    value={m.role}
                    onChange={(e) => void changeRole(m.userId, e.target.value as "admin" | "member")}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted">
                    <RoleIcon className="h-3 w-3" strokeWidth={1.75} />
                    {m.role[0].toUpperCase() + m.role.slice(1)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
