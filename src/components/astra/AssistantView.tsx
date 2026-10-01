import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DocumentDoc, MessageDoc, SourceDto } from "@/lib/astra";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/astra/ChatMessage";
import { ArrowUp, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

const SAMPLE_QUESTIONS = [
  "What is the main objective of this document?",
  "What technologies are discussed?",
  "What are the key findings?",
  "What limitations are mentioned?",
];

function SummaryBody({ summary }: { summary: string }) {
  const lines = summary.split("\n");
  return (
    <div className="space-y-2 text-sm leading-6">
      {lines.map((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) return null;
        const heading = line.replace(/:$/, "");
        if (/^[A-Z][A-Z /&-]{2,}$/.test(heading)) {
          return (
            <h4 key={index} className="label-xs pt-3 first:pt-0">
              {heading}
            </h4>
          );
        }
        if (/^[-*•]\s+/.test(line)) {
          return (
            <div key={index} className="flex gap-2.5">
              <span
                className="mt-2.5 size-1 shrink-0 bg-foreground"
                aria-hidden="true"
              />
              <p className="flex-1">{line.replace(/^[-*•]\s+/, "")}</p>
            </div>
          );
        }
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

export function AssistantView({
  documents,
  selectedIds,
  focusedId,
  messages,
  conversationId,
  ensureConversation,
  onOpenSource,
}: {
  documents: DocumentDoc[];
  selectedIds: Id<"documents">[];
  focusedId: Id<"documents"> | null;
  messages: MessageDoc[] | undefined;
  conversationId: Id<"conversations"> | null;
  ensureConversation: () => Promise<Id<"conversations">>;
  onOpenSource: (source: SourceDto) => void;
}) {
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const askAction = useAction(api.assistant.ask);
  const summarizeAction = useAction(api.assistant.summarize);
  const appendUser = useMutation(api.conversations.appendUser);
  const clearConversation = useMutation(api.conversations.clear);

  const scrollRef = useRef<HTMLDivElement>(null);
  const focused = documents.find((doc) => doc._id === focusedId) ?? null;
  const scoped = useMemo(
    () =>
      documents.filter(
        (doc) => selectedIds.includes(doc._id) && doc.status === "ready",
      ),
    [documents, selectedIds],
  );
  const processingCount = documents.filter(
    (doc) => selectedIds.includes(doc._id) && doc.status === "processing",
  ).length;

  const canAsk = scoped.length > 0 && !asking;
  const transcript = messages ?? [];

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [transcript.length, asking]);

  const send = async (raw: string) => {
    const question = raw.trim();
    if (!question || asking) return;
    setAskError(null);

    if (scoped.length === 0) {
      setAskError(
        "No processed document is selected. Upload a PDF or tick one in the library.",
      );
      return;
    }

    setAsking(true);
    setInput("");
    try {
      const targetConversation = conversationId ?? (await ensureConversation());
      await appendUser({ conversationId: targetConversation, content: question });
      const result = await askAction({
        conversationId: targetConversation,
        documentIds: scoped.map((doc) => doc._id),
        question,
      });
      if (!result.ok) setAskError(result.message);
    } catch (error) {
      setAskError(
        error instanceof Error
          ? error.message
          : "The assistant request failed. Please try again.",
      );
    } finally {
      setAsking(false);
    }
  };

  const generateSummary = async () => {
    if (!focused || focused.status !== "ready" || summarizing) return;
    setSummaryError(null);
    setSummarizing(true);
    try {
      const result = await summarizeAction({ documentId: focused._id });
      if (!result.ok) setSummaryError(result.message);
    } catch (error) {
      setSummaryError(
        error instanceof Error
          ? error.message
          : "Summary generation failed. Please try again.",
      );
    } finally {
      setSummarizing(false);
    }
  };

  const clearChat = async () => {
    if (!conversationId || transcript.length === 0) return;
    try {
      await clearConversation({ conversationId });
      toast("Conversation cleared.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not clear the conversation.",
      );
    }
  };

  if (documents.length === 0) {
    return (
      <div className="flex h-full min-h-[60vh] items-center justify-center px-6 py-16">
        <div className="max-w-sm text-center">
          <FileText className="mx-auto size-5 text-muted-foreground" />
          <h2 className="mt-4 text-base font-bold tracking-tight">
            No documents yet
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Upload a defence or technology PDF in the left panel. Every answer,
            summary and citation is grounded in what you upload — nothing else.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 px-4 py-6 sm:px-6">
      {/* ---------------- Document header ---------------- */}
      <section>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="label-xs">Document</span>
            <h2 className="mt-2.5 break-words text-xl font-bold tracking-tight">
              {focused ? focused.fileName : "Select a document"}
            </h2>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {focused ? (
                <>
                  {focused.pageCount} pages
                  {focused.status === "ready" && focused.chunkCount
                    ? ` · ${focused.chunkCount} indexed passages`
                    : ""}
                  {" · "}
                  {focused.status === "processing"
                    ? "processing"
                    : focused.status === "failed"
                      ? "failed"
                      : "ready"}
                </>
              ) : (
                "Click a file name in the library to inspect it."
              )}
            </p>
          </div>

          <div className="text-right">
            <span className="label-xs">Retrieval scope</span>
            <p className="mt-2 text-xs text-muted-foreground">
              {scoped.length === 0
                ? "No document selected"
                : `${scoped.length} document${scoped.length === 1 ? "" : "s"} selected`}
            </p>
          </div>
        </div>

        {focused?.status === "failed" && focused.error && (
          <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
            {focused.error}
          </p>
        )}
        {processingCount > 0 && (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {processingCount} selected document
            {processingCount === 1 ? " is" : "s are"} still processing and will
            be unavailable until indexing finishes.
          </p>
        )}
      </section>

      {/* ---------------- Summary ---------------- */}
      {focused && (
        <section className="overflow-hidden rounded-md border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <span className="label-xs">Summary</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={focused.status !== "ready" || summarizing}
              onClick={() => void generateSummary()}
            >
              {summarizing ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Summarizing…
                </>
              ) : focused.summary ? (
                "Regenerate"
              ) : (
                "Generate summary"
              )}
            </Button>
          </div>

          <div className="px-4 py-4">
            {summaryError && (
              <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                {summaryError}
              </p>
            )}
            {focused.status !== "ready" ? (
              <p className="text-xs leading-5 text-muted-foreground">
                Summary becomes available once the document finishes indexing.
              </p>
            ) : focused.summary ? (
              <SummaryBody summary={focused.summary} />
            ) : !summaryError ? (
              <p className="text-xs leading-5 text-muted-foreground">
                Generate a grounded summary with Overview, Key Points, Important
                Technical Details and Main Findings — written only from this
                document.
              </p>
            ) : null}
          </div>
        </section>
      )}

      {/* ---------------- Conversation ---------------- */}
      <section className="flex min-w-0 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <span className="label-xs">ASTRA INTEL Assistant</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void clearChat()}
            disabled={transcript.length === 0}
          >
            Clear conversation
          </Button>
        </div>

        <div
          ref={scrollRef}
          className="h-[44vh] min-h-[320px] overflow-y-auto divide-y divide-border/60"
        >
          {transcript.length === 0 && !asking ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <p className="text-sm font-medium">Ask ASTRA about your documents</p>
              <p className="mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">
                Answers are produced only from retrieved passages in the
                selected documents, with the page number for every claim.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SAMPLE_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => void send(question)}
                    className="cursor-pointer rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            transcript.map((message, index) => (
              <ChatMessage
                key={message._id}
                message={message}
                first={index === 0}
                onOpenSource={onOpenSource}
              />
            ))
          )}

          {asking && (
            <div className="flex items-center gap-2 px-4 py-5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Retrieving passages and reasoning over the selected documents…
            </div>
          )}
        </div>

        {askError && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
          >
            {askError}
          </p>
        )}

        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <Textarea
            value={input}
            rows={2}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            placeholder={
              canAsk
                ? "Ask a question about the selected documents…"
                : "Upload and select a processed document to ask questions."
            }
            className="min-h-[64px] resize-none"
            aria-label="Question for the ASTRA assistant"
          />
          <Button
            type="submit"
            size="icon"
            className="h-[64px] w-12"
            disabled={!canAsk || input.trim().length === 0}
            aria-label="Send question"
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
        <p className={cn(
          "mt-2 text-[11px] leading-4 text-muted-foreground",
        )}>
          Enter to send · Shift + Enter for a new line. The assistant answers only
          from retrieved document content.
        </p>
      </section>
    </div>
  );
}
