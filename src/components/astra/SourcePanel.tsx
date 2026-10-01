import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { ActiveSource, SourceDto } from "@/lib/astra";
import { cn } from "@/lib/utils";
import { Loader2, X } from "lucide-react";

export function SourcePanel({
  activeSource,
  latestSources,
  onOpenSource,
  onClearActive,
}: {
  activeSource: ActiveSource | null;
  latestSources: SourceDto[];
  onOpenSource: (source: SourceDto) => void;
  onClearActive: () => void;
}) {
  const page = useQuery(
    api.documents.getPage,
    activeSource
      ? {
          documentId: activeSource.documentId,
          pageNumber: activeSource.pageNumber,
        }
      : "skip",
  );

  return (
    <div className="flex h-full flex-col gap-6 px-4 py-6">
      <section className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="label-xs">Source viewer</span>
          {activeSource && (
            <button
              type="button"
              onClick={onClearActive}
              className="cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Close source viewer"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {!activeSource ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Click a citation or a search result to open the exact PDF page the
            answer was taken from.
          </p>
        ) : (
          <>
            <p className="mt-3 break-words text-sm font-medium leading-5">
              {activeSource.fileName}
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              PAGE {String(activeSource.pageNumber).padStart(2, "0")}
            </p>

            <div className="mt-3 max-h-[46vh] overflow-y-auto rounded-md border border-border/70 bg-card px-3 py-3">
              {page === undefined ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading page…
                </div>
              ) : page === null ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  This page was not indexed. It may contain no extractable
                  text.
                </p>
              ) : page.text.trim().length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  No extractable text on this page.
                </p>
              ) : (
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                  {page.text}
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <section className="min-w-0 border-t border-border/70 pt-5">
        <span className="label-xs">Retrieved passages</span>

        {latestSources.length === 0 ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            The passages retrieved for the latest answer appear here with their
            document, page and excerpt.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {latestSources.map((source) => {
              const isActive =
                activeSource?.documentId === source.documentId &&
                activeSource?.pageNumber === source.pageNumber;
              return (
                <li key={`${source.label}-${source.documentId}-${source.pageNumber}`}>
                  <button
                    type="button"
                    onClick={() => onOpenSource(source)}
                    className={cn(
                      "w-full cursor-pointer rounded-md border px-3 py-2.5 text-left transition-colors",
                      isActive
                        ? "border-foreground bg-accent/60"
                        : "border-border/70 hover:border-border hover:bg-accent/40",
                    )}
                  >
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono text-foreground">
                        [{source.label}]
                      </span>
                      <span className="truncate">{source.fileName}</span>
                      <span className="ml-auto shrink-0 font-mono">
                        p. {source.pageNumber}
                      </span>
                    </span>
                    <span className="mt-1.5 line-clamp-3 block text-xs leading-5 text-muted-foreground">
                      {source.snippet}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
