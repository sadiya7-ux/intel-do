import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DocumentDoc } from "@/lib/astra";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Columns2, Loader2 } from "lucide-react";

interface CompareResponse {
  ok: boolean;
  code?: string;
  message?: string;
  documentA?: { fileName: string; pageCount: number };
  documentB?: { fileName: string; pageCount: number };
  rows?: Array<{ category: string; a: string; b: string }>;
}

function isNotSpecified(text: string): boolean {
  return /not specified in the document/i.test(text);
}

export function CompareView({ documents }: { documents: DocumentDoc[] }) {
  const ready = documents.filter((doc) => doc.status === "ready");
  const [documentIdA, setDocumentIdA] = useState<Id<"documents"> | null>(null);
  const [documentIdB, setDocumentIdB] = useState<Id<"documents"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    | {
        documentA: { fileName: string; pageCount: number };
        documentB: { fileName: string; pageCount: number };
        rows: Array<{ category: string; a: string; b: string }>;
      }
    | null
  >(null);

  const compareAction = useAction(api.assistant.compare);

  const run = async () => {
    if (!documentIdA || !documentIdB || loading) return;
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const response = (await compareAction({
        documentIdA,
        documentIdB,
      })) as CompareResponse;

      if (!response.ok) {
        setError(response.message ?? "Comparison failed. Please try again.");
        return;
      }
      if (!response.documentA || !response.documentB || !response.rows) {
        setError("The comparison response was incomplete. Please try again.");
        return;
      }
      setResult({
        documentA: response.documentA,
        documentB: response.documentB,
        rows: response.rows,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Comparison failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  if (ready.length < 2) {
    return (
      <div className="flex h-full min-h-[50vh] items-center justify-center px-6 py-16">
        <div className="max-w-sm text-center">
          <Columns2 className="mx-auto size-5 text-muted-foreground" />
          <h2 className="mt-4 text-base font-bold tracking-tight">
            Two documents required
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Upload and process at least two PDFs to compare their objectives,
            technologies, findings and limitations side by side.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
      <section>
        <span className="label-xs">Document comparison</span>
        <h2 className="mt-2.5 text-xl font-bold tracking-tight">
          Compare two documents
        </h2>
        <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">
          Every cell is generated only from the two selected documents. Where a
          document does not discuss a category, the table says so explicitly.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="flex flex-col gap-1.5">
            <span className="label-xs">Document A</span>
            <Select
              value={documentIdA ?? undefined}
              onValueChange={(value) => setDocumentIdA(value as Id<"documents">)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a document" />
              </SelectTrigger>
              <SelectContent>
                {ready.map((doc) => (
                  <SelectItem key={doc._id} value={doc._id}>
                    {doc.fileName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-xs">Document B</span>
            <Select
              value={documentIdB ?? undefined}
              onValueChange={(value) => setDocumentIdB(value as Id<"documents">)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a document" />
              </SelectTrigger>
              <SelectContent>
                {ready.map((doc) => (
                  <SelectItem key={doc._id} value={doc._id}>
                    {doc.fileName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <Button
            type="button"
            onClick={() => void run()}
            disabled={!documentIdA || !documentIdB || loading}
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Comparing
              </>
            ) : (
              "Compare"
            )}
          </Button>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-3 max-w-2xl rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
          >
            {error}
          </p>
        )}
      </section>

      {result && (
        <section className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full min-w-[640px] border-collapse text-left align-top">
            <thead>
              <tr className="border-b border-border">
                <th className="label-xs w-[20%] px-4 py-3">Category</th>
                <th className="label-xs px-4 py-3">
                  {result.documentA.fileName}
                </th>
                <th className="label-xs px-4 py-3">
                  {result.documentB.fileName}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr
                  key={row.category}
                  className="border-b border-border/70 last:border-b-0"
                >
                  <td className="px-4 py-3 text-xs font-medium leading-5">
                    {row.category}
                  </td>
                  <td
                    className={
                      isNotSpecified(row.a)
                        ? "px-4 py-3 text-sm leading-6 italic text-muted-foreground"
                        : "px-4 py-3 text-sm leading-6"
                    }
                  >
                    {row.a}
                  </td>
                  <td
                    className={
                      isNotSpecified(row.b)
                        ? "px-4 py-3 text-sm leading-6 italic text-muted-foreground"
                        : "px-4 py-3 text-sm leading-6"
                    }
                  >
                    {row.b}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!result && !error && (
        <p className="text-xs leading-5 text-muted-foreground">
          Select two processed documents and press Compare to build the
          side-by-side table.
        </p>
      )}
    </div>
  );
}
