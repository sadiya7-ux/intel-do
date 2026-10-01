import { useState } from "react";
import type { MessageDoc, SourceDto } from "@/lib/astra";
import { isNotFoundAnswer } from "@/lib/astra";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ChevronDown, ExternalLink, FileText } from "lucide-react";

/**
 * Renders an assistant answer: **bold** emphasis, readable paragraphs and
 * [Sx] citation labels turned into clickable "Page N" chips that open the
 * source viewer on the exact PDF page.
 */
function renderContent(
  content: string,
  sources: SourceDto[],
  onOpenSource: (source: SourceDto) => void,
) {
  const byLabel = new Map(sources.map((source) => [source.label, source]));
  return content.split(/(\*\*[^*]+\*\*|\[S\d+\])/g).map((part, index) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={index} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (/^\[S\d+\]$/.test(part)) {
      const source = byLabel.get(part.slice(1, -1));
      if (!source) return <span key={index}>{part}</span>;
      return (
        <button
          key={index}
          type="button"
          onClick={() => onOpenSource(source)}
          title={`Open ${source.fileName}, page ${source.pageNumber}`}
          className="mx-0.5 inline-flex cursor-pointer items-center rounded-sm border border-border bg-muted/70 px-1.5 py-px font-mono text-[11px] leading-4 text-foreground transition-colors hover:border-foreground hover:bg-accent"
        >
          Page {source.pageNumber}
        </button>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

/** Sources in citation order first, then their original retrieval rank. */
function orderByCitation(content: string, sources: SourceDto[]): SourceDto[] {
  const ordered: SourceDto[] = [];
  const seen = new Set<string>();
  const push = (source: SourceDto) => {
    const key = `${source.label}-${source.documentId}-${source.pageNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(source);
  };
  for (const match of content.matchAll(/\[S\d+\]/g)) {
    const source = sources.find((item) => item.label === match[0]);
    if (source) push(source);
  }
  sources.forEach(push);
  return ordered;
}

/** Primary source card: document, page and a short (1-3 line) excerpt. */
function PrimarySource({
  source,
  onOpenSource,
}: {
  source: SourceDto;
  onOpenSource: (source: SourceDto) => void;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-card/70 px-3.5 py-3">
      <div className="flex items-center gap-2 text-xs">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {source.fileName}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          Page {source.pageNumber}
        </span>
      </div>
      <p className="mt-2 line-clamp-3 border-l border-border pl-3 text-xs italic leading-5 text-muted-foreground">
        &ldquo;{source.snippet}&rdquo;
      </p>
      <button
        type="button"
        onClick={() => onOpenSource(source)}
        className="mt-2.5 flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        View source
        <ExternalLink className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

export function ChatMessage({
  message,
  onOpenSource,
  first,
}: {
  message: MessageDoc;
  onOpenSource: (source: SourceDto) => void;
  first: boolean;
}) {
  const [showAllSources, setShowAllSources] = useState(false);
  const isAssistant = message.role === "assistant";
  const notFound = isAssistant && isNotFoundAnswer(message.content);
  const sources = message.sources ?? [];

  // Show at most two sources by default: the cited pages first (a question
  // answered by one page shows exactly one card), everything else collapsed.
  const ordered = isAssistant ? orderByCitation(message.content, sources) : [];
  const citedCount = ordered.filter((source) =>
    message.content.includes(`[${source.label}]`),
  ).length;
  const visible = ordered.slice(0, Math.min(2, Math.max(citedCount, 1)));
  const hidden = ordered.filter((source) => !visible.includes(source));

  return (
    <article
      className={cn("px-4 py-5", !first && "border-t border-border/70")}
    >
      <header className="flex items-baseline justify-between gap-3">
        <span className="label-xs">{isAssistant ? "ASTRA" : "You"}</span>
        <time
          className="label-xs tabular-nums"
          dateTime={new Date(message._creationTime).toISOString()}
        >
          {format(new Date(message._creationTime), "HH:mm")}
        </time>
      </header>

      <div
        className={cn(
          "mt-2.5 whitespace-pre-wrap break-words text-sm leading-7",
          notFound && "italic text-muted-foreground",
        )}
      >
        {isAssistant
          ? renderContent(message.content, sources, onOpenSource)
          : message.content}
      </div>

      {isAssistant && notFound && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          No relevant passage was found in the selected documents. Try
          rephrasing the question or selecting more documents.
        </p>
      )}

      {isAssistant && visible.length > 0 && !notFound && (
        <div className="mt-5 border-t border-border/60 pt-4">
          <span className="label-xs">
            {visible.length > 1 ? "Sources" : "Source"}
          </span>

          <div className="mt-2.5 space-y-2.5">
            {visible.map((source) => (
              <PrimarySource
                key={`${source.label}-${source.documentId}-${source.pageNumber}`}
                source={source}
                onOpenSource={onOpenSource}
              />
            ))}
          </div>

          {hidden.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowAllSources((value) => !value)}
                className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={showAllSources}
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    showAllSources && "rotate-180",
                  )}
                  aria-hidden="true"
                />
                {showAllSources
                  ? "Hide sources"
                  : `View ${hidden.length} more source${hidden.length === 1 ? "" : "s"}`}
              </button>

              {showAllSources && (
                <ul className="mt-2 space-y-1.5">
                  {hidden.map((source) => (
                    <li key={`${source.label}-${source.documentId}-${source.pageNumber}`}>
                      <button
                        type="button"
                        onClick={() => onOpenSource(source)}
                        className="w-full cursor-pointer rounded-sm border border-border/60 px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/40"
                      >
                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="truncate text-foreground">
                            {source.fileName}
                          </span>
                          <span className="ml-auto shrink-0 font-mono">
                            Page {source.pageNumber}
                          </span>
                        </span>
                        <span className="mt-1 block line-clamp-1 text-xs leading-5 text-muted-foreground">
                          {source.snippet}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
