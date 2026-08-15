// Fire-and-forget trigger for /api/projects/summarize-change (Phase 3 of the
// debugging-tools build) — called right after a project_file_changes row is
// inserted, from both places that ever create one (RoomView's manual-edit
// propose flow and ProjectAssistant's accept-suggestion flow). Never
// awaited by its caller: the proposal itself is already fully valid and
// visible without a summary, which lands a moment later via the same
// realtime subscription the Pending panel already has open. A failure here
// is exactly as inconsequential as it looks — logged, not surfaced, never
// blocks or retries.
export function requestChangeSummary(changeId: string) {
  fetch("/api/projects/summarize-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changeId }),
  }).catch((err) => {
    console.warn(`requestChangeSummary: failed for change ${changeId}:`, err);
  });
}
