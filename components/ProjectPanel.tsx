"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import {
  Play,
  Square,
  Save,
  AlertTriangle,
  Terminal,
  FilePlus,
  Trash2,
  FileCode,
  Bot,
  Code2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember, ProjectFile, ProjectRunState } from "@/components/RoomView";
import ProjectAssistant from "@/components/ProjectAssistant";

// CodeMirror touches browser globals at mount time — must never render on the
// server. Same constraint CodePanel had, unchanged here.
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

const LANGUAGES = ["python", "javascript", "typescript", "bash"] as const;

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

export default function ProjectPanel({
  projectId,
  files,
  runState,
  currentUserId,
  memberById,
  // When false (a Member with a pending-approval-only role, see Phase 3),
  // edits/creates/deletes are proposed instead of applied directly. Phase 1
  // has no roles yet, so this always defaults to true — Phase 3 wires the
  // real check in from RoomView without this component needing to know
  // *why* it can't write, only whether it can.
  canWriteDirectly = true,
  onProposeChange,
}: {
  projectId: string;
  files: ProjectFile[];
  runState: ProjectRunState;
  currentUserId: string;
  memberById: Map<string, RoomMember>;
  canWriteDirectly?: boolean;
  onProposeChange?: (file: ProjectFile, proposedContent: string) => Promise<void>;
}) {
  const sortedFiles = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);
  const [selectedId, setSelectedId] = useState<string | null>(sortedFiles[0]?.id ?? null);
  useEffect(() => {
    if (selectedId && sortedFiles.some((f) => f.id === selectedId)) return;
    setSelectedId(sortedFiles[0]?.id ?? null);
  }, [sortedFiles, selectedId]);

  const selectedFile = sortedFiles.find((f) => f.id === selectedId) ?? null;

  const [draft, setDraft] = useState(selectedFile?.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [rightTab, setRightTab] = useState<"editor" | "assistant">("editor");

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
            onClick={() => setRightTab("assistant")}
            title="Per-user coding assistant — private to you until you accept a suggestion"
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
              rightTab === "assistant" ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground"
            }`}
          >
            <Bot className="h-3 w-3" strokeWidth={1.75} />
            Assistant
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sortedFiles.map((f) => (
              <div
                key={f.id}
                className={`group flex items-center gap-1 px-2 py-1 text-[11px] ${
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
                  <span className="truncate">{f.path}</span>
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
            ))}
            {sortedFiles.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-muted">No files yet.</p>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {rightTab === "assistant" ? (
            <ProjectAssistant
              projectId={projectId}
              files={sortedFiles}
              activeFile={selectedFile}
              currentUserId={currentUserId}
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
            <div className="flex flex-1 items-center justify-center text-xs text-muted">
              Create a file to get started.
            </div>
          )}

          <div className="shrink-0 border-t border-border bg-background">
            <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-muted">
              <Terminal className={`h-3.5 w-3.5 ${isRunning ? "animate-pulse text-accent" : ""}`} strokeWidth={1.75} />
              {isRunning ? `Running ${runState.entryPath ?? ""}…` : "Output"}
            </div>
            <div className="max-h-40 overflow-y-auto px-4 pb-3 font-mono text-xs">
              {!isRunning && runState.lastRunAt && (
                <>
                  {runState.lastRunStdout && (
                    <pre className="whitespace-pre-wrap break-words text-foreground">{runState.lastRunStdout}</pre>
                  )}
                  {runState.lastRunStderr && (
                    <pre className="whitespace-pre-wrap break-words text-red-400">{runState.lastRunStderr}</pre>
                  )}
                  <p className="mt-1 text-muted">exit code: {runState.lastRunExitCode}</p>
                </>
              )}
              {!isRunning && !runState.lastRunAt && (
                <p className="py-2 text-muted">Run a file to see output here.</p>
              )}
            </div>
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
