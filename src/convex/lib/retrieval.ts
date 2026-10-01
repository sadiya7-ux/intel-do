import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  bm25Scores,
  embedText,
  EMBEDDER_ID,
  expandQuery,
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
/**
 * Minimum cosine similarity for a vector-only hit to count as relevant.
 * Unrelated queries score ~0.07 against the corpus (see scripts/rag-sanity.ts).
 */
export const VECTOR_FLOOR = 0.14;
/** BM25 is strictly positive when at least one query term matches. */
export const LEXICAL_FLOOR = 0.01;
/**
 * Candidate pool fetched from the vector index before any relevance floor is
 * applied. Kept well above the number of returned hits so paraphrased queries
 * still find their page even when the best match ranks mid-list.
 */
export const VECTOR_CANDIDATE_LIMIT = 200;

/** One candidate considered by the fusion stage. */
export interface FusionChunk {
  id: string;
  documentId: string;
  pageNumber: number;
  text: string;
  /** BM25 score over the expanded query. */
  lexicalScore: number;
  /** Cosine similarity; present only for chunks returned by the vector index. */
  vectorScore?: number;
}

export interface FusionArgs {
  chunks: FusionChunk[];
  /** documentId -> fileName, used for citation labels. */
  fileNames: Map<string, string>;
  /** Expanded query tokens (original wording + synonyms). */
  queryTokens: string[];
  limit: number;
}

/**
 * Reciprocal rank fusion over the full candidate pool, followed by the
 * relevance floors. A candidate is kept when EITHER ranker considers it
 * relevant — BM25 above LEXICAL_FLOOR or cosine above VECTOR_FLOOR — so
 * paraphrase hits rescued by query expansion survive even when semantic
 * similarity is weak, and hits with only weak lexical support still drop out.
 *
 * Returns [] when nothing clears a floor, which is what triggers the
 * deterministic grounded refusal upstream. Never throws, never invents text:
 * every hit carries the real chunk text, page number and file name.
 */
export function fuseCandidates(args: FusionArgs): RetrievalHit[] {
  const { chunks, fileNames, queryTokens, limit } = args;

  const lexicalRanks = new Map<string, number>();
  [...chunks]
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .forEach((chunk, rank) => lexicalRanks.set(chunk.id, rank));

  const vectorRanks = new Map<string, number>();
  chunks
    .filter((chunk) => chunk.vectorScore !== undefined)
    .sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0))
    .forEach((chunk, rank) => vectorRanks.set(chunk.id, rank));

  const fused = new Map<string, number>();
  const add = (id: string, rank: number) => {
    fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  };

  for (const chunk of chunks) {
    if (chunk.lexicalScore >= LEXICAL_FLOOR) {
      add(chunk.id, lexicalRanks.get(chunk.id) ?? 0);
    }
    if (chunk.vectorScore !== undefined && chunk.vectorScore >= VECTOR_FLOOR) {
      add(chunk.id, vectorRanks.get(chunk.id) ?? 0);
    }
  }

  const hits: RetrievalHit[] = [];
  for (const chunk of chunks) {
    const score = fused.get(chunk.id);
    if (score === undefined) continue;
    const fileName = fileNames.get(chunk.documentId);
    if (!fileName) continue;
    hits.push({
      chunkId: chunk.id as Id<"chunks">,
      documentId: chunk.documentId as Id<"documents">,
      fileName,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      snippet: makeSnippet(chunk.text, queryTokens),
      score,
      vectorScore: chunk.vectorScore ?? 0,
      lexicalScore: chunk.lexicalScore,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Hybrid retrieval: BM25 over the selected documents plus a filtered vector
 * search through the Convex vector index, fused with reciprocal rank fusion.
 *
 * The question is normalised and expanded with synonyms first (see
 * expandQuery), so paraphrases like "last date" match "submission deadline"
 * in the document wording. Both rankers run over an enlarged candidate pool
 * before the relevance floors are applied in fuseCandidates.
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
  const expanded = expandQuery(args.query);
  const queryTokens = expanded.tokens;

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
  const fileNames = new Map<string, string>(
    ready.map((doc) => [doc._id as string, doc.fileName]),
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

  // --- Vector ranker (best effort, enlarged candidate pool) ---------------
  const vectorDocuments = ready.filter(
    (doc) => (doc.embeddingMode ?? EMBEDDER_ID) === EMBEDDER_ID,
  );
  const vectorScores = new Map<string, number>();
  let usedVectorSearch = false;

  if (vectorDocuments.length > 0) {
    try {
      const results = await ctx.vectorSearch("chunks", "by_embedding", {
        vector: embedText(expanded.text),
        limit: VECTOR_CANDIDATE_LIMIT,
        filter: (q) =>
          q.or(...vectorDocuments.map((doc) => q.eq("documentId", doc._id))),
      });
      const chunkIds = new Set(chunks.map((chunk) => chunk._id as string));
      for (const result of results) {
        const id = result._id as string;
        if (chunkIds.has(id)) vectorScores.set(id, result._score);
      }
      usedVectorSearch = true;
    } catch {
      // Vector index unavailable -> BM25-only retrieval.
      usedVectorSearch = false;
    }
  }

  // --- Reciprocal rank fusion + relevance floors ---------------------------
  const hits = fuseCandidates({
    chunks: chunks.map((chunk, index) => ({
      id: chunk._id as string,
      documentId: chunk.documentId as string,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      lexicalScore: lexicalScores[index] ?? 0,
      vectorScore: vectorScores.get(chunk._id as string),
    })),
    fileNames,
    queryTokens,
    limit,
  });

  return {
    hits,
    usedVectorSearch,
    candidateCount: chunks.length,
  };
}
