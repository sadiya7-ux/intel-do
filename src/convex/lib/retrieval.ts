import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  bm25Scores,
  embedText,
  EMBEDDER_ID,
  expandQuery,
  extractHeadingTerms,
  extractHeadings,
  hasListBody,
  makeSnippet,
  rawWords,
  matchHeadings,
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
  /** Section-heading affinity in [0, 1]. */
  headingScore: number;
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
/**
 * Weight of the section-heading ranker in the fusion. A chunk whose heading
 * matches the section the question names outranks a chunk that merely mentions
 * the same words, while still being outranked by nothing stronger than a full
 * hit from both BM25 and the vector index.
 */
export const HEADING_WEIGHT = 2.5;
/**
 * Minimum heading affinity for a chunk to be admitted on the strength of its
 * heading alone. Only an explicit, exact section match ("MUST HAVE" for the
 * question about MUST-HAVE) reaches this, so loose heading overlaps never
 * weaken the grounded refusal.
 */
export const HEADING_ADMIT_THRESHOLD = 0.7;
/**
 * Fraction of chunks that may contain a token in their headings before it
 * stops counting as a distinctive section signal ("features" is too common,
 * "bonus" is not). At least two chunks are always allowed so a section that
 * appears on two pages still counts as distinctive.
 */
const HEADING_DF_CEILING = 0.35;

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
  /** Section-heading affinity in [0, 1]; never admits a chunk by itself. */
  headingScore?: number;
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
 * Section-heading matches add a third, weighted list that re-ranks those
 * candidates towards the section the question explicitly named. A chunk can
 * only enter on its heading when the user named that section outright (score
 * at or above HEADING_ADMIT_THRESHOLD), which never happens for a loose
 * overlap, so grounded refusal is unchanged.
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
  const add = (id: string, contribution: number) => {
    fused.set(id, (fused.get(id) ?? 0) + contribution);
  };
  const rrf = (rank: number, weight = 1) => weight / (RRF_K + rank + 1);

  // Section-heading ranker: the section a question names comes first.
  const headingRanks = new Map<string, number>();
  chunks
    .filter((chunk) => (chunk.headingScore ?? 0) > 0)
    .sort((a, b) => (b.headingScore ?? 0) - (a.headingScore ?? 0))
    .forEach((chunk, rank) => headingRanks.set(chunk.id, rank));

  for (const chunk of chunks) {
    const relevant =
      chunk.lexicalScore >= LEXICAL_FLOOR ||
      (chunk.vectorScore ?? 0) >= VECTOR_FLOOR ||
      (chunk.headingScore ?? 0) >= HEADING_ADMIT_THRESHOLD;
    if (!relevant) continue;

    if (chunk.lexicalScore >= LEXICAL_FLOOR) {
      add(chunk.id, rrf(lexicalRanks.get(chunk.id) ?? 0));
    }
    if ((chunk.vectorScore ?? 0) >= VECTOR_FLOOR) {
      add(chunk.id, rrf(vectorRanks.get(chunk.id) ?? 0));
    }
    const headingRank = headingRanks.get(chunk.id);
    if (headingRank !== undefined) {
      // Squared so a weak heading overlap can never outweigh a strong lexical
      // or semantic match, while a real section match still leads.
      const affinity = chunk.headingScore ?? 0;
      add(chunk.id, rrf(headingRank, HEADING_WEIGHT * affinity * affinity));
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
      headingScore: chunk.headingScore ?? 0,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Section-heading affinity for every chunk of the corpus, in [0, 1].
 *
 * Detects headings inside the chunk text, then measures how strongly the
 * question names that section - both through all-caps heading phrases the user
 * typed ("MUST-HAVE", "ASTRA INTEL") and through distinctive question tokens
 * that appear in a heading ("bonus" -> the BONUS section). The boost is carried
 * to the next chunk of the same page, because a heading and the list it
 * introduces are frequently split across two chunks.
 */
export function headingScores(args: {
  chunkTexts: string[];
  pageNumbers: number[];
  query: string;
}): number[] {
  const headingsPerChunk = args.chunkTexts.map((text) => extractHeadings(text));
  const terms = extractHeadingTerms(args.query);
  const chunkWords = args.chunkTexts.map((text) => rawWords(text));
  const chunkTokenSets = args.chunkTexts.map((text) => new Set(tokenize(text)));

  const headingDf = new Map<string, number>();
  for (const headings of headingsPerChunk) {
    const seen = new Set<string>();
    for (const heading of headings) {
      for (const word of heading.split(" ")) {
        if (seen.has(word)) continue;
        seen.add(word);
        headingDf.set(word, (headingDf.get(word) ?? 0) + 1);
      }
    }
  }

  const ceiling = Math.max(2, headingsPerChunk.length * HEADING_DF_CEILING);
  const distinctiveTokens = Array.from(new Set(tokenize(args.query))).filter(
    (token) => (headingDf.get(token) ?? 0) <= ceiling,
  );
  // A token that names exactly one heading in the whole corpus ("DEADLINE",
  // "BONUS") is a section name the question referred to, not a loose overlap.
  const rareTokens = new Set(
    distinctiveTokens.filter((token) => (headingDf.get(token) ?? 0) <= 1),
  );

  const scores = headingsPerChunk.map((headings, index) => {
    const tokenSet = chunkTokenSets[index];
    const covered = distinctiveTokens.filter((token) => tokenSet.has(token)).length;
    return matchHeadings({
      headings,
      terms,
      tokens: distinctiveTokens,
      rareTokens,
      coverage: distinctiveTokens.length > 0 ? covered / distinctiveTokens.length : 0,
      hasBody: hasListBody(args.chunkTexts[index] ?? ""),
      chunkWords: chunkWords[index],
    });
  });

  // A section title at the end of the previous chunk names the section that
  // the current chunk continues, so a heading match there is corroborated by
  // the document's own reading order.
  for (let index = 1; index < scores.length; index++) {
    if (scores[index] === 0 || scores[index] >= 1) continue;
    const previous = chunkWords[index - 1];
    if (!previous) continue;
    const continuesSection = terms.some((term) =>
      term.split(" ").every((word) => previous.has(word.toLowerCase())),
    );
    if (continuesSection) scores[index] = Math.min(1, scores[index] * 1.15);
  }

  for (let index = 1; index < scores.length; index++) {
    const previous = scores[index - 1] ?? 0;
    if (
      previous > 0 &&
      scores[index] === 0 &&
      args.pageNumbers[index] === args.pageNumbers[index - 1]
    ) {
      scores[index] = previous * 0.95;
    }
  }

  return scores;
}

const COORDINATION_WEIGHT = 0.2;

/**
 * Rewards chunks that match more of the question's terms. BM25 saturates on
 * repetition, so without this a page that repeats one term many times (a
 * checklist full of "submitted") can outrank the page that answers two
 * different parts of the question ("submission" + "deadline").
 */
function withCoordination(
  scores: number[],
  queryTokens: string[],
  corpus: Array<{ id: string; tokens: string[]; length: number }>,
  weight = COORDINATION_WEIGHT,
): number[] {
  const unique = Array.from(new Set(queryTokens));
  if (unique.length <= 1) return scores;

  const matched = new Array<number>(scores.length).fill(0);
  for (const token of unique) {
    const perChunk = bm25Scores([token], corpus);
    for (let index = 0; index < perChunk.length; index++) {
      if (perChunk[index] > 0) matched[index] += 1;
    }
  }

  return scores.map((score, index) =>
    score > 0 && matched[index] > 1
      ? score * (1 + weight * (matched[index] - 1))
      : score,
  );
}

export interface ChunkSignals {
  /** BM25 score per chunk, in input order. */
  lexicalScores: number[];
  /** Section-heading affinity per chunk, in input order. */
  headingScores: number[];
  /** Query tokens after synonym expansion (original wording + synonyms). */
  expandedTokens: string[];
  /** Expanded query text, used for the vector search. */
  expandedText: string;
}

/**
 * Lexical and section-heading signals for a whole corpus.
 *
 * Synonym expansions are a recall aid, not a ranking signal: they only drive
 * BM25 when the user's own wording matches nothing, so a rare expansion word
 * can never outrank a chunk containing the words that were actually typed.
 * Shared by retrieve() and scripts/rag-sanity.ts so both run identical logic.
 */
export function chunkSignals(args: {
  chunkTexts: string[];
  pageNumbers: number[];
  tokenCounts: number[];
  query: string;
}): ChunkSignals {
  const corpus = args.chunkTexts.map((text, index) => ({
    id: String(index),
    tokens: tokenize(text),
    length: args.tokenCounts[index] ?? tokenize(text).length,
  }));

  const expanded = expandQuery(args.query);
  // Words the user typed as a section heading ("ASTRA INTEL") are matched
  // against headings and section context, not treated as body keywords, so a
  // branding page cannot outrank the section itself on "ASTRA" alone.
  const termWords = new Set(
    extractHeadingTerms(args.query)
      .flatMap((term) => term.toLowerCase().split(/\s+/))
      .filter(Boolean),
  );
  const directTokens = tokenize(args.query).filter((token) => !termWords.has(token));
  const directScores = bm25Scores(directTokens, corpus);
  const directBest = Math.max(0, ...directScores);
  const lexicalScores =
    directBest > 0 ? directScores : bm25Scores(expanded.tokens, corpus);
  const lexical = withCoordination(
    lexicalScores,
    directBest > 0 ? directTokens : expanded.tokens,
    corpus,
  );

  return {
    lexicalScores: lexical,
    headingScores: headingScores({
      chunkTexts: args.chunkTexts,
      pageNumbers: args.pageNumbers,
      query: args.query,
    }),
    expandedTokens: expanded.tokens,
    expandedText: expanded.text,
  };
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
  const signals = chunkSignals({
    chunkTexts: chunks.map((chunk) => chunk.text),
    pageNumbers: chunks.map((chunk) => chunk.pageNumber),
    tokenCounts: chunks.map((chunk) => chunk.tokenCount),
    query: args.query,
  });
  const lexicalScores = signals.lexicalScores;

  // --- Vector ranker (best effort, enlarged candidate pool) ---------------
  const vectorDocuments = ready.filter(
    (doc) => (doc.embeddingMode ?? EMBEDDER_ID) === EMBEDDER_ID,
  );
  const vectorScores = new Map<string, number>();
  let usedVectorSearch = false;

  if (vectorDocuments.length > 0) {
    try {
      const results = await ctx.vectorSearch("chunks", "by_embedding", {
        vector: embedText(signals.expandedText),
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

  // --- Section-heading ranker ----------------------------------------------
  const scores = signals.headingScores;

  // --- Reciprocal rank fusion + relevance floors ---------------------------
  const hits = fuseCandidates({
    chunks: chunks.map((chunk, index) => ({
      id: chunk._id as string,
      documentId: chunk.documentId as string,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      lexicalScore: lexicalScores[index] ?? 0,
      vectorScore: vectorScores.get(chunk._id as string),
      headingScore: scores[index] ?? 0,
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
