import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { chunkPages, embedText, EMBEDDER_ID, type PageInput } from "./lib/text";

/** Hard cap on extracted text per document (keeps action payloads sane). */
const MAX_TOTAL_TEXT = 3_000_000;
const PAGE_INSERT_BATCH = 40;
const CHUNK_INSERT_BATCH = 15;

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Ingestion pipeline: page-aware chunking -> embeddings -> storage.
 *
 * Runs as an action because chunking and embedding a whole document is too
 * heavy for a mutation. Page text is written first (for the source viewer),
 * then chunks, then the document flips to "ready".
 */
export const processDocument = action({
  args: {
    documentId: v.id("documents"),
    pages: v.array(v.object({ pageNumber: v.number(), text: v.string() })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated.");

    const doc = await ctx.runQuery(internal.documents.getById, {
      id: args.documentId,
    });
    if (!doc || doc.userId !== userId) {
      throw new Error("Document not found.");
    }

    // Normalise + de-duplicate page numbers, preserving real PDF pages only.
    const seen = new Set<number>();
    const pages: PageInput[] = [];
    for (const page of args.pages) {
      const pageNumber = Math.floor(page.pageNumber);
      if (!Number.isFinite(pageNumber) || pageNumber < 1) continue;
      if (seen.has(pageNumber)) continue;
      seen.add(pageNumber);
      pages.push({ pageNumber, text: page.text ?? "" });
    }
    pages.sort((a, b) => a.pageNumber - b.pageNumber);

    const totalText = pages.reduce((sum, page) => sum + page.text.length, 0);
    if (pages.length === 0 || totalText === 0) {
      const message =
        "No extractable text was found in this PDF. Scanned or image-only PDFs are not supported yet (OCR is a planned improvement).";
      await ctx.runMutation(internal.documents.failProcessing, {
        documentId: args.documentId,
        error: message,
      });
      throw new Error(message);
    }
    if (totalText > MAX_TOTAL_TEXT) {
      const message =
        "Extracted text exceeds the 3 MB processing limit for a single document.";
      await ctx.runMutation(internal.documents.failProcessing, {
        documentId: args.documentId,
        error: message,
      });
      throw new Error(message);
    }

    try {
      const chunkInputs = chunkPages(pages);
      if (chunkInputs.length === 0) {
        throw new Error(
          "The document could not be split into searchable passages.",
        );
      }
      const chunks = chunkInputs.map((chunk) => ({
        ...chunk,
        embedding: embedText(chunk.text),
      }));

      for (const pageBatch of batch(pages, PAGE_INSERT_BATCH)) {
        await ctx.runMutation(internal.documents.insertPages, {
          documentId: args.documentId,
          pages: pageBatch,
        });
      }
      for (const chunkBatch of batch(chunks, CHUNK_INSERT_BATCH)) {
        await ctx.runMutation(internal.documents.insertChunks, {
          documentId: args.documentId,
          chunks: chunkBatch,
        });
      }
      await ctx.runMutation(internal.documents.finishProcessing, {
        documentId: args.documentId,
        pageCount: pages.length,
        chunkCount: chunks.length,
        embeddingMode: EMBEDDER_ID,
      });

      return {
        ok: true as const,
        pageCount: pages.length,
        chunkCount: chunks.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.documents.failProcessing, {
        documentId: args.documentId,
        error: message,
      });
      throw error;
    }
  },
});
