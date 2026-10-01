/**
 * Standalone sanity check for the ASTRA INTEL retrieval core.
 * Run with: bun scripts/rag-sanity.ts
 *
 * Verifies that page-aware chunking, the hashing embedder and BM25 behave
 * the way the grounding pipeline depends on:
 *   1. chunks never cross a page boundary,
 *   2. a document-related question ranks the right page first,
 *   3. an unrelated question scores ~0 so the assistant can refuse.
 */
import {
  bm25Scores,
  chunkPages,
  embedText,
  EMBEDDING_DIMS,
  tokenize,
} from "../src/convex/lib/text";

const PAGES = [
  {
    pageNumber: 1,
    text: `ASTRA Sentinel Programme Overview

The ASTRA Sentinel programme evaluates autonomous surveillance systems for
maritime border protection. The main objective of the programme is to provide
persistent wide-area awareness using uncrewed surface vessels.

The programme is scheduled for three phases and is managed by the Directorate
of Naval Systems.`,
  },
  {
    pageNumber: 2,
    text: `Radar Systems

The radar subsystem uses a gallium nitride active electronically scanned array
operating in the X band. Detection range is specified as 180 nautical miles
against surface targets. The radar supports simultaneous tracking of 400
contacts and updates once every 1.2 seconds.

Limitations include performance degradation in heavy sea state 6 conditions.`,
  },
  {
    pageNumber: 3,
    text: `Materials and Powertrain

The hull is constructed from carbon fibre reinforced polymer with a
gel-coated finish. Battery packs use lithium iron phosphate cells chosen for
thermal stability. The documented endurance is 45 days at cruising speed.`,
  },
];

let failures = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const chunks = chunkPages(PAGES);

console.log("Chunking");
check("produces chunks", chunks.length >= 3, `got ${chunks.length}`);
check(
  "every chunk stays on one real page",
  chunks.every((chunk) =>
    PAGES.some((page) => page.pageNumber === chunk.pageNumber),
  ),
);
check(
  "page numbers only come from the source pages",
  chunks.every((chunk) => [1, 2, 3].includes(chunk.pageNumber)),
);
check(
  "chunks are within the size window",
  chunks.every((chunk) => chunk.text.length <= 1900),
);
check(
  "page 2 content is chunked under page 2",
  chunks.some(
    (chunk) => chunk.pageNumber === 2 && chunk.text.includes("gallium nitride"),
  ),
);

console.log("\nEmbeddings");
const vectorA = embedText("radar detection range nautical miles");
const vectorB = embedText("radar detection range nautical miles");
const vectorOther = embedText("strawberry jam recipe butter flour");
check("is deterministic", vectorA.every((v, i) => v === vectorB[i]));
check(
  "has the schema dimension",
  vectorA.length === EMBEDDING_DIMS,
  `got ${vectorA.length}`,
);
const norm = Math.sqrt(vectorA.reduce((sum, v) => sum + v * v, 0));
check("is L2 normalised", Math.abs(norm - 1) < 1e-9, `norm=${norm}`);
const cosine = (x: number[], y: number[]) =>
  x.reduce((sum, value, i) => sum + value * y[i], 0);
const related = cosine(embedText("what is the radar detection range?"), vectorA);
const unrelated = cosine(vectorOther, vectorA);
check(
  "related text scores much higher than unrelated text",
  related > unrelated + 0.1,
  `related=${related.toFixed(3)} unrelated=${unrelated.toFixed(3)}`,
);

console.log("\nBM25 + ranking");
const query = "What are the limitations of the radar system?";
const queryTokens = tokenize(query);
const scores = bm25Scores(
  queryTokens,
  chunks.map((chunk, index) => ({
    id: String(index),
    tokens: tokenize(chunk.text),
    length: chunk.tokenCount,
  })),
);
const bestIndex = scores.indexOf(Math.max(...scores));
check(
  "question about radar limitations ranks page 2 first",
  chunks[bestIndex]?.pageNumber === 2,
  `best page=${chunks[bestIndex]?.pageNumber} score=${scores[bestIndex]?.toFixed(3)}`,
);
check("matched page 2 scores above the relevance floor", (scores[bestIndex] ?? 0) > 0.01);

const offTopicTokens = tokenize("what is the capital of france");
const offTopicScores = bm25Scores(
  offTopicTokens,
  chunks.map((chunk, index) => ({
    id: String(index),
    tokens: tokenize(chunk.text),
    length: chunk.tokenCount,
  })),
);
const offTopicBest = Math.max(...offTopicScores, 0);
const chunkVectors = chunks.map((chunk) => embedText(chunk.text));
const offTopicVector = Math.max(
  ...chunkVectors.map((vector) => cosine(embedText("what is the capital of france"), vector)),
);
check(
  "unrelated question scores below the lexical floor",
  offTopicBest < 0.01,
  `bm25=${offTopicBest.toFixed(4)}`,
);
check(
  "unrelated question scores below the vector floor",
  offTopicVector < 0.14,
  `cosine=${offTopicVector.toFixed(3)}`,
);

console.log(
  failures === 0
    ? "\nAll retrieval sanity checks passed."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
