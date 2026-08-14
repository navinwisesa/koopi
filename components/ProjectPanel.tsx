"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import {
  Play,
  Square,
  Save,
  AlertTriangle,
  FilePlus,
  Trash2,
  Pencil,
  FileCode,
  Folder,
  FolderOpen,
  ChevronRight,
  Bot,
  Code2,
  GitPullRequest,
  ChevronDown,
  ChevronUp,
  Crown,
  Shield,
  User as UserIcon,
  Lock,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember, ProjectFile, ProjectRunState, RoomRole } from "@/components/RoomView";
import ProjectAssistant from "@/components/ProjectAssistant";
import ProjectChanges from "@/components/ProjectChanges";
import ProjectTerminal from "@/components/ProjectTerminal";

// CodeMirror touches browser globals at mount time — must never render on the
// server. Same constraint CodePanel had, unchanged here.
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

const LANGUAGES = ["python", "javascript", "typescript", "bash"] as const;

// Same icon-per-role convention as RoomMembersModal, so the badge here and
// the one in the members list read as the same concept.
const ROLE_ICON: Record<RoomRole, typeof Crown> = {
  owner: Crown,
  admin: Shield,
  member: UserIcon,
};

function extensionsFor(language: string) {
  switch (language.toLowerCase()) {
    case "python":
      return [python()];
    case "javascript":
      return [javascript()];
    case "typescript":
      return [javascript({ typescript: true })];
    default:
      return [];
  }
}

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py":
      return "python";
    case "js":
    case "mjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "sh":
      return "bash";
    default:
      return "python";
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
}) {
  const sortedFiles = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);
  const [selectedId, setSelectedId] = useState<string | null>(sortedFiles[0]?.id ?? null);
  useEffect(() => {
    if (selectedId && sortedFiles.some((f) => f.id === selectedId)) return;
    setSelectedId(sortedFiles[0]?.id ?? null);
  }, [sortedFiles, selectedId]);

  const selectedFile = sortedFiles.find((f) => f.id === selectedId) ?? null;

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

  const [draft, setDraft] = useState(selectedFile?.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
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
  // importDroppedFiles below.
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"editor" | "changes">("editor");
  // Docked assistant drawer within the Editor tab — replaces the old
  // standalone "Assistant" tab (usability review: two competing "talk to
  // AI" surfaces, room chat and this, was confusing). Same underlying
  // ProjectAssistant component/behavior, just relocated; not tied to
  // whether a file is selected, so the empty-state "ask the assistant"
  // hint below can open it too.
  const [assistantOpen, setAssistantOpen] = useState(false);

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

  async function createFile() {
    const path = newFilePath.trim();
    if (!path) return;
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

  const isRunning = runState.status === "running";

  async function runFile() {
    if (dirty || isRunning || !selectedFile) return;
    try {
      const res = await fetch("/api/projects/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, entryPath: selectedFile.path }),
      });
      if (!res.ok) {
        console.error("ProjectPanel: run request failed", await res.text().catch(() => ""));
      }
    } catch (err) {
      console.error("ProjectPanel: run request failed", err);
    }
    // No local state change — Running…/result arrive via the projects
    // realtime channel, same as every other viewer sees them.
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
          </button>
        </div>

        {isRunning ? (
          <button
            type="button"
            onClick={() => void stopRun()}
            title="Stop the running file"
            className="ml-auto flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/20"
          >
            <Square className="h-3.5 w-3.5" strokeWidth={2} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void runFile()}
            disabled={dirty || !selectedFile}
            title={dirty ? "Save before running" : `Run ${selectedFile?.path ?? ""}`}
            className="ml-auto flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={2} />
            Run
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-36 shrink-0 flex-col border-r border-border">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Files</span>
            <button
              type="button"
              onClick={() => setNewFileOpen((v) => !v)}
              title="New file"
              className="rounded p-0.5 text-muted transition-colors hover:text-foreground"
            >
              <FilePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
          {newFileOpen && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createFile();
              }}
              className="px-2 pb-1.5"
            >
              <input
                autoFocus
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                placeholder="path/to/file.py"
                className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </form>
          )}
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
              if (e.dataTransfer.files.length) void importDroppedFiles(e.dataTransfer.files, "");
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
                    style={{ paddingLeft: 8 + depth * 14 }}
                    className={`group flex items-center gap-1 py-1 pr-2 text-[11px] ${
                      f.id === selectedId ? "bg-accent/10 text-accent" : "text-muted hover:text-foreground"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(f.id)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      title={f.path}
                    >
                      <FileCode className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">{f.path.split("/").pop()}</span>
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
                        if (e.dataTransfer.files.length) void importDroppedFiles(e.dataTransfer.files, folder.path);
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
                for (const file of node.files) rows.push(renderFileRow(file, depth));
                return rows;
              }

              return renderFolder(buildFileTree(sortedFiles), 0);
            })()}
            {sortedFiles.length === 0 && !newFileOpen && (
              <div className="px-2 py-3 text-center">
                <p className="mb-2 text-[11px] text-muted">
                  No files yet — create one, or drag files from your computer here.
                </p>
                <button
                  type="button"
                  onClick={() => setNewFileOpen(true)}
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
              files={sortedFiles}
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
                <button
                  type="button"
                  onClick={() => setAssistantOpen((v) => !v)}
                  title="Ask about this file — private to you until you accept a suggestion"
                  className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                    assistantOpen ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
                  }`}
                >
                  <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Ask about this file
                  {assistantOpen ? (
                    <ChevronUp className="h-3 w-3" strokeWidth={2} />
                  ) : (
                    <ChevronDown className="h-3 w-3" strokeWidth={2} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving || proposing || conflict}
                  title={canWriteDirectly ? "Save (Ctrl/Cmd+S)" : "Propose change (Ctrl/Cmd+S)"}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {saving ? "Saving…" : proposing ? "Proposing…" : canWriteDirectly ? "Save" : "Propose"}
                </button>
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
              <p>
                Create a file, or{" "}
                <button
                  type="button"
                  onClick={() => setAssistantOpen(true)}
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  ask the assistant to generate one
                </button>
                .
              </p>
            </div>
          )}

          {assistantOpen && (
            <div className="flex shrink-0 flex-col border-t border-border" style={{ height: 260 }}>
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-background px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                <Bot className="h-3 w-3" strokeWidth={1.75} />
                Assistant — private to you
              </div>
              <ProjectAssistant
                projectId={projectId}
                files={sortedFiles}
                activeFile={selectedFile}
                currentUserId={currentUserId}
              />
            </div>
          )}

          <ProjectTerminal
            projectId={projectId}
            runState={runState}
            currentUserId={currentUserId}
            memberById={memberById}
          />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
