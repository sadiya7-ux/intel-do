import type { MessageDoc, SourceDto } from "@/lib/astra";
import { isNotFoundAnswer } from "@/lib/astra";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

/** Renders [S1]-style citation labels as small inline chips. */
function renderContent(content: string) {
  return content.split(/(\[S\d+\])/g).map((part, index) =>
    /^\[S\d+\]$/.test(part) ? (
      <span
        key={index}
        className="mx-0.5 inline-block rounded-sm border border-border bg-muted px-1 py-px font-mono text-[11px] text-foreground"
      >
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function SourceEntry({
  source,
  onOpenSource,
}: {
  source: SourceDto;
  onOpenSource: (source: SourceDto) => void;
}) {
  return (
    <div className="border-l border-border pl-3">
      <button
        type="button"
        onClick={() => onOpenSource(source)}
        className="flex max-w-full cursor-pointer items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="font-mono text-foreground">[{source.label}]</span>
        <span className="truncate">{source.fileName}</span>
        <span className="shrink-0 font-mono">p. {source.pageNumber}</span>
      </button>
      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
        &ldquo;{source.snippet}&rdquo;
      </p>
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
  const isAssistant = message.role === "assistant";
  const notFound = isAssistant && isNotFoundAnswer(message.content);
  const sources = message.sources ?? [];

  return (
    <article
      className={cn(
        "px-4 py-5",
        !first && "border-t border-border/70",
      )}
    >
      <header className="flex items-baseline justify-between gap-3">
        <span className="label-xs">
          {isAssistant ? "ASTRA" : "You"}
        </span>
        <time
          className="label-xs tabular-nums"
          dateTime={new Date(message._creationTime).toISOString()}
        >
          {format(new Date(message._creationTime), "HH:mm")}
        </time>
      </header>

      <div
        className={cn(
          "mt-2 whitespace-pre-wrap break-words text-sm leading-6",
          notFound && "italic text-muted-foreground",
        )}
      >
        {isAssistant ? renderContent(message.content) : message.content}
      </div>

      {isAssistant && notFound && (
        <p className="mt-2 text-xs text-muted-foreground">
          No relevant passage was found in the selected documents.
        </p>
      )}

      {sources.length > 0 && (
        <div className="mt-4 space-y-2.5">
          <span className="label-xs">Sources</span>
          {sources.map((source) => (
            <SourceEntry
              key={`${source.label}-${source.documentId}-${source.pageNumber}`}
              source={source}
              onOpenSource={onOpenSource}
            />
          ))}
        </div>
      )}
    </article>
  );
}
