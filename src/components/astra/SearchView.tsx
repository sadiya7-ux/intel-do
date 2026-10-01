import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ActiveSource } from "@/lib/astra";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";

interface SearchHit {
  rank: number;
  documentId: string;
  fileName: string;
  pageNumber: number;
  snippet: string;
  score: number;
  vectorScore: number;
  lexicalScore: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  if (words.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${words.map(escapeRegex).join("|")})`, "ig");
  const parts = text.split(pattern);
  const lookup = new Set(words);
  return (
    <>
      {parts.map((part, index) =>
        lookup.has(part.toLowerCase()) ? (
          <mark key={index} className="bg-accent text-accent-foreground">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchView({
  documentIds,
  onOpenSource,
}: {
  documentIds: Id<"documents">[];
  onOpenSource: (source: ActiveSource) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchAction = useAction(api.search.searchDocuments);

  const run = async () => {
    const trimmed = query.trim();
    if (!trimmed || searching) return;
    setError(null);

    if (documentIds.length === 0) {
      setError("Select at least one document in the library to search.");
      setResults(null);
      return;
    }

    setSearching(true);
    try {
      const response = await searchAction({
        documentIds,
        query: trimmed,
        limit: 8,
      });
      if (!response.ok) {
        setError(response.message);
        setResults(null);
      } else {
        setResults(response.results as SearchHit[]);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Search failed. Please try again.",
      );
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
      <section>
        <span className="label-xs">Semantic search</span>
        <h2 className="mt-2 text-lg font-bold tracking-tight">
          Search across documents
        </h2>
        <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">
          Natural-language queries are ranked with the same hybrid retrieval
          pipeline used for answers: BM25 lexical scoring fused with vector
          similarity over page-aware passages.
        </p>

        <form
          className="mt-4 flex max-w-2xl items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder='e.g. "Find information about autonomous systems."'
              className="pl-9"
              aria-label="Search query"
            />
          </div>
          <Button
            type="submit"
            disabled={searching || query.trim().length === 0}
          >
            {searching ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Searching
              </>
            ) : (
              "Search"
            )}
          </Button>
        </form>

        {error && (
          <p
            role="alert"
            className="mt-3 max-w-2xl rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
          >
            {error}
          </p>
        )}
      </section>

      <section>
        <span className="label-xs">Results</span>

        {results === null ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Results appear here with the document name, page number, matching
            passage and relevance order.
          </p>
        ) : results.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No relevant information was found in the uploaded documents.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border/70 rounded-md border border-border/70">
            {results.map((hit) => (
              <li key={`${hit.documentId}-${hit.pageNumber}-${hit.rank}`}>
                <button
                  type="button"
                  onClick={() =>
                    onOpenSource({
                      documentId: hit.documentId as Id<"documents">,
                      fileName: hit.fileName,
                      pageNumber: hit.pageNumber,
                    })
                  }
                  className="flex w-full cursor-pointer flex-col gap-2 px-4 py-3.5 text-left transition-colors hover:bg-accent/40"
                >
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono text-muted-foreground">
                      #{hit.rank}
                    </span>
                    <span className="truncate font-medium text-foreground">
                      {hit.fileName}
                    </span>
                    <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-muted-foreground">
                      Page {hit.pageNumber}
                    </span>
                    <span className="ml-auto font-mono text-muted-foreground">
                      score {hit.score.toFixed(3)}
                    </span>
                  </span>
                  <span className="line-clamp-3 text-sm leading-6 text-muted-foreground">
                    <Highlighted text={hit.snippet} query={query} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
