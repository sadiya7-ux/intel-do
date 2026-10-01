import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { retrieve } from "./lib/retrieval";

export type SearchResponse =
  | {
      ok: true;
      usedVectorSearch: boolean;
      results: Array<{
        rank: number;
        documentId: string;
        fileName: string;
        pageNumber: number;
        snippet: string;
        score: number;
        vectorScore: number;
        lexicalScore: number;
      }>;
    }
  | { ok: false; code: string; message: string };

/**
 * Natural-language search across the selected documents. Pure retrieval -
 * no LLM call - so results are fast and always traceable to a real page.
 */
export const searchDocuments = action({
  args: {
    documentIds: v.array(v.id("documents")),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchResponse> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        ok: false,
        code: "unauthenticated",
        message: "Sign in to search documents.",
      };
    }

    const query = args.query.trim().slice(0, 500);
    if (query.length < 2) {
      return {
        ok: false,
        code: "invalid",
        message: "Enter a search query of at least two characters.",
      };
    }
    if (args.documentIds.length === 0) {
      return {
        ok: false,
        code: "no_documents",
        message: "Select at least one document to search.",
      };
    }

    const retrieval = await retrieve(ctx, {
      userId,
      documentIds: args.documentIds,
      query,
      limit: args.limit ?? 8,
    });

    return {
      ok: true,
      usedVectorSearch: retrieval.usedVectorSearch,
      results: retrieval.hits.map((hit, index) => ({
        rank: index + 1,
        documentId: hit.documentId as string,
        fileName: hit.fileName,
        pageNumber: hit.pageNumber,
        snippet: hit.snippet,
        score: Number(hit.score.toFixed(6)),
        vectorScore: Number(hit.vectorScore.toFixed(4)),
        lexicalScore: Number(hit.lexicalScore.toFixed(4)),
      })),
    };
  },
});
