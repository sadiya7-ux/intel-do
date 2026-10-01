import type { Doc, Id } from "@/convex/_generated/dataModel";

export type DocumentDoc = Doc<"documents">;
export type MessageDoc = Doc<"messages">;

/** Mirrors the server-side source validator. */
export interface SourceDto {
  label: string;
  documentId: Id<"documents">;
  fileName: string;
  pageNumber: number;
  snippet: string;
  score: number;
}

export interface ActiveSource {
  documentId: Id<"documents">;
  fileName: string;
  pageNumber: number;
}

/** The exact refusal the assistant is instructed to return. */
export const NOT_FOUND_TEXT =
  "I couldn't find this information in the uploaded document.";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isNotFoundAnswer(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("couldn't find this information") ||
    normalized.includes("could not find this information") ||
    normalized.includes("not found in the uploaded document")
  );
}

export interface StatusMeta {
  label: string;
  className: string;
}

export function statusMeta(status: DocumentDoc["status"]): StatusMeta {
  switch (status) {
    case "ready":
      return { label: "Ready", className: "bg-foreground" };
    case "processing":
      return { label: "Indexing", className: "bg-muted-foreground animate-pulse" };
    case "failed":
    default:
      return { label: "Failed", className: "bg-destructive" };
  }
}
