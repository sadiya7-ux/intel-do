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
  expandQuery,
  tokenize,
} from "../src/convex/lib/text";
import {
  chunkSignals,
  fuseCandidates,
  LEXICAL_FLOOR,
  VECTOR_FLOOR,
} from "../src/convex/lib/retrieval";

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
  {
    pageNumber: 4,
    text: `Project Schedule

The submission deadline for the ASTRA project report is 1 October 2026.
All deliverables must be uploaded before close of business on the due date.

Late submissions are not accepted by the programme office.`,
  },
  {
    pageNumber: 5,
    text: `The Three Challenges

Pick ONE. Each is structured as:

MUST HAVE — required for a valid submission

SHOULD HAVE — demonstrates stronger engineering

BONUS — demonstrates exceptional initiative (never mandatory)

CHALLENGE 01 — ASTRA INTEL

AI-Powered Defence Document Intelligence System

Problem

Defence and technology organizations handle large volumes of reports and PDFs.
Finding relevant information manually is slow.`,
  },
  {
    pageNumber: 6,
    text: `MUST HAVE

1. Upload a PDF/document.

2. Extract and process its content.

3. Generate a concise summary.

4. Let the user ask questions about the uploaded document.

5. Answer based only on the provided document.

SHOULD HAVE

Usable interface with basic error states. Multi-turn conversation with visible
history. Page-level citations on answers.

BONUS — demonstrates exceptional initiative (never mandatory)

8.7 Final Submission Checklist

Before submitting, verify:

GitHub repository submitted. Project runs successfully. README completed.
Architecture diagram included.`,
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
  chunks.every((chunk) => [1, 2, 3, 4, 5, 6].includes(chunk.pageNumber)),
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
const queryTokens = expandQuery(query).tokens;
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

const offTopicQuery = "what is the capital of france";
const offTopicExpanded = expandQuery(offTopicQuery);
check(
  "unrelated question gains no synonym expansions",
  offTopicExpanded.added.length === 0,
  `added=[${offTopicExpanded.added.join(", ")}]`,
);
const offTopicScores = bm25Scores(
  offTopicExpanded.tokens,
  chunks.map((chunk, index) => ({
    id: String(index),
    tokens: tokenize(chunk.text),
    length: chunk.tokenCount,
  })),
);
const offTopicBest = Math.max(...offTopicScores, 0);
const chunkVectors = chunks.map((chunk) => embedText(chunk.text));
const offTopicVector = Math.max(
  ...chunkVectors.map((vector) => cosine(embedText(offTopicQuery), vector)),
);
check(
  "unrelated question scores below the lexical floor",
  offTopicBest < LEXICAL_FLOOR,
  `bm25=${offTopicBest.toFixed(4)}`,
);
check(
  "unrelated question scores below the vector floor",
  offTopicVector < VECTOR_FLOOR,
  `cosine=${offTopicVector.toFixed(3)}`,
);

const offTopicFusion = fuseCandidates({
  chunks: chunks.map((chunk, index) => ({
    id: String(index),
    documentId: "doc-1",
    pageNumber: chunk.pageNumber,
    text: chunk.text,
    lexicalScore: offTopicScores[index] ?? 0,
    vectorScore: cosine(embedText(offTopicExpanded.text), chunkVectors[index]),
  })),
  fileNames: new Map([["doc-1", "ASTRA.pdf"]]),
  queryTokens: offTopicExpanded.tokens,
  limit: 6,
});
check(
  "unrelated question retrieves nothing, so the refusal still fires",
  offTopicFusion.length === 0,
  `hits=${offTopicFusion.length}`,
);

console.log("\nParaphrase retrieval (query expansion)");
const paraphrase = "What is the last date to submit the project?";
const expanded = expandQuery(paraphrase);
check(
  "paraphrase expands to the deadline concept",
  expanded.added.includes("deadline") && expanded.added.includes("submission"),
  `added=[${expanded.added.join(", ")}]`,
);

const paraLexical = bm25Scores(
  expanded.tokens,
  chunks.map((chunk, index) => ({
    id: String(index),
    tokens: tokenize(chunk.text),
    length: chunk.tokenCount,
  })),
);
const paraVectorFor = (text: string) =>
  chunks.map((chunk) => cosine(embedText(text), embedText(chunk.text)));
const paraVectors = paraVectorFor(expanded.text);
const fileNames = new Map([["doc-1", "ASTRA.pdf"]]);
const fusionInput = (withVector: boolean) => ({
  chunks: chunks.map((chunk, index) => ({
    id: String(index),
    documentId: "doc-1",
    pageNumber: chunk.pageNumber,
    text: chunk.text,
    lexicalScore: paraLexical[index] ?? 0,
    ...(withVector ? { vectorScore: paraVectors[index] } : {}),
  })),
  fileNames,
  queryTokens: expanded.tokens,
  limit: 6,
});

const paraphraseHits = fuseCandidates(fusionInput(true));
check(
  "retrieves the deadline page first",
  paraphraseHits[0]?.pageNumber === 4,
  `top page=${paraphraseHits[0]?.pageNumber} score=${paraphraseHits[0]?.score.toFixed(4)}`,
);
check(
  "retrieved page contains the exact date from the PDF",
  (paraphraseHits[0]?.text ?? "").includes("1 October 2026"),
);
check(
  "citation keeps the document name and page number",
  paraphraseHits[0]?.fileName === "ASTRA.pdf" &&
    paraphraseHits[0]?.pageNumber === 4,
  `file=${paraphraseHits[0]?.fileName} page=${paraphraseHits[0]?.pageNumber}`,
);
const page4Index = chunks.findIndex((chunk) => chunk.pageNumber === 4);
check(
  "deadline chunk scores above the lexical relevance floor",
  (paraLexical[page4Index] ?? 0) >= LEXICAL_FLOOR,
  `bm25=${(paraLexical[page4Index] ?? 0).toFixed(3)} (page 4 chunk)`,
);

const lexicalOnlyHits = fuseCandidates(fusionInput(false));
check(
  "kept by BM25 alone when semantic similarity is weak",
  lexicalOnlyHits[0]?.pageNumber === 4,
  `top page=${lexicalOnlyHits[0]?.pageNumber}`,
);

console.log("\nSection headings (structured questions)");
/** Runs the production retrieval pipeline over the fixture corpus. */
function runRetrieval(question: string) {
  const signals = chunkSignals({
    chunkTexts: chunks.map((chunk) => chunk.text),
    pageNumbers: chunks.map((chunk) => chunk.pageNumber),
    tokenCounts: chunks.map((chunk) => chunk.tokenCount),
    query: question,
  });
  return fuseCandidates({
    chunks: chunks.map((chunk, index) => ({
      id: String(index),
      documentId: "doc-1",
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      lexicalScore: signals.lexicalScores[index] ?? 0,
      vectorScore: cosine(embedText(signals.expandedText), embedText(chunk.text)),
      headingScore: signals.headingScores[index] ?? 0,
    })),
    fileNames: new Map([["doc-1", "ASTRA.pdf"]]),
    queryTokens: signals.expandedTokens,
    limit: 6,
  });
}

const mustHave = runRetrieval("What are the MUST-HAVE features for ASTRA INTEL?");
check(
  "MUST-HAVE question retrieves a MUST HAVE section first",
  mustHave[0]?.text.includes("MUST HAVE") === true,
  `top page=${mustHave[0]?.pageNumber}`,
);
check(
  "the associated MUST-HAVE list is in the retrieved passages",
  mustHave.some((hit) => hit.text.includes("Upload a PDF")),
  `pages=${mustHave.map((hit) => hit.pageNumber).join(",")}`,
);
check(
  "MUST-HAVE citation keeps document name and page",
  mustHave[0]?.fileName === "ASTRA.pdf" && mustHave[0]?.pageNumber > 0,
);

const bonus = runRetrieval("What are the bonus features?");
check(
  "bonus question retrieves the BONUS section",
  bonus[0]?.text.includes("BONUS") === true,
  `top page=${bonus[0]?.pageNumber}`,
);

const submission = runRetrieval("What should the final submission contain?");
check(
  "final submission question retrieves the submission checklist",
  submission[0]?.text.includes("Final Submission Checklist") === true,
  `top page=${submission[0]?.pageNumber}`,
);

const deadline = runRetrieval("What is the submission deadline?");
check(
  "deadline question retrieves the deadline page",
  deadline[0]?.pageNumber === 4,
  `top page=${deadline[0]?.pageNumber}`,
);

const japan = runRetrieval("What is the population of Japan?");
check(
  "off-document question retrieves nothing, so refusal still fires",
  japan.length === 0,
  `hits=${japan.length}`,
);

console.log(
  failures === 0
    ? "\nAll retrieval sanity checks passed."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
