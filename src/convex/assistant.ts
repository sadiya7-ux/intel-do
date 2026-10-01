"use node";

/**
 * AI actions: grounded question answering, document summary and comparison.
 *
 * This is a "use node" file, so process.env (API keys) is available here and
 * only here — nothing in this module is ever shipped to the browser.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, type ActionCtx } from "./_generated/server";
import { complete } from "./lib/ai";
import { retrieve } from "./lib/retrieval";
import {
  buildAnswerPrompt,
  buildComparisonPrompt,
  buildDocumentSourceText,
  buildSummaryPrompt,
  COMPARISON_SYSTEM_PROMPT,
  GROUNDING_SYSTEM_PROMPT,
  NOT_FOUND_MESSAGE,
  NOT_SPECIFIED,
  parseComparisonRows,
  SUMMARY_SYSTEM_PROMPT,
  stripOutOfRangePages,
  stripUnknownSourceLabels,
} from "./lib/prompts";

const SUMMARY_MAX_CHARS = 60_000;
const COMPARISON_MAX_CHARS = 26_000;
const CONTEXT_LIMIT = 6;

export interface SourceDto {
  label: string;
  documentId: Id<"documents">;
  fileName: string;
  pageNumber: number;
  snippet: string;
  score: number;
}

export type AskResult =
  | { ok: true; answer: string; sources: SourceDto[]; notFound: boolean }
  | { ok: false; code: string; message: string };

export type SummaryResult =
  | { ok: true; summary: string }
  | { ok: false; code: string; message: string };

export type CompareResult =
  | {
      ok: true;
      documentA: { fileName: string; pageCount: number };
      documentB: { fileName: string; pageCount: number };
      rows: Array<{ category: string; a: string; b: string }>;
    }
  | { ok: false; code: string; message: string };

function isNotFoundAnswer(answer: string): boolean {
  const normalized = answer.toLowerCase();
  return (
    normalized.includes("couldn't find this information") ||
    normalized.includes("could not find this information") ||
    normalized.includes("not found in the uploaded document")
  );
}

/**
 * Grounded Q&A: retrieve -> prompt with page-labelled context -> generate ->
 * sanitise -> persist the answer together with its retrieved sources.
 */
export const ask = action({
  args: {
    conversationId: v.id("conversations"),
    documentIds: v.array(v.id("documents")),
    question: v.string(),
  },
  handler: async (ctx, args): Promise<AskResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        ok: false,
        code: "unauthenticated",
        message: "Sign in to use the ASTRA assistant.",
      };
    }

    const question = args.question.trim();
    if (question.length < 2) {
      return { ok: false, code: "invalid", message: "Please enter a question." };
    }
    if (question.length > 2000) {
      return {
        ok: false,
        code: "invalid",
        message: "Questions are limited to 2000 characters.",
      };
    }

    const conversation = await ctx.runQuery(
      internal.conversations.getForAction,
      { conversationId: args.conversationId },
    );
    if (!conversation || conversation.userId !== userId) {
      return {
        ok: false,
        code: "invalid",
        message: "Conversation not found. Reload the page and try again.",
      };
    }

    const documents = await ctx.runQuery(internal.documents.getMany, {
      ids: args.documentIds,
    });
    const owned = documents.filter((doc) => doc.userId === userId);
    const readyIds = owned
      .filter((doc) => doc.status === "ready")
      .map((doc) => doc._id);
    if (readyIds.length === 0) {
      return {
        ok: false,
        code: "no_documents",
        message:
          "No processed document is selected. Upload a PDF or wait for processing to finish.",
      };
    }
    const maxPage = owned.reduce(
      (max, doc) => Math.max(max, doc.pageCount),
      0,
    );

    const history = await ctx.runQuery(internal.conversations.promptHistory, {
      conversationId: args.conversationId,
      limit: 6,
    });
    const retrieval = await retrieve(ctx, {
      userId,
      documentIds: readyIds,
      query: question,
      limit: CONTEXT_LIMIT,
    });

    // Deterministic guard: nothing relevant was retrieved at all.
    if (retrieval.hits.length === 0) {
      const answer = NOT_FOUND_MESSAGE;
      await ctx.runMutation(internal.conversations.appendAssistant, {
        conversationId: args.conversationId,
        userId,
        content: answer,
      });
      await ctx.runMutation(internal.conversations.rememberDocuments, {
        conversationId: args.conversationId,
        userId,
        documentIds: readyIds,
      });
      return { ok: true, answer, sources: [], notFound: true };
    }

    const sources: SourceDto[] = retrieval.hits.map((hit, index) => ({
      label: `S${index + 1}`,
      documentId: hit.documentId,
      fileName: hit.fileName,
      pageNumber: hit.pageNumber,
      snippet: hit.snippet,
      score: Number(hit.score.toFixed(6)),
    }));

    const result = await complete(
      GROUNDING_SYSTEM_PROMPT,
      buildAnswerPrompt({ question, history, hits: retrieval.hits }),
    );
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }

    let answer = stripUnknownSourceLabels(result.text, sources.length);
    if (maxPage > 0) answer = stripOutOfRangePages(answer, maxPage);
    if (!answer) answer = NOT_FOUND_MESSAGE;

    const notFound = isNotFoundAnswer(answer);
    const finalSources = notFound ? [] : sources;

    await ctx.runMutation(internal.conversations.appendAssistant, {
      conversationId: args.conversationId,
      userId,
      content: answer,
      sources: finalSources,
    });
    await ctx.runMutation(internal.conversations.rememberDocuments, {
      conversationId: args.conversationId,
      userId,
      documentIds: readyIds,
    });

    return { ok: true, answer, sources: finalSources, notFound };
  },
});

