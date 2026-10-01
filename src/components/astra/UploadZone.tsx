import { useCallback, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { extractPdfPages, validatePdfFile } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "extracting"; done: number; total: number }
  | { kind: "indexing" };

export function UploadZone({
  onUploaded,
}: {
  onUploaded: (documentId: Id<"documents">) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createDocument = useMutation(api.documents.create);
  const processDocument = useAction(api.ingest.processDocument);

  const busy = stage.kind !== "idle";

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        setError("No file selected. Choose a PDF and try again.");
        return;
      }

      for (const file of files) {
        const validation = validatePdfFile(file);
        if (validation) {
          setError(validation);
          toast.error(validation);
          continue;
        }

        setError(null);
        setStage({ kind: "reading" });
        try {
          const extracted = await extractPdfPages(file, (done, total) =>
            setStage({ kind: "extracting", done, total }),
          );
          setStage({ kind: "indexing" });

          const documentId = await createDocument({
            fileName: file.name,
            fileSize: file.size,
            pageCount: extracted.pageCount,
          });
          await processDocument({ documentId, pages: extracted.pages });

          toast.success(
            `${file.name} indexed — ${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"}.`,
          );
          onUploaded(documentId);
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : "The upload failed. Please try again.";
          setError(message);
          toast.error(message);
        }
      }

      setStage({ kind: "idle" });
    },
    [createDocument, processDocument, onUploaded],
  );

  const progressValue =
    stage.kind === "extracting" && stage.total > 0
      ? Math.round((stage.done / stage.total) * 80)
      : stage.kind === "reading"
        ? 10
        : stage.kind === "indexing"
          ? 92
          : 0;

  return (
    <section aria-label="Upload documents">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="label-xs">Upload</h2>
        <span className="label-xs tracking-normal normal-case">PDF · max 15 MB</span>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy) return;
          void handleFiles(Array.from(event.dataTransfer.files ?? []));
        }}
        className={cn(
          "rounded-md border border-dashed border-border px-3 py-5 text-center transition-colors",
          dragging && "border-foreground bg-accent/60",
          busy && "border-solid bg-muted/40",
        )}
      >
        {busy ? (
          <div className="space-y-2 text-left">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span>
                {stage.kind === "reading" && "Reading file…"}
                {stage.kind === "extracting" &&
                  `Extracting page text ${stage.done}/${stage.total}…`}
                {stage.kind === "indexing" && "Chunking and indexing…"}
              </span>
            </div>
            <Progress value={progressValue} className="h-1" />
          </div>
        ) : (
          <div className="space-y-3">
            <Upload className="mx-auto size-4 text-muted-foreground" />
            <p className="text-xs leading-5 text-muted-foreground">
              Drag a PDF here
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => inputRef.current?.click()}
            >
              Browse files
            </Button>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = "";
            void handleFiles(files);
          }}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs leading-5 text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
