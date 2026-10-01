/**
 * Pure text utilities shared by ingestion and retrieval.
 *
 * No Convex or Node imports here, so the same code runs inside the default
 * Convex runtime and inside "use node" actions.
 *
 * Retrieval uses a hybrid of two cheap, deterministic rankers:
 *   1. dense vectors from a local feature-hashing embedder (cosine similarity
 *      through the Convex vector index), and
 *   2. BM25 lexical scoring computed over the selected documents.
 * The two ranked lists are fused with reciprocal rank fusion (RRF).
 */

/** Must match the `dimensions` of the vector index in schema.ts. */
export const EMBEDDING_DIMS = 2048;

/** Identifier of the embedder that produced a document's vectors. */
export const EMBEDDER_ID = "hashing-v1";

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am",
  "an", "and", "any", "are", "as", "at", "be", "because", "been", "before",
  "being", "below", "between", "both", "but", "by", "can", "cannot", "could",
  "did", "do", "does", "doing", "down", "during", "each", "either", "else",
  "enough", "etc", "for", "from", "further", "had", "has", "have", "having",
  "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
  "however", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
  "may", "me", "might", "more", "most", "must", "my", "myself", "neither",
  "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or",
  "other", "others", "ought", "our", "ours", "ourselves", "out", "over",
  "own", "rather", "same", "shall", "she", "should", "since", "so", "some",
  "such", "than", "that", "the", "their", "theirs", "them", "themselves",
  "then", "there", "therefore", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "whether", "which", "while", "who", "whom", "whose",
  "why", "will", "with", "within", "would", "you", "your", "yours",
]);

/** Conservative plural stripping so "systems"/"system" match each other. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (
    word.length > 5 &&
    word.endsWith("es") &&
    /(ses|xes|zes|ches|shes)$/.test(word)
  ) {
    return word.slice(0, -2);
  }
  if (
    word.length > 3 &&
    word.endsWith("s") &&
    !word.endsWith("ss") &&
    !word.endsWith("us")
  ) {
    return word.slice(0, -1);
  }
  return word;
}

/** Lowercase word tokens with stopwords removed and light stemming. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/);
  const tokens: string[] = [];
  for (const word of raw) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    tokens.push(stem(word));
  }
  return tokens;
}

/** Fixes common PDF extraction artifacts (hyphenation, stray whitespace). */
export function cleanPageText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/-\n(?=[a-z])/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PageInput {
  pageNumber: number;
  text: string;
}

export interface ChunkInput {
  pageNumber: number;
  chunkIndex: number;
  text: string;
  tokenCount: number;
}

const CHUNK_TARGET = 1100;
const CHUNK_MAX = 1700;
const CHUNK_MIN = 150;
const CHUNK_OVERLAP = 180;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

