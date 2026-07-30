"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export default function CopyCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the code stays visible and selectable.
    }
  }

  return (
    <div className="mt-4 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-4 py-3 font-mono text-xs text-foreground">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy room code"
        className="shrink-0 rounded-md border border-border p-3 text-muted transition-colors hover:text-foreground"
      >
        {copied ? (
          <Check className="h-4 w-4 text-accent" strokeWidth={2} />
        ) : (
          <Copy className="h-4 w-4" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}
