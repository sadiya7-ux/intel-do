import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id, Doc } from "./_generated/dataModel";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";

const MAX_PAGE_TEXT = 400_000; // characters per page guard

async function requireUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated.");
  return userId;
}

async function requireOwnDocument(
  ctx: QueryCtx | MutationCtx,
  documentId: Id<"documents">,
  userId: string,
) {
  const doc = await ctx.db.get(documentId);
  if (!doc || doc.userId !== userId) throw new Error("Document not found.");
  return doc;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("documents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

export const create = mutation({
  args: {
    fileName: v.string(),
    fileSize: v.number(),
    pageCount: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const fileName = args.fileName.trim().slice(0, 200);
    if (!fileName) throw new Error("File name is required.");
    if (args.fileSize < 0 || args.pageCount < 0) {
      throw new Error("Invalid document metadata.");
    }
    return await ctx.db.insert("documents", {
      userId,
      fileName,
      fileSize: args.fileSize,
      pageCount: Math.max(0, Math.floor(args.pageCount)),
      status: "processing",
    });
  },
});

export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireOwnDocument(ctx, args.documentId, userId);

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const chunks = await ctx.db
      .query("chunks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const page of pages) await ctx.db.delete(page._id);
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    await ctx.db.delete(args.documentId);
  },
});

export const getPage = query({
  args: { documentId: v.id("documents"), pageNumber: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.userId !== userId) return null;
    const page = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .filter((q) => q.eq(q.field("pageNumber"), args.pageNumber))
      .first();
    return page ? { pageNumber: page.pageNumber, text: page.text } : null;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers used by the ingestion / AI actions
// ---------------------------------------------------------------------------

export const getById = internalQuery({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

export const getMany = internalQuery({
  args: { ids: v.array(v.id("documents")) },
  handler: async (ctx, args): Promise<Doc<"documents">[]> => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter((doc): doc is Doc<"documents"> => doc !== null);
  },
});

export const insertPages = internalMutation({
  args: {
    documentId: v.id("documents"),
    pages: v.array(v.object({ pageNumber: v.number(), text: v.string() })),
  },
  handler: async (ctx, args) => {
    for (const page of args.pages) {
      await ctx.db.insert("pages", {
        documentId: args.documentId,
        pageNumber: page.pageNumber,
        text: page.text.slice(0, MAX_PAGE_TEXT),
      });
    }
  },
});

export const insertChunks = internalMutation({
  args: {
    documentId: v.id("documents"),
    chunks: v.array(
      v.object({
        pageNumber: v.number(),
        chunkIndex: v.number(),
        text: v.string(),
        tokenCount: v.number(),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const chunk of args.chunks) {
      await ctx.db.insert("chunks", {
        documentId: args.documentId,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        embedding: chunk.embedding,
      });
    }
  },
});

export const finishProcessing = internalMutation({
  args: {
    documentId: v.id("documents"),
    pageCount: v.number(),
    chunkCount: v.number(),
    embeddingMode: v.union(v.literal("hashing-v1"), v.literal("remote")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      status: "ready",
      pageCount: args.pageCount,
      chunkCount: args.chunkCount,
      embeddingMode: args.embeddingMode,
      error: undefined,
    });
  },
});

export const failProcessing = internalMutation({
  args: { documentId: v.id("documents"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      status: "failed",
      error: args.error.slice(0, 500),
    });
  },
});

export const setSummary = internalMutation({
  args: { documentId: v.id("documents"), summary: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, { summary: args.summary });
  },
});

export const chunksForDocuments = internalQuery({
  args: { documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    const results = await Promise.all(
      args.documentIds.map((documentId) =>
        ctx.db
          .query("chunks")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .collect(),
      ),
    );
    return results.flat().map((chunk) => ({
      _id: chunk._id,
      documentId: chunk.documentId,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
    }));
  },
});

export const chunksByIds = internalQuery({
  args: { ids: v.array(v.id("chunks")) },
  handler: async (ctx, args) => {
    const chunks = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return chunks
      .filter((chunk): chunk is Doc<"chunks"> => chunk !== null)
      .map((chunk) => ({
        _id: chunk._id,
        documentId: chunk.documentId,
        pageNumber: chunk.pageNumber,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
      }));
  },
});

export const pagesForDocument = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return pages
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((page) => ({ pageNumber: page.pageNumber, text: page.text }));
  },
});