function splitBySentences(text: string, maxSize: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|\S+\s*/g) ?? [text];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (current && current.length + trimmed.length + 1 > maxSize) {
      pieces.push(current.trim());
      current = trimmed;
    } else {
      current = current ? `${current} ${trimmed}` : trimmed;
    }
  }
  if (current.trim()) pieces.push(current.trim());

  // Hard split anything that still exceeds the limit (no sentence markers).
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= CHUNK_MAX * 1.5) {
      out.push(piece);
      continue;
    }
    let rest = piece;
    while (rest.length > CHUNK_MAX) {
      let cut = rest.lastIndexOf(" ", CHUNK_MAX);
      if (cut < CHUNK_MIN) cut = CHUNK_MAX;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

function overlapTail(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text;
  const slice = text.slice(-CHUNK_OVERLAP);
  const boundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (boundary > 60) return slice.slice(boundary + 1).trim();
  const space = slice.indexOf(" ");
  return (space > -1 ? slice.slice(space + 1) : slice).trim();
}

/**
 * Splits extracted pages into chunks that never cross a page boundary, so
 * every chunk maps to exactly one real PDF page for citations.
 */
export function chunkPages(pages: PageInput[]): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  let chunkIndex = 0;

  const push = (pageNumber: number, text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 40) return;
    chunks.push({
      pageNumber,
      chunkIndex: chunkIndex++,
      text: trimmed,
      tokenCount: tokenize(trimmed).length,
    });
  };

  for (const page of pages) {
    const text = cleanPageText(page.text);
    if (text.length < 40) continue;

    let current = "";
    const flush = () => {
      const trimmed = current.trim();
      if (trimmed.length >= CHUNK_MIN) {
        push(page.pageNumber, trimmed);
        current = overlapTail(trimmed);
      } else if (trimmed.length >= 40) {
        push(page.pageNumber, trimmed);
        current = "";
      } else {
        current = "";
      }
    };

    for (const paragraph of splitParagraphs(text)) {
      if (paragraph.length > CHUNK_MAX) {
        flush();
        current = "";
        for (const piece of splitBySentences(paragraph, CHUNK_MAX)) {
          const next = current ? `${current} ${piece}` : piece;
          if (next.length > CHUNK_MAX) {
            push(page.pageNumber, next);
            current = overlapTail(next);
          } else {
            current = next;
          }
        }
        flush();
        continue;
      }
      if (
        current.length > 0 &&
        current.length + paragraph.length + 2 > CHUNK_TARGET
      ) {
        flush();
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return chunks;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addFeature(vector: number[], feature: string, weight: number) {
  const primary = fnv1a(feature);
  const secondary = fnv1a(`${feature}#s`);
  const index = primary % EMBEDDING_DIMS;
  const sign = secondary & 1 ? -1 : 1;
  vector[index] += weight * sign;
}

// Feature weights were tuned so unrelated queries stay well below the
// retrieval vector floor (max cosine ~0.07) while document-matched queries
// score 0.15-0.25. See scripts/rag-sanity.ts.
const UNIGRAM_WEIGHT = 1;
const BIGRAM_WEIGHT = 1.4;
const TRIGRAM_WEIGHT = 0.1;
const QUADGRAM_WEIGHT = 0.1;

/**
 * Local feature-hashing embedder: word unigrams, word bigrams and character
 * n-grams signed-hashed into a fixed-width L2-normalised vector.
 *
 * Deterministic and dependency-free, so ingestion and query embedding always
 * live in the same vector space. Swap in a remote embedding model later by
 * returning vectors of length EMBEDDING_DIMS from an API call and recording
 * the new id in documents.embeddingMode.
 */
export function embedText(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  const lower = text.toLowerCase();
  const rawWords = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const words = rawWords.filter((w) => !STOPWORDS.has(w)).map(stem);

  for (const word of words) addFeature(vector, `w:${word}`, UNIGRAM_WEIGHT);
  for (let i = 0; i + 1 < words.length; i++) {
    addFeature(vector, `b:${words[i]} ${words[i + 1]}`, BIGRAM_WEIGHT);
  }
  for (const word of rawWords) {
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    for (let i = 0; i + 2 < word.length; i++) {
      addFeature(vector, `c:${word.slice(i, i + 3)}`, TRIGRAM_WEIGHT);
    }
  }
  for (const word of rawWords) {
    if (word.length < 6 || STOPWORDS.has(word)) continue;
    for (let i = 0; i + 3 < word.length; i++) {
      addFeature(vector, `d:${word.slice(i, i + 4)}`, QUADGRAM_WEIGHT);
    }
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

export interface BM25Document {
  id: string;
  tokens: string[];
  length: number;
}

/** Standard BM25 (k1 = 1.2, b = 0.75) over an in-memory corpus. */
export function bm25Scores(
  queryTokens: string[],
  documents: BM25Document[],
  k1 = 1.2,
  b = 0.75,
): number[] {
  const total = documents.length;
  if (total === 0 || queryTokens.length === 0) {
    return new Array<number>(total).fill(0);
  }

  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) / total || 1;

  const docFrequency = new Map<string, number>();
  const termFrequencies = documents.map((doc) => {
    const seen = new Set<string>();
    const tf = new Map<string, number>();
    for (const token of doc.tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
      seen.add(token);
    }
    for (const token of seen) {
      docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
    }
    return tf;
  });

  const uniqueQuery = Array.from(new Set(queryTokens));
  return documents.map((doc, index) => {
    let score = 0;
    for (const token of uniqueQuery) {
      const tf = termFrequencies[index].get(token);
      if (!tf) continue;
      const df = docFrequency.get(token) ?? 0;
      if (!df) continue;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score +=
        (idf * (tf * (k1 + 1))) /
        (tf + k1 * (1 - b + (b * doc.length) / averageLength));
    }
    return score;
  });
}

/** Short excerpt from a chunk, centred on the first query-term hit. */
export function makeSnippet(
  text: string,
  queryTokens: string[],
  maxLength = 260,
): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;

  const lower = compact.toLowerCase();
  let hit = -1;
  for (const token of queryTokens) {
    const index = lower.indexOf(token);
    if (index > -1 && (hit === -1 || index < hit)) hit = index;
  }
  const start = Math.max(0, (hit === -1 ? 0 : hit) - 70);
  const excerpt = compact.slice(start, start + maxLength);
  return `${start > 0 ? "…" : ""}${excerpt.trim()}${
    start + maxLength < compact.length ? "…" : ""
  }`;
}
