"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { EditorView } from "@codemirror/view";
import {
  Play,
  Square,
  Save,
  AlertTriangle,
  FilePlus,
  FolderPlus,
  Trash2,
  Pencil,
  FileCode,
  Folder,
  FolderOpen,
  ChevronRight,
  Bot,
  Code2,
  GitPullRequest,
  Crown,
  Shield,
  User as UserIcon,
  Lock,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember, ProjectFile, ProjectRunState, RoomRole } from "@/components/RoomView";
import ProjectChanges from "@/components/ProjectChanges";
import ProjectTerminal from "@/components/ProjectTerminal";
import ProjectPreview from "@/components/ProjectPreview";
import { languageFromPath } from "@/lib/languageFromPath";
import { detectWebAppFramework } from "@/lib/webAppFramework";

// CodeMirror touches browser globals at mount time — must never render on the
// server. Same constraint CodePanel had, unchanged here.
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

const LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "bash",
  "html",
  "css",
  "json",
  "markdown",
] as const;

// Same icon-per-role convention as RoomMembersModal, so the badge here and
// the one in the members list read as the same concept.
const ROLE_ICON: Record<RoomRole, typeof Crown> = {
  owner: Crown,
  admin: Shield,
  member: UserIcon,
};

// lineWrapping applies to every language, not just the switch below — a
// scaffolded web app's HTML in particular is confirmed live to sometimes
// arrive as one genuinely valid, complete, un-formatted line (697 chars, 0
// newlines — matches the live preview exactly, nothing wrong with the
// content itself). Without wrapping, CodeMirror shows only whatever fits
// before the pane's right edge and the rest just scrolls off-screen,
// making a perfectly fine file look empty or broken. Wrapping is strictly
// safer than reformatting the file's actual content server-side would be —
// inserting real newlines into HTML risks introducing visible whitespace
// gaps around adjacent inline elements (e.g. two <button>s written
// side-by-side); this only changes how the existing text is displayed.
function extensionsFor(language: string) {
  switch (language.toLowerCase()) {
    case "python":
      return [python(), EditorView.lineWrapping];
    case "javascript":
      return [javascript(), EditorView.lineWrapping];
    case "typescript":
      return [javascript({ typescript: true }), EditorView.lineWrapping];
    case "html":
      return [html(), EditorView.lineWrapping];
    default:
      return [EditorView.lineWrapping];
  }
}

// Phase 2 (hierarchical folders): project_files.path has supported nested
// segments since it was first created ("flat or nested path (e.g.
// 'src/index.py')" — see 20260815_add_projects.sql's own comment on the
// column) but nothing ever actually rendered that nesting — every file
// landed in one flat, alphabetized list regardless of how many "/"s its
// path had. No new table or column for this: the tree below is derived
// entirely from splitting `path` on "/", same source of truth the flat
// list already used, just organized differently.
//
// There's no standalone "folder" row anywhere in this schema — a folder is
// purely an implication of some file's path containing a "/". That's fine
// for a folder created by dropping/naming a file into it, but "New folder"
// (an explicitly EMPTY folder, nothing in it yet) has nothing to anchor
// its existence to without one. FOLDER_MARKER is that anchor: an empty,
// hidden placeholder file real UNIX tooling has used for the same reason
// for decades — created alongside a new folder, filtered out of every
// visible row (see renderFolder below) but still a real project_files row,
// so the folder keeps existing (and keeps showing up as a real path for
// chooseFileTarget to nest new files into server-side) even with nothing
// "real" in it yet.
const FOLDER_MARKER = ".gitkeep";

type FileTreeFolder = {
  name: string;
  path: string; // full path from the project root, e.g. "src/utils" — "" for the root
  folders: FileTreeFolder[];
  files: ProjectFile[];
};