/** Generates (and stores) a grounded summary for one document. */
export const summarize = action({
  args: { documentId: v.id("documents") },
  handler: async (ctx: ActionCtx, args): Promise<SummaryResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        ok: false,
        code: "unauthenticated",
        message: "Sign in to generate summaries.",
      };
    }

    const doc = await ctx.runQuery(internal.documents.getById, {
      id: args.documentId,
    });
    if (!doc || doc.userId !== userId) {
      return { ok: false, code: "invalid", message: "Document not found." };
    }
    if (doc.status !== "ready") {
      return {
        ok: false,
        code: "not_ready",
        message: "This document is still processing.",
      };
    }

    const pages = await ctx.runQuery(internal.documents.pagesForDocument, {
      documentId: args.documentId,
    });
    const source = buildDocumentSourceText(pages, SUMMARY_MAX_CHARS);
    if (!source.text.trim()) {
      return {
        ok: false,
        code: "empty",
        message: "No extractable text is available for this document.",
      };
    }

    const result = await complete(
      SUMMARY_SYSTEM_PROMPT,
      buildSummaryPrompt({
        fileName: doc.fileName,
        pageCount: doc.pageCount,
        sourceText: source.text,
        truncatedPages: source.truncatedPages,
      }),
    );
    if (!result.ok) return { ok: false, code: result.code, message: result.message };

    const summary = stripOutOfRangePages(result.text, doc.pageCount);
    if (!summary) {
      return {
        ok: false,
        code: "ai_failed",
        message: "The summary came back empty. Please try again.",
      };
    }

    await ctx.runMutation(internal.documents.setSummary, {
      documentId: args.documentId,
      summary,
    });
    return { ok: true, summary };
  },
});

/** Structured side-by-side comparison of two documents. */
export const compare = action({
  args: {
    documentIdA: v.id("documents"),
    documentIdB: v.id("documents"),
  },
  handler: async (ctx, args): Promise<CompareResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        ok: false,
        code: "unauthenticated",
        message: "Sign in to compare documents.",
      };
    }
    if (args.documentIdA === args.documentIdB) {
      return {
        ok: false,
        code: "invalid",
        message: "Choose two different documents to compare.",
      };
    }

    const documents = await ctx.runQuery(internal.documents.getMany, {
      ids: [args.documentIdA, args.documentIdB],
    });
    const docA = documents.find((doc) => doc._id === args.documentIdA);
    const docB = documents.find((doc) => doc._id === args.documentIdB);
    if (!docA || !docB || docA.userId !== userId || docB.userId !== userId) {
      return { ok: false, code: "invalid", message: "Document not found." };
    }
    if (docA.status !== "ready" || docB.status !== "ready") {
      return {
        ok: false,
        code: "not_ready",
        message: "Both documents must finish processing before comparing.",
      };
    }

    const pagesA = await ctx.runQuery(internal.documents.pagesForDocument, {
      documentId: docA._id,
    });
    const pagesB = await ctx.runQuery(internal.documents.pagesForDocument, {
      documentId: docB._id,
    });
    const sourceA = buildDocumentSourceText(pagesA, COMPARISON_MAX_CHARS);
    const sourceB = buildDocumentSourceText(pagesB, COMPARISON_MAX_CHARS);

    const result = await complete(
      COMPARISON_SYSTEM_PROMPT,
      buildComparisonPrompt({
        fileNameA: docA.fileName,
        pageCountA: docA.pageCount,
        sourceTextA: sourceA.text,
        truncatedPagesA: sourceA.truncatedPages,
        fileNameB: docB.fileName,
        pageCountB: docB.pageCount,
        sourceTextB: sourceB.text,
        truncatedPagesB: sourceB.truncatedPages,
      }),
    );
    if (!result.ok) return { ok: false, code: result.code, message: result.message };

    const parsed = parseComparisonRows(result.text);
    if ("error" in parsed) {
      return { ok: false, code: "ai_failed", message: parsed.error };
    }

    const cleanCell = (text: string, pageCount: number) => {
      let value = stripUnknownSourceLabels(text, 0);
      value = stripOutOfRangePages(value, pageCount);
      return value || NOT_SPECIFIED;
    };

    return {
      ok: true,
      documentA: { fileName: docA.fileName, pageCount: docA.pageCount },
      documentB: { fileName: docB.fileName, pageCount: docB.pageCount },
      rows: parsed.rows.map((row) => ({
        category: row.category,
        a: cleanCell(row.a, docA.pageCount),
        b: cleanCell(row.b, docB.pageCount),
      })),
    };
  },
});
