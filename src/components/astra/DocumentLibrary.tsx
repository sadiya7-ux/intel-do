import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DocumentDoc } from "@/lib/astra";
import { formatBytes, statusMeta } from "@/lib/astra";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

export function DocumentLibrary({
  documents,
  selectedIds,
  focusedId,
  onToggle,
  onFocus,
}: {
  documents: DocumentDoc[];
  selectedIds: Id<"documents">[];
  focusedId: Id<"documents"> | null;
  onToggle: (documentId: Id<"documents">) => void;
  onFocus: (documentId: Id<"documents">) => void;
}) {
  const removeDocument = useMutation(api.documents.remove);

  const handleRemove = async (document: DocumentDoc) => {
    try {
      await removeDocument({ documentId: document._id });
      toast(`${document.fileName} removed.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove the document.",
      );
    }
  };

  if (documents.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-card/50 px-3 py-4 text-xs leading-5 text-muted-foreground">
        No documents yet. Upload a PDF to build your library.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-card">
      {documents.map((document) => {
        const status = statusMeta(document.status);
        const selected = selectedIds.includes(document._id);
        const focused = focusedId === document._id;

        return (
          <li
            key={document._id}
            className={cn(
              "group flex items-start gap-2 px-2.5 py-2.5 transition-colors",
              focused && "bg-muted",
              !focused && "hover:bg-muted/50",
            )}
          >
            <Checkbox
              checked={selected}
              disabled={document.status !== "ready"}
              aria-label={`Include ${document.fileName} in retrieval`}
              onCheckedChange={() => onToggle(document._id)}
              className="mt-0.5"
            />

            <button
              type="button"
              onClick={() => onFocus(document._id)}
              className="min-w-0 flex-1 cursor-pointer text-left"
              title={document.fileName}
            >
              <span
                className={cn(
                  "block truncate text-xs leading-5",
                  focused ? "font-semibold text-foreground" : "font-medium text-foreground",
                )}
              >
                {document.fileName}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{document.pageCount || 0} pp</span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(document.fileSize)}</span>
              </span>
              <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {document.status === "processing" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <span
                    className={cn("size-1.5 rounded-full", status.className)}
                    aria-hidden="true"
                  />
                )}
                {status.label}
              </span>
              {document.status === "failed" && document.error && (
                <span className="mt-1 block text-[11px] leading-4 text-destructive">
                  {document.error}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => void handleRemove(document)}
              aria-label={`Remove ${document.fileName}`}
              className="cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