function buildFileTree(files: ProjectFile[]): FileTreeFolder {
  const root: FileTreeFolder = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue; // defensive: a path that's only slashes has nothing to show
    let node = root;
    let currentPath = "";
    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      let child = node.folders.find((f) => f.name === seg);
      if (!child) {
        child = { name: seg, path: currentPath, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  (function sortNode(n: FileTreeFolder) {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    n.folders.forEach(sortNode);
  })(root);
  return root;
}

// Suffixes _2, _3, ... on a collision within the SAME folder — client-side
// mirror of chooseFileTarget's uniquePath() in app/api/chat/route.ts, kept
// separate since this one only ever needs to avoid other files already in
// `existingPaths`, not ask an LLM anything.
function uniqueImportPath(desired: string, existingPaths: string[]): string {
  if (!existingPaths.includes(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const slash = desired.lastIndexOf("/");
  const dir = slash === -1 ? "" : desired.slice(0, slash + 1);
  const base = dot === -1 || dot < slash ? desired.slice(slash + 1) : desired.slice(slash + 1, dot);
  const ext = dot === -1 || dot < slash ? "" : desired.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${dir}${base}_${i}${ext}`;
    if (!existingPaths.includes(candidate)) return candidate;
  }
}

export default function ProjectPanel({
  projectId,
  files,
  runState,
  currentUserId,
  currentUserRole = "member",
  memberById,
  // False for a Member (see 20260817_add_room_roles_and_approval.sql) —
  // edits are proposed instead of applied directly. This prop is only ever
  // advisory for what the UI offers; project_files' own RLS UPDATE policy
  // is the actual gate, so a stale/wrong value here fails safely (a save
  // attempt is just rejected server-side, never silently allowed).
  canWriteDirectly = true,
  onProposeChange,
  // RoomView needs to know which file (if any) is open so it can tell
  // /api/chat — that's the signal chooseFileTarget uses server-side to
  // decide "continue this file" vs. "unrelated task, make a new one" (see
  // app/api/chat/route.ts). Fired on every selection change, not just
  // user-initiated ones, so it stays correct through auto-selection (e.g.
  // the first file being selected on mount) too.
  onActiveFileChange,
  // Opens (or creates, if none exists yet for this file) a private,
  // file-scoped thread in the room's normal chat directory — replaces the
  // old docked "Assistant" drawer. RoomView owns thread state, so this is
  // just a callback up to it, same shape onProposeChange already is.
  onDiscussFile,
}: {
  projectId: string;
  files: ProjectFile[];
  runState: ProjectRunState;
  currentUserId: string;
  currentUserRole?: RoomRole;
  memberById: Map<string, RoomMember>;
  canWriteDirectly?: boolean;
  onProposeChange?: (file: ProjectFile, proposedContent: string) => Promise<void>;
  onActiveFileChange?: (file: ProjectFile | null) => void;
  onDiscussFile?: (file: ProjectFile) => void;
}) {
  const sortedFiles = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);
  // Everywhere that isn't the tree itself (selection, the editor, what
  // ProjectChanges sees) should never know FOLDER_MARKER
  // rows exist at all — they're an implementation detail of how an empty
  // folder stays represented (see FOLDER_MARKER's own comment), not
  // something a person could meaningfully open, propose a change to, or
  // have Koopi reason about. Only buildFileTree(sortedFiles) (unfiltered)
  // needs to see them, to keep detecting the folder they anchor.
  const visibleFiles = useMemo(
    () => sortedFiles.filter((f) => !f.path.endsWith(`/${FOLDER_MARKER}`) && f.path !== FOLDER_MARKER),
    [sortedFiles]
  );

  // Phase 3: role-aware live change notifications. canReviewChanges gates
  // not just the badge/toast UI but whether this effect below even fetches
  // or subscribes at all — a Member's client never asks for the pending
  // queue in the first place, on top of (not instead of) the RLS policy
  // that would only ever hand them their own rows anyway. Kept independent
  // of ProjectChanges' own realtime subscription (same table, unfiltered,
  // same "check membership client-side after the fact" shape) rather than
  // lifting that component's state up, so it stays visible from the Editor
  // tab where ProjectChanges isn't even mounted — that's the actual gap
  // this phase closes: the Pending panel already updated live, just only
  // for someone already looking at it.
  const canReviewChanges = currentUserRole === "owner" || currentUserRole === "admin";
  const fileIds = useMemo(() => files.map((f) => f.id), [files]);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const [pendingChangeIds, setPendingChangeIds] = useState<Set<string>>(new Set());
  const [changeToast, setChangeToast] = useState<string | null>(null);
  const changeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!canReviewChanges || fileIds.length === 0) {
      setPendingChangeIds(new Set());
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    void supabase
      .from("project_file_changes")
      .select("id, project_file_id, status")
      .in("project_file_id", fileIds)
      .eq("status", "pending")
      .then(({ data }) => {
        if (!cancelled && data) setPendingChangeIds(new Set(data.map((r) => r.id as string)));
      });

    const channel = supabase
      .channel(`project-pending-badge:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_file_changes" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown> | null;
          const id = row?.id as string | undefined;
          const fileId = row?.project_file_id as string | undefined;
          if (!id || !fileId || !fileIds.includes(fileId)) return;
          const status = row?.status as string | undefined;

          if (payload.eventType === "DELETE" || status !== "pending") {
            setPendingChangeIds((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            return;
          }

          setPendingChangeIds((prev) => {
            if (prev.has(id)) return prev;
            return new Set(prev).add(id);
          });

          // Only a genuinely NEW pending proposal toasts, not every update
          // to the row (a summary landing a moment later shouldn't re-toast
          // the same change) — INSERT is the one event type that always
          // means "this proposal didn't exist a moment ago".
          if (payload.eventType === "INSERT") {
            const proposedBy = row?.proposed_by as string | null;
            const who = proposedBy ? (memberById.get(proposedBy)?.username ?? "Someone") : "Koopi";
            const path = fileById.get(fileId)?.path ?? "a file";
            setChangeToast(`${who} proposed a change to ${path}`);
            if (changeToastTimerRef.current) clearTimeout(changeToastTimerRef.current);
            changeToastTimerRef.current = setTimeout(() => setChangeToast(null), 6000);
          }
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
    // memberById/fileById are stable-ish maps derived from props each
    // render — deliberately excluded so this doesn't resubscribe on every
    // parent re-render, only when the actual project/file-id-set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReviewChanges, projectId, fileIds]);

  // Highlights a file directly in the tree when it has a pending proposal —
  // distinct from pendingChangeIds above, which is deliberately Owner/Admin-
  // only (it drives the review-queue badge/toast, not relevant to a Member
  // who isn't reviewing anything). This one is for the PROPOSER's own
  // benefit too: a Member scaffolding something new should see right in the
  // Editor tab that "index.js" is sitting there pending, not just discover
  // it by clicking into Changes. Deliberately unrestricted by role — RLS on
  // project_file_changes ("own proposals or admin/owner can read") already
  // scopes this correctly on its own: a Member's query naturally only ever
  // gets their own pending rows back, an Owner/Admin's gets everyone's.
  const [pendingFileIds, setPendingFileIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (fileIds.length === 0) {
      setPendingFileIds(new Set());
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    void supabase
      .from("project_file_changes")
      .select("project_file_id")
      .in("project_file_id", fileIds)
      .eq("status", "pending")
      .then(({ data }) => {
        if (!cancelled && data) setPendingFileIds(new Set(data.map((r) => r.project_file_id as string)));
      });

    const channel = supabase
      .channel(`project-pending-tree:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_file_changes" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown> | null;
          const fileId = row?.project_file_id as string | undefined;
          if (!fileId || !fileIds.includes(fileId)) return;
          const status = row?.status as string | undefined;

          if (payload.eventType === "DELETE" || status !== "pending") {
            // Another pending row for the same file might still exist —
            // re-check rather than assume this was the only one.
            void supabase
              .from("project_file_changes")
              .select("id")
              .eq("project_file_id", fileId)
              .eq("status", "pending")
              .limit(1)
              .then(({ data }) => {
                if (cancelled) return;
                setPendingFileIds((prev) => {
                  const stillPending = Boolean(data?.length);
                  if (stillPending === prev.has(fileId)) return prev;
                  const next = new Set(prev);
                  if (stillPending) next.add(fileId);
                  else next.delete(fileId);
                  return next;
                });
              });
            return;
          }

          setPendingFileIds((prev) => (prev.has(fileId) ? prev : new Set(prev).add(fileId)));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [projectId, fileIds]);

  const [selectedId, setSelectedId] = useState<string | null>(visibleFiles[0]?.id ?? null);
  useEffect(() => {
    if (selectedId && visibleFiles.some((f) => f.id === selectedId)) return;
    setSelectedId(visibleFiles[0]?.id ?? null);
  }, [visibleFiles, selectedId]);

  const selectedFile = visibleFiles.find((f) => f.id === selectedId) ?? null;

  useEffect(() => {
    onActiveFileChange?.(selectedFile);
    // Re-fires on the SELECTION changing, and also on the selected file's
    // own path changing (a rename — see renameFile below) since RoomView
    // forwards this straight through to /api/chat as openFilePath, and a
    // stale pre-rename path there would silently break chooseFileTarget's
    // "currently open file" match. Deliberately NOT keyed on content edits
    // beyond that — selectedFile is a fresh object each render via .find(),
    // so re-running on every keystroke would defeat the point of scoping
    // this to id/path. onActiveFileChange itself is intentionally excluded
    // too, since RoomView passes a plain setState function whose identity
    // is already stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.id, selectedFile?.path]);

  // "X is working on Y" (PDF §3 async coordination) — Supabase's Presence
  // API specifically, not a plain broadcast: presence auto-syncs the FULL
  // current state to anyone who joins the channel late (someone who opens
  // the Project panel after a teammate already has a file open still sees
  // them immediately), which a raw broadcast — only ever seen by clients
  // already subscribed at the moment it fires — can't do on its own.
  //
  // One channel per project, created here; `presenceChannel` only flips
  // from null once SUBSCRIBED actually fires (track() before that point
  // silently does nothing per the Supabase JS client), which is also what
  // the second effect below waits on before ever calling track() itself.
  const [viewersByPath, setViewersByPath] = useState<Map<string, string[]>>(new Map());
  const [presenceChannel, setPresenceChannel] = useState<ReturnType<
    ReturnType<typeof createClient>["channel"]
  > | null>(null);
  const currentUsername = memberById.get(currentUserId)?.username ?? "Someone";

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`project:${projectId}:presence`, {
      config: { presence: { key: currentUserId } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ path: string | null; username: string }>();
        const map = new Map<string, string[]>();
        for (const [userId, presences] of Object.entries(state)) {
          if (userId === currentUserId) continue; // never show yourself as "another viewer"
          const latest = presences[presences.length - 1];
          if (!latest?.path) continue;
          const list = map.get(latest.path) ?? [];
          list.push(latest.username);
          map.set(latest.path, list);
        }
        setViewersByPath(map);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setPresenceChannel(channel);
      });

    return () => {
      setPresenceChannel(null);
      void supabase.removeChannel(channel);
    };
  }, [projectId, currentUserId]);

  // Re-tracks on the SAME channel from above whenever the selection or
  // username changes — fires once right away too, the moment
  // presenceChannel flips from null (the channel's own initial track()).
  useEffect(() => {
    if (!presenceChannel) return;
    void presenceChannel.track({ path: selectedFile?.path ?? null, username: currentUsername });
  }, [presenceChannel, selectedFile?.path, currentUsername]);

  const [draft, setDraft] = useState(selectedFile?.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Collapsible files tree — the panel is already tight on mobile (now a
  // full-screen overlay, see RoomView's own mobile-panel comment) where the
  // 144px file list eats real editor width; defaults open since that's the
  // existing, familiar layout on desktop.
  const [filesSidebarOpen, setFilesSidebarOpen] = useState(true);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  // Same single-active-input shape as newFileOpen/newFilePath, kept as its
  // own pair rather than a shared "mode" flag so opening one always closes
  // the other without extra bookkeeping (see the two toggle buttons below).
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  // WHERE the open input renders in the tree — set once when opened (see
  // openNewFile/openNewFolder), separate from newFilePath/newFolderPath's
  // actual text, which the person can go on to edit freely (including
  // retyping the folder part entirely). "" positions it at the very top of
  // the panel, above the tree (root has no folder row of its own to render
  // under); any other value renders it as a child row directly under that
  // folder, so it appears where the new item is actually about to go
  // instead of always at the top regardless of which folder was targeted.
  const [newItemTargetFolder, setNewItemTargetFolder] = useState("");
  // Inline rename — only one file can be mid-rename at a time, same
  // single-active-editor-state pattern as newFileOpen/newFilePath above.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  // Tracks COLLAPSED folders rather than expanded ones, deliberately: a
  // brand-new folder (created by a drag-drop import, or by Koopi writing
  // its first file into one) then defaults to expanded with no extra
  // bookkeeping to backfill — it's just absent from this set, same as
  // every other folder nobody's touched yet.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  function toggleFolder(path: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  // Which folder (by path, "" for the root drop zone) a drag is currently
  // over — drives the highlight only, drop handling itself lives in
  // importDroppedFiles/moveFile below.
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // Set only while dragging an EXISTING project file within the tree (to
  // move it into a folder) — distinguishes that from dragging real OS files
  // in from outside, which land in the exact same onDrop handlers below.
  // Component state rather than reading it back out of e.dataTransfer:
  // this is a same-window drag, and dataTransfer's custom data isn't
  // readable during dragover (only on drop), which is too late to tell the
  // two cases apart before the drop actually happens.
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null);
  // Right-click menu — null when closed. folderPath is "" for the root
  // (right-clicked blank space or a file row) or a specific folder's path
  // (right-clicked that folder's own row, via its own onContextMenu below).
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; folderPath: string } | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    function close() {
      setContextMenu(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // Any click anywhere closes it — including the click that picks a menu
    // item, which is fine: that click's own handler (below) runs first and
    // does its own thing before this listener tears the menu down.
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);
  const [rightTab, setRightTab] = useState<"editor" | "changes">("editor");

  const savedContentRef = useRef(selectedFile?.content ?? "");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Switching the selected file resets the editor to that file's saved
  // content — deliberately not preserving cross-file drafts (same
  // single-active-draft model as before, just per-file now).
  useEffect(() => {
    savedContentRef.current = selectedFile?.content ?? "";
    setDraft(selectedFile?.content ?? "");
    setDirty(false);
    setConflict(false);
    setNotice(null);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setDirty(draft !== savedContentRef.current);
  }, [draft]);

  // Detects an incoming realtime update to the file currently open — either
  // someone else's edit (or an approved change landing) or the echo of our
  // own save.
  const justSavedAtRef = useRef<string | null>(null);
  const prevUpdatedAtRef = useRef<string | undefined>(selectedFile?.updatedAt);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const incoming = selectedFile?.updatedAt;
    if (incoming === prevUpdatedAtRef.current) return;
    const wasOwnSave = incoming !== undefined && incoming === justSavedAtRef.current;
    prevUpdatedAtRef.current = incoming;
    if (wasOwnSave || !selectedFile) return;

    const who =
      selectedFile.lastEditedBy === null
        ? "Koopi"
        : selectedFile.lastEditedBy === currentUserId
          ? "You, in another tab,"
          : (memberById.get(selectedFile.lastEditedBy)?.username ?? "Someone");
    setNotice(`${who} just updated this file`);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);

    if (dirtyRef.current) {
      setConflict(true);
    } else {
      savedContentRef.current = selectedFile.content;
      setDraft(selectedFile.content);
    }
  }, [selectedFile, currentUserId, memberById]);

  async function save() {
    if (saving || proposing || !selectedFile) return;
    if (!canWriteDirectly) {
      if (!onProposeChange) return;
      setProposing(true);
      try {
        await onProposeChange(selectedFile, draft);
        setNotice("Proposed — waiting on an admin/owner to review");
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
        // Not applying draft to savedContentRef — the live file hasn't
        // actually changed, only a pending proposal now exists for it.
        setDirty(false);
      } finally {
        setProposing(false);
      }
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("project_files")
      .update({
        content: draft,
        last_edited_by: currentUserId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", selectedFile.id)
      .select("updated_at")
      .single();
    setSaving(false);
    if (error) {
      console.error("ProjectPanel: failed to save project_files", error);
      return;
    }
    justSavedAtRef.current = (data?.updated_at as string | undefined) ?? null;
    savedContentRef.current = draft;
    setDirty(false);
    setConflict(false);
  }

  // Autosave — direct-write users (owner/admin) get a debounced write
  // shortly after typing pauses, without needing to reach for the Save
  // button or Ctrl/Cmd+S below at all; those remain as an explicit,
  // discoverable "save right now" action for anyone who wants to trigger
  // (or just confirm) a save immediately instead of waiting/trusting it's
  // happening in the background — this effect and that button both
  // ultimately just call save(), so there's nothing to keep in sync between
  // them. Deliberately NOT extended to the propose path (non-owner/admin):
  // every save() there inserts a fresh project_file_changes row and kicks
  // off an AI summary (see RoomView's proposeProjectFileChange) —
  // autosaving on every pause in typing would flood the pending-changes
  // list and burn a model call per pause instead of per deliberate "here's
  // my change", so that path keeps its explicit, manual-only Propose button.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!canWriteDirectly || !dirty || conflict) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save();
    }, 800);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, canWriteDirectly, conflict]);

  // Switching files resets the editor to the newly-selected file's content
  // (see the [selectedId] effect above) — without this, a still-pending
  // autosave debounce would simply be abandoned and the last few keystrokes
  // silently lost. Flushes synchronously against the file being left,
  // before the click's own setSelectedId(f.id) below fires.
  function selectFile(id: string) {
    if (canWriteDirectly && dirtyRef.current) {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      void save();
    }
    setSelectedId(id);
  }

  function discardMine() {
    if (!selectedFile) return;
    savedContentRef.current = selectedFile.content;
    setDraft(selectedFile.content);
    setDirty(false);
    setConflict(false);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (conflict) return;
        void save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict, draft, selectedId, canWriteDirectly]);

  // Prefixes name with newItemTargetFolder — the input itself only ever
  // holds the bare name being typed (see openNewFile/openNewFolder below),
  // not a "folder/" prefix baked into the editable text; the target
  // folder is already conveyed by where the form is positioned in the
  // tree (see renderFolder), so repeating it as literal text in the input
  // was redundant clutter, not information the person actually needed to
  // read or could usefully edit. Still supports typing further "/"s of
  // their own, for nesting deeper than the target folder in one go.
  function withTargetFolder(name: string): string {
    return newItemTargetFolder ? `${newItemTargetFolder}/${name}` : name;
  }

  async function createFile() {
    const name = newFilePath.trim();
    if (!name) return;
    const path = withTargetFolder(name);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("project_files")
      .insert({
        project_id: projectId,
        path,
        content: "",
        language: languageFromPath(path),
        last_edited_by: currentUserId,
      })
      .select("id")
      .single();
    if (error) {
      console.error("ProjectPanel: failed to create project_files row", error);
      return;
    }
    setNewFilePath("");
    setNewFileOpen(false);
    if (data?.id) setSelectedId(data.id);
  }

  // Creates an EMPTY folder by inserting FOLDER_MARKER at its path — see
  // that constant's own comment for why. Never selects the marker row
  // (unlike createFile, which selects the file it just made) — there's
  // nothing meaningful to open, it's not a real file the person asked for.
  async function createFolder() {
    const raw = newFolderPath.trim();
    // A trailing slash reads as "make the folder itself", which is exactly
    // what's happening — strip it so path + "/" + marker below doesn't
    // double up.
    const name = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!name) return;
    const path = withTargetFolder(name);
    const supabase = createClient();
    const { error } = await supabase.from("project_files").insert({
      project_id: projectId,
      path: `${path}/${FOLDER_MARKER}`,
      content: "",
      language: "python",
      last_edited_by: currentUserId,
    });
    if (error) {
      console.error("ProjectPanel: failed to create folder", error);
      return;
    }
    setNewFolderPath("");
    setNewFolderOpen(false);
  }

  // Opens the new-file/new-folder input targeting folderPath — shared by
  // the toolbar buttons (always folderPath "") and the right-click menu
  // (folderPath is whichever folder was right-clicked, "" for blank
  // space/a file row). Always starts empty: the target folder is conveyed
  // by where the form renders (see renderFolder/newItemTargetFolder) and
  // applied automatically at creation time (see withTargetFolder above),
  // not by pre-filling it into text the person would otherwise have to
  // read past or clear.
  // A collapsed folder's children (including the eventual new-item form
  // rendered as one of them, see renderFolder) never get rendered at all —
  // opening the form for a folder the person can't currently see into
  // would silently do nothing visible, so make sure it's expanded first.
  function expandFolder(folderPath: string) {
    if (!folderPath) return;
    setCollapsedFolders((prev) => (prev.has(folderPath) ? new Set([...prev].filter((p) => p !== folderPath)) : prev));
  }

  function openNewFile(folderPath: string) {
    setContextMenu(null);
    setNewFolderOpen(false);
    setNewFilePath("");
    setNewItemTargetFolder(folderPath);
    expandFolder(folderPath);
    setNewFileOpen(true);
  }
  function openNewFolder(folderPath: string) {
    setContextMenu(null);
    setNewFileOpen(false);
    setNewFolderPath("");
    setNewItemTargetFolder(folderPath);
    expandFolder(folderPath);
    setNewFolderOpen(true);
  }

  async function deleteFile(file: ProjectFile) {
    const supabase = createClient();
    const { error } = await supabase.from("project_files").delete().eq("id", file.id);
    if (error) console.error("ProjectPanel: failed to delete project_files row", error);
  }

  function startRename(file: ProjectFile) {
    setRenameError(null);
    setRenamingId(file.id);
    setRenameDraft(file.path);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft("");
    setRenameError(null);
  }

  // Direct write, same as the language <select> above and unlike
  // content edits (save()) — path/language are metadata, not the reviewable
  // content itself, so they've never gone through the canWriteDirectly /
  // onProposeChange approval path; project_files' own RLS UPDATE policy is
  // still the real gate for who's allowed to, same "advisory client" pattern
  // documented on canWriteDirectly above.
  async function renameFile(file: ProjectFile) {
    const path = renameDraft.trim();
    if (!path || path === file.path) {
      cancelRename();
      return;
    }
    const supabase = createClient();
    const { error } = await supabase
      .from("project_files")
      .update({ path })
      .eq("id", file.id);
    if (error) {
      // 23505 = unique_violation — project_files has a (project_id, path)
      // uniqueness constraint (the same one chooseFileTarget's uniquePath()
      // avoids colliding with server-side), so renaming onto an existing
      // filename lands here rather than silently overwriting that file.
      console.error("ProjectPanel: failed to rename project_files row", error);
      setRenameError(
        error.code === "23505" ? "A file with that name already exists." : "Couldn't rename that file."
      );
      return;
    }
    cancelRename();
  }

  // Drag-and-drop import (Phase 2): reads each dropped OS file as text and
  // creates a project_files row for it at targetFolder + its own name.
  // Text-only by construction — project_files.content is a text column
  // (same as every file Koopi or a person creates by hand already is), so
  // dropping an actual binary (an image, say) isn't a supported case here;
  // that's what Phase 1's message attachments are for, a deliberately
  // separate feature with its own storage.
  async function importDroppedFiles(fileList: FileList, targetFolder: string) {
    const existingPaths = files.map((f) => f.path);
    const supabase = createClient();
    for (const raw of Array.from(fileList)) {
      let content: string;
      try {
        content = await raw.text();
      } catch (err) {
        console.error(`ProjectPanel: failed to read dropped file ${raw.name}`, err);
        continue;
      }
      const desired = targetFolder ? `${targetFolder}/${raw.name}` : raw.name;
      const path = uniqueImportPath(desired, existingPaths);
      existingPaths.push(path); // so two files dropped in the same batch don't collide with each other
      const { error } = await supabase.from("project_files").insert({
        project_id: projectId,
        path,
        content,
        language: languageFromPath(path),
        last_edited_by: currentUserId,
      });
      if (error) console.error(`ProjectPanel: failed to import dropped file ${raw.name}`, error);
    }
  }

  // Moving an EXISTING project file into a folder by dragging it (as
  // opposed to importDroppedFiles above, which is for real OS files dragged
  // in from outside) — both land in the same onDrop handlers below, told
  // apart by whether draggingFileId is set. Just a path rewrite, same
  // direct-write shape renameFile already uses (path is metadata, not
  // reviewable content); collisions are avoided up front here rather than
  // surfaced as an error afterward, since there's no input field for a
  // drag-drop move to show one in.
  async function moveFile(fileId: string, targetFolder: string) {
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    const basename = file.path.split("/").pop() ?? file.path;
    const desired = targetFolder ? `${targetFolder}/${basename}` : basename;
    if (desired === file.path) return; // already there — dropped a file back into its own folder
    const path = uniqueImportPath(
      desired,
      files.filter((f) => f.id !== fileId).map((f) => f.path)
    );
    const supabase = createClient();
    const { error } = await supabase.from("project_files").update({ path }).eq("id", fileId);
    if (error) console.error(`ProjectPanel: failed to move ${file.path} to ${path}`, error);
  }

  const isRunning = runState.status === "running";

  // A "web app" project (package.json, or a .html file with no
  // package.json — see lib/webAppFramework.ts) is served, not executed to
  // completion — Run always re-serves the whole app via
  // /api/projects/run-webapp regardless of which file happens to be
  // selected, never tries to `node`-execute a .jsx file standalone.
  const webAppFramework = useMemo(() => detectWebAppFramework(files), [files]);
  const isPreviewBusy = runState.previewStatus === "starting";

  // Purely client-side, set the instant Run/Restart is clicked — every
  // "real" busy signal (previewStatus/status flipping to starting/running)
  // only exists once the server round-trip lands, and that round-trip
  // itself (POST /api/projects/run(-webapp) → CAS-claim → realtime update
  // reaching this client) was confirmed live to take a couple of visibly
  // silent seconds with nothing on screen acknowledging the click at all —
  // exactly the "freezes with no sign" gap. This closes it: the button
  // reacts on the same tick as the click, not once the network catches up.
  const [justClicked, setJustClicked] = useState(false);
  const startingSafetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Clear as soon as the server confirms — either a real run/preview is
    // now underway (isRunning / previewStatus no longer idle) or it already
    // finished/failed before this client even saw "starting" in between.
    if (isRunning || runState.previewStatus !== "idle") {
      setJustClicked(false);
      if (startingSafetyTimer.current) clearTimeout(startingSafetyTimer.current);
    }
  }, [isRunning, runState.previewStatus]);
  useEffect(() => {
    return () => {
      if (startingSafetyTimer.current) clearTimeout(startingSafetyTimer.current);
    };
  }, []);

  // Confirmed live: a preview sandbox's expiry used to renew ONLY on an
  // explicit Run/Restart click — someone just using the live demo tab
  // (never touching Koopi itself) generated zero traffic back here, so the
  // clock lapsed under nothing but normal use, the sandbox became
  // unreachable, and the next click created a fresh one on a fresh
  // subdomain — a different origin, wiping every bit of that demo's
  // client-side state (a "logged in" member session included). This keeps
  // renewing it every few minutes for as long as this panel stays open on
  // a running preview, same idea as lib/presence.ts's heartbeat for room
  // presence. 5 minutes leaves wide margin under WEBAPP_SANDBOX_TIMEOUT_MS
  // (1 hour) even if a tick or two drops. Best-effort/fire-and-forget — a
  // failed renew here isn't shown anywhere; the next real Run already
  // handles recreating a dead sandbox regardless.
  useEffect(() => {
    if (!webAppFramework || runState.previewStatus !== "running") return;
    const ping = () => {
      void fetch("/api/projects/preview-heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      }).catch(() => {});
    };
    const id = setInterval(ping, 5 * 60_000);
    return () => clearInterval(id);
  }, [webAppFramework, runState.previewStatus, projectId]);

  async function runFile() {
    if (webAppFramework) {
      if (isPreviewBusy || justClicked) return;
      setJustClicked(true);
      // Safety net — if the realtime update never arrives (dropped
      // subscription, etc.) don't leave the button stuck disabled forever.
      startingSafetyTimer.current = setTimeout(() => setJustClicked(false), 15000);
      try {
        const res = await fetch("/api/projects/run-webapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        if (!res.ok) {
          console.error("ProjectPanel: run-webapp request failed", await res.text().catch(() => ""));
          setJustClicked(false);
        }
      } catch (err) {
        console.error("ProjectPanel: run-webapp request failed", err);
        setJustClicked(false);
      }
      return;
    }

    if (dirty || isRunning || !selectedFile || justClicked) return;
    setJustClicked(true);
    startingSafetyTimer.current = setTimeout(() => setJustClicked(false), 15000);
    try {
      const res = await fetch("/api/projects/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, entryPath: selectedFile.path }),
      });
      if (!res.ok) {
        console.error("ProjectPanel: run request failed", await res.text().catch(() => ""));
        setJustClicked(false);
      }
    } catch (err) {
      console.error("ProjectPanel: run request failed", err);
      setJustClicked(false);
    }
    // Actual Running…/result state still arrives via the projects realtime
    // channel, same as every other viewer sees them — justClicked only
    // covers the gap before that first update lands.
  }

  async function stopRun() {
    const supabase = createClient();
    await supabase
      .from("projects")
      .update({ run_status: "idle" })
      .eq("id", projectId)
      .eq("run_status", "running");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="font-display text-xs font-semibold uppercase tracking-wider text-muted">
          Project
        </span>

        {/* Persistently visible so a Member always knows their standing
            without having to open the Members modal — updates live since
            currentUserRole is derived from RoomView's `members` state,
            which the existing participants realtime subscription already
            keeps fresh. */}
        <span
          title={`Your role in this room: ${currentUserRole}`}
          className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted"
        >
          {(() => {
            const RoleIcon = ROLE_ICON[currentUserRole];
            return <RoleIcon className="h-3 w-3" strokeWidth={1.75} />;
          })()}
          {currentUserRole[0].toUpperCase() + currentUserRole.slice(1)}
        </span>

        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <button
            type="button"
            onClick={() => setRightTab("editor")}
            title="Editor"
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
              rightTab === "editor" ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground"
            }`}
          >
            <Code2 className="h-3 w-3" strokeWidth={1.75} />
            Editor
          </button>
          <button
            type="button"
            onClick={() => setRightTab("changes")}
            title={canWriteDirectly ? "Review pending changes" : "Your proposed changes"}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
              rightTab === "changes" ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground"
            }`}
          >
            <GitPullRequest className="h-3 w-3" strokeWidth={1.75} />
            Changes
            {canReviewChanges && pendingChangeIds.size > 0 && (
              <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-none text-white">
                {pendingChangeIds.size}
              </span>
            )}
          </button>
        </div>

        {webAppFramework ? (
          // No Stop here — a live preview isn't an owner-scoped foreground
          // process like a script run; Run always just (re-)serves the
          // current files, restarting the dev/static server in place.
          // justClicked covers the gap before the server's own "starting"
          // status has had time to reach this client at all — see its
          // definition above for why that gap is otherwise silent.
          <button
            type="button"
            onClick={() => void runFile()}
            disabled={isPreviewBusy || justClicked}
            title={isPreviewBusy || justClicked ? "Starting…" : "Serve this app live"}
            className="ml-auto flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-70"
          >
            {isPreviewBusy || justClicked ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Play className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            {isPreviewBusy || justClicked
              ? "Starting…"
              : runState.previewStatus === "running"
                ? "Restart"
                : "Run"}
          </button>
        ) : isRunning ? (
          <button
            type="button"
            onClick={() => void stopRun()}
            title="Stop the running file"
            className="ml-auto flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/20"
          >
            <Square className="h-3.5 w-3.5" strokeWidth={2} />
            Stop
          </button>
        ) : justClicked ? (
          <button
            type="button"
            disabled
            title="Starting…"
            className="ml-auto flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground opacity-70"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            Starting…
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void runFile()}
            disabled={dirty || !selectedFile}
            title={
              dirty
                ? canWriteDirectly
                  ? "Waiting for autosave…"
                  : "Propose your change first"
                : `Run ${selectedFile?.path ?? ""}`
            }
            className="ml-auto flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={2} />
            Run
          </button>
        )}
      </div>

      {/* Only ever set when canReviewChanges is true (see the subscription
          effect above) — a Member never sees this, for their own change or
          anyone else's, on top of never even fetching the data behind it. */}
      {changeToast && (
        <button
          type="button"
          onClick={() => {
            setRightTab("changes");
            setChangeToast(null);
          }}
          title="Open the Changes tab"
          className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-left text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/15"
        >
          <GitPullRequest className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{changeToast}</span>
        </button>
      )}

      <div className="flex min-h-0 flex-1">
        {!filesSidebarOpen && (
          // Collapsed rail — same width class other icon-only rails in this
          // app use, just enough to hold the reopen affordance without
          // taking any real space back from the editor.
          <button
            type="button"
            onClick={() => setFilesSidebarOpen(true)}
            title="Show files"
            className="flex w-7 shrink-0 flex-col items-center border-r border-border py-2 text-muted transition-colors hover:text-foreground"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
        <div className={`flex w-36 shrink-0 flex-col border-r border-border ${filesSidebarOpen ? "" : "hidden"}`}>
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Files</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => (newFileOpen ? setNewFileOpen(false) : openNewFile(""))}
                title="New file"
                className="rounded p-0.5 text-muted transition-colors hover:text-foreground"
              >
                <FilePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => (newFolderOpen ? setNewFolderOpen(false) : openNewFolder(""))}
                title="New folder"
                className="rounded p-0.5 text-muted transition-colors hover:text-foreground"
              >
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => setFilesSidebarOpen(false)}
                title="Hide files"
                className="rounded p-0.5 text-muted transition-colors hover:text-foreground"
              >
                <PanelLeftClose className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
          <div
            className={`min-h-0 flex-1 overflow-y-auto ${dragOverPath === "" ? "bg-accent/5" : ""}`}
            onDragOver={(e) => {
              e.preventDefault(); // required for onDrop to fire at all
              e.stopPropagation();
              setDragOverPath("");
            }}
            onDragLeave={() => setDragOverPath((p) => (p === "" ? null : p))}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOverPath(null);
              if (draggingFileId) void moveFile(draggingFileId, "");
              else if (e.dataTransfer.files.length) void importDroppedFiles(e.dataTransfer.files, "");
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, folderPath: "" });
            }}
          >
            {(() => {
              // renderFileRow/renderFolder are plain functions called during
              // render (never used as a JSX tag) — a nested COMPONENT
              // declared inside this render body would get a fresh identity
              // every render and force React to remount the whole tree each
              // time, which is exactly what breaks the rename input's focus
              // mid-edit. Calling a function and returning the elements it
              // produces has no such issue: React still reconciles by the
              // keys on those elements, same as the flat .map() this
              // replaced.
              //
              // The open new-file/new-folder input renders wherever
              // newItemTargetFolder says it should (see that state's own
              // comment) rather than always at the top of the panel — this
              // is what actually place it there, called from inside
              // renderFolder below once per node, keyed to that node's own
              // path.
              function renderNewItemForm(depth: number) {
                if (newFileOpen) {
                  return (
                    <form
                      key="new-item-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void createFile();
                      }}
                      className="px-2 pb-1.5"
                      style={{ paddingLeft: 8 + depth * 14 }}
                    >
                      <input
                        autoFocus
                        value={newFilePath}
                        onChange={(e) => setNewFilePath(e.target.value)}
                        placeholder={newItemTargetFolder ? "file.py" : "path/to/file.py"}
                        className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                      />
                    </form>
                  );
                }
                if (newFolderOpen) {
                  return (
                    <form
                      key="new-item-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void createFolder();
                      }}
                      className="px-2 pb-1.5"
                      style={{ paddingLeft: 8 + depth * 14 }}
                    >
                      <input
                        autoFocus
                        value={newFolderPath}
                        onChange={(e) => setNewFolderPath(e.target.value)}
                        placeholder={newItemTargetFolder ? "folder name" : "path/to/folder"}
                        className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                      />
                    </form>
                  );
                }
                return null;
              }

              function renderFileRow(f: ProjectFile, depth: number) {
                if (renamingId === f.id) {
                  return (
                    <div key={f.id} className="flex flex-col gap-0.5 px-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void renameFile(f);
                        }}
                        className="flex items-center gap-1"
                      >
                        <FileCode className="h-3 w-3 shrink-0 text-muted" strokeWidth={1.75} />
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onFocus={(e) => e.target.select()}
                          onBlur={() => void renameFile(f)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          className="w-full min-w-0 rounded border border-accent bg-background px-1 py-0.5 text-[11px] text-foreground focus:outline-none"
                        />
                      </form>
                      {renameError && <p className="pl-4 text-[10px] text-red-500">{renameError}</p>}
                    </div>
                  );
                }
                return (
                  <div
                    key={f.id}
                    draggable
                    onDragStart={(e) => {
                      setDraggingFileId(f.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDraggingFileId(null)}
                    onContextMenu={(e) => {
                      // Right-clicking a file offers the same menu as
                      // right-clicking blank space in its folder — "new"
                      // here means "next to this file", not "on this
                      // file", so it targets the file's OWN containing
                      // folder (everything up to its last "/"), not the
                      // file itself.
                      e.preventDefault();
                      e.stopPropagation();
                      const slash = f.path.lastIndexOf("/");
                      setContextMenu({ x: e.clientX, y: e.clientY, folderPath: slash === -1 ? "" : f.path.slice(0, slash) });
                    }}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    className={`group flex items-center gap-1 py-1 pr-2 text-[11px] ${
                      draggingFileId === f.id ? "opacity-40" : ""
                    } ${f.id === selectedId ? "bg-accent/10 text-accent" : "text-muted hover:text-foreground"}`}
                  >
                    <button
                      type="button"
                      onClick={() => selectFile(f.id)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      title={f.path}
                    >
                      <FileCode className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">{f.path.split("/").pop()}</span>
                      {(() => {
                        const viewers = viewersByPath.get(f.path);
                        return viewers?.length ? (
                          <span
                            title={`${viewers.join(", ")} ${viewers.length === 1 ? "is" : "are"} viewing this`}
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400"
                          />
                        ) : null;
                      })()}
                      {pendingFileIds.has(f.id) && (
                        <span
                          title="Pending review — see Changes"
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => startRename(f)}
                      title="Rename file"
                      className="shrink-0 opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                    >
                      <Pencil className="h-3 w-3" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteFile(f)}
                      title="Delete file"
                      className="shrink-0 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                    </button>
                  </div>
                );
              }

              function renderFolder(node: FileTreeFolder, depth: number): ReactNode[] {
                const rows: ReactNode[] = [];
                for (const folder of node.folders) {
                  const collapsed = collapsedFolders.has(folder.path);
                  rows.push(
                    <div
                      key={`dir:${folder.path}`}
                      style={{ paddingLeft: 8 + depth * 14 }}
                      onClick={() => toggleFolder(folder.path)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverPath(folder.path);
                      }}
                      onDragLeave={() => setDragOverPath((p) => (p === folder.path ? null : p))}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverPath(null);
                        if (draggingFileId) void moveFile(draggingFileId, folder.path);
                        else if (e.dataTransfer.files.length) void importDroppedFiles(e.dataTransfer.files, folder.path);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, folderPath: folder.path });
                      }}
                      className={`flex cursor-pointer items-center gap-1 py-1 pr-2 text-[11px] font-medium text-muted transition-colors hover:text-foreground ${
                        dragOverPath === folder.path ? "bg-accent/10 text-accent" : ""
                      }`}
                    >
                      <ChevronRight
                        className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                        strokeWidth={2}
                      />
                      {collapsed ? (
                        <Folder className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                      ) : (
                        <FolderOpen className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                      )}
                      <span className="truncate">{folder.name}</span>
                    </div>
                  );
                  if (!collapsed) rows.push(...renderFolder(folder, depth + 1));
                }
                for (const file of node.files) {
                  // The marker exists purely to anchor an otherwise-empty
                  // folder's existence (see FOLDER_MARKER above) — never a
                  // real row someone would open, rename, or delete.
                  if (file.path.endsWith(`/${FOLDER_MARKER}`) || file.path === FOLDER_MARKER) continue;
                  rows.push(renderFileRow(file, depth));
                }
                if (newItemTargetFolder === node.path) {
                  const form = renderNewItemForm(depth);
                  if (form) rows.push(form);
                }
                return rows;
              }

              return renderFolder(buildFileTree(sortedFiles), 0);
            })()}
            {visibleFiles.length === 0 && !newFileOpen && !newFolderOpen && (
              <div className="px-2 py-3 text-center">
                <p className="mb-2 text-[11px] text-muted">
                  No files yet — create one, or drag files from your computer here.
                </p>
                <button
                  type="button"
                  onClick={() => openNewFile("")}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground transition-opacity hover:opacity-90"
                >
                  <FilePlus className="h-3 w-3" strokeWidth={2} />
                  New file
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {rightTab === "changes" ? (
            <ProjectChanges
              projectId={projectId}
              files={visibleFiles}
              memberById={memberById}
              currentUserRole={currentUserRole}
            />
          ) : (
            <>
          {notice && !conflict && (
            <div className="shrink-0 border-b border-border bg-background px-4 py-1.5 text-xs text-muted">
              {notice}
            </div>
          )}

          {conflict && (
            <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-amber-500/10 px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                {notice ?? "This file changed"} while you had unsaved edits.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-surface"
                >
                  Keep mine (overwrite)
                </button>
                <button
                  type="button"
                  onClick={discardMine}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-surface"
                >
                  Discard mine, load latest
                </button>
              </div>
            </div>
          )}

          {selectedFile ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="truncate text-xs text-foreground">{selectedFile.path}</span>
                {(() => {
                  const viewers = viewersByPath.get(selectedFile.path);
                  return viewers?.length ? (
                    <span className="flex shrink-0 items-center gap-1 truncate text-[10px] text-blue-400">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
                      {viewers.join(", ")} {viewers.length === 1 ? "is" : "are"} also here
                    </span>
                  ) : null;
                })()}
                {!canWriteDirectly && (
                  <span
                    title="Your edits go to an admin/owner for review before they apply"
                    className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
                  >
                    <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                    Requires approval
                  </span>
                )}
                <select
                  value={selectedFile.language}
                  onChange={async (e) => {
                    const supabase = createClient();
                    await supabase
                      .from("project_files")
                      .update({ language: e.target.value })
                      .eq("id", selectedFile.id);
                  }}
                  className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                {onDiscussFile && (
                  <button
                    type="button"
                    onClick={() => onDiscussFile(selectedFile)}
                    title="Open a private thread about this file — visible only to you, proposed changes still need admin/owner approval"
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
                  >
                    <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Discuss this file
                  </button>
                )}
                {canWriteDirectly ? (
                  // Edits autosave on their own (see the debounced effect
                  // above) — this button is never load-bearing, but a new
                  // person has no reason yet to trust that and shouldn't
                  // have to take it on faith. Clicking it (or Ctrl/Cmd+S)
                  // just force-flushes the pending debounce immediately;
                  // when there's nothing dirty it's a disabled "Saved"
                  // readout instead of disappearing entirely.
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!dirty || saving || conflict}
                    title={
                      conflict
                        ? "Someone else's edit landed while you had unsaved changes — resolve below"
                        : "Edits save automatically as you type — click to save right now (Ctrl/Cmd+S)"
                    }
                    className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-60"
                  >
                    {conflict ? (
                      <>
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.75} />
                        Conflict
                      </>
                    ) : saving ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                        Saving…
                      </>
                    ) : dirty ? (
                      <>
                        <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Save
                      </>
                    ) : (
                      <>
                        <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Saved
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!dirty || proposing || conflict}
                    title="Propose change (Ctrl/Cmd+S)"
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-40"
                  >
                    <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {proposing ? "Proposing…" : "Propose"}
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <CodeMirror
                  value={draft}
                  onChange={(value: string) => setDraft(value)}
                  extensions={extensionsFor(selectedFile.language)}
                  height="100%"
                  theme="dark"
                  basicSetup={{ lineNumbers: true, foldGutter: true }}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center text-xs text-muted">
              <p>Create a file, or ask Koopi in the chat to generate one.</p>
            </div>
          )}

          {webAppFramework ? (
            <ProjectPreview
              runState={runState}
              onRequestFreshLink={runFile}
              freshLinkDisabled={isPreviewBusy || justClicked}
            />
          ) : (
            <ProjectTerminal
              projectId={projectId}
              runState={runState}
              currentUserId={currentUserId}
              memberById={memberById}
            />
          )}
            </>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          // Fixed to the viewport, not this panel — the click coordinates
          // that positioned it (clientX/clientY) are viewport-relative too.
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="fixed z-50 min-w-36 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-xl"
          // The window "click" listener that closes this menu (see the
          // effect above) would otherwise also fire for THIS click and race
          // with the item's own onClick — stopping it here means the
          // item's action always runs before the menu closes, not the
          // other way around.
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => openNewFile(contextMenu.folderPath)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background"
          >
            <FilePlus className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
            New file
          </button>
          <button
            type="button"
            onClick={() => openNewFolder(contextMenu.folderPath)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background"
          >
            <FolderPlus className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
            New folder
          </button>
        </div>
      )}
    </div>
  );
}
