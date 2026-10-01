import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  bm25Scores,
  embedText,
  EMBEDDER_ID,
  makeSnippet,
  tokenize,
} from "./text";

export interface RetrievalHit {
  chunkId: Id<"chunks">;
  documentId: Id<"documents">;
  fileName: string;
  pageNumber: number;
  text: string;
  snippet: string;
  /** Reciprocal-rank-fusion score (lexical + vector). */
  score: number;
  /** Raw cosine similarity, 0 when the vector index was not used. */
  vectorScore: number;
  /** Raw BM25 score. */
  lexicalScore: number;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** False when the vector index was unavailable and only BM25 was used. */
  usedVectorSearch: boolean;
  /** Chunks considered before relevance filtering. */
  candidateCount: number;
}

const RRF_K = 60;
/** Minimum cosine similarity for a vector-only hit to count as relevant. */
const VECTOR_FLOOR = 0.14;
/** BM25 is strictly positive when at least one query term matches. */
const LEXICAL_FLOOR = 0.01;
const VECTOR_LIMIT = 48;

/**
 * Hybrid retrieval: BM25 over the selected documents plus a filtered vector
 * search through the Convex vector index, fused with reciprocal rank fusion.
 *
 * Never throws: if the vector index is unavailable the lexical ranker still
 * returns results, so the assistant degrades instead of failing.
 */
export async function retrieve(
  ctx: ActionCtx,
  args: {
    /** The signed-in user: only their documents are ever searched. */
    userId: string;
    documentIds: Id<"documents">[];
    query: string;
    limit?: number;
  },
): Promise<RetrievalResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 6, 20));
  const queryTokens = tokenize(args.query);

  if (args.documentIds.length === 0 || queryTokens.length === 0) {
    return { hits: [], usedVectorSearch: false, candidateCount: 0 };
  }

  const documents = await ctx.runQuery(internal.documents.getMany, {
    ids: args.documentIds,
  });
  const ready = documents.filter(
    (doc) => doc.status === "ready" && doc.userId === args.userId,
  );
  if (ready.length === 0) {
    return { hits: [], usedVectorSearch: false, candidateCount: 0 };
  }
  const fileNames = new Map<Id<"documents">, string>(
    ready.map((doc) => [doc._id, doc.fileName]),
  );

  const chunks = await ctx.runQuery(internal.documents.chunksForDocuments, {
    documentIds: ready.map((doc) => doc._id),
  });
  if (chunks.length === 0) {
    return { hits: [], usedVectorSearch: false, candidateCount: 0 };
  }

  // --- Lexical ranker (always available) ---------------------------------
  const lexicalScores = bm25Scores(
    queryTokens,
    chunks.map((chunk) => ({
      id: chunk._id as string,
      tokens: tokenize(chunk.text),
      length: chunk.tokenCount,
    })),
  );
  const lexicalRanks = new Map<string, number>();
  const lexicalByChunk = new Map<string, number>();
  chunks
    .map((chunk, index) => ({ chunkId: chunk._id as string, score: lexicalScores[index] }))
    .sort((a, b) => b.score - a.score)
    .forEach((entry, rank) => {
      lexicalRanks.set(entry.chunkId, rank);
      lexicalByChunk.set(entry.chunkId, entry.score);
    });

  // --- Vector ranker (best effort) ---------------------------------------
  const vectorDocuments = ready.filter(
    (doc) => (doc.embeddingMode ?? EMBEDDER_ID) === EMBEDDER_ID,
  );
  const vectorRanks = new Map<string, number>();
  const vectorByChunk = new Map<string, number>();
  let usedVectorSearch = false;

  if (vectorDocuments.length > 0) {
    try {
      const results = await ctx.vectorSearch("chunks", "by_embedding", {
        vector: embedText(args.query),
        limit: VECTOR_LIMIT,
        filter: (q) =>
          q.or(...vectorDocuments.map((doc) => q.eq("documentId", doc._id))),
      });
      const detailChunks = await ctx.runQuery(
        internal.documents.chunksByIds,
        { ids: results.map((result) => result._id) },
      );
      const detailById = new Map<Id<"chunks">, (typeof detailChunks)[number]>(
        detailChunks.map((chunk) => [chunk._id, chunk]),
      );
      results.forEach((result, rank) => {
        const detail = detailById.get(result._id);
        if (!detail || !fileNames.has(detail.documentId)) return;
        vectorRanks.set(result._id as string, rank);
        vectorByChunk.set(result._id as string, result._score);
      });
      usedVectorSearch = true;
    } catch {
      // Vector index unavailable -> BM25-only retrieval.
      usedVectorSearch = false;
    }
  }

  // --- Reciprocal rank fusion + relevance floor ---------------------------
  const chunkById = new Map<Id<"chunks">, (typeof chunks)[number]>(
    chunks.map((chunk) => [chunk._id, chunk]),
  );
  const fused = new Map<string, number>();

  for (const [chunkId, rank] of lexicalRanks) {
    if ((lexicalByChunk.get(chunkId) ?? 0) < LEXICAL_FLOOR) continue;
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (RRF_K + rank + 1));
  }
  for (const [chunkId, rank] of vectorRanks) {
    if ((vectorByChunk.get(chunkId) ?? 0) < VECTOR_FLOOR) continue;
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  const hits: RetrievalHit[] = [];
  for (const [chunkId, score] of fused) {
    const chunk = chunkById.get(chunkId as Id<"chunks">);
    if (!chunk) continue;
    const fileName = fileNames.get(chunk.documentId);
    if (!fileName) continue;
    hits.push({
      chunkId: chunk._id,
      documentId: chunk.documentId,
      fileName,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      snippet: makeSnippet(chunk.text, queryTokens),
      score,
      vectorScore: vectorByChunk.get(chunkId) ?? 0,
      lexicalScore: lexicalByChunk.get(chunkId) ?? 0,
    });
  }
  hits.sort((a, b) => b.score - a.score);

  return {
    hits: hits.slice(0, limit),
    usedVectorSearch,
    candidateCount: chunks.length,
  };
}
