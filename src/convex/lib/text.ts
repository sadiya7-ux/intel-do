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

/**
 * Concept groups for query expansion: paraphrases and common synonyms that
 * describe the same concept. When a question contains any member of a group,
 * every other member is added to the query before ranking, so "what is the
 * last date to submit" also matches a document that says "submission
 * deadline".
 *
 * Groups are deliberately tight and fire only on concepts the user actually
 * asked about, so unrelated questions gain no expansion tokens, stay below
 * the relevance floors, and the deterministic grounded refusal still runs.
 */
const SYNONYM_GROUPS: string[][] = [
  // Deadlines / dates: "last date", "due date", "submission deadline"
  [
    "deadline",
    "due",
    "date",
    "cutoff",
    "submit",
    "submission",
    "deliverable",
    "delivery",
    "milestone",
    "schedule",
    "completion",
    "final",
    "last",
  ],
  // Authorship / ownership
  [
    "author",
    "written",
    "creator",
    "created",
    "developer",
    "developed",
    "publisher",
    "owner",
    "organisation",
    "organization",
    "manufacturer",
  ],
  // Purpose / objectives
  ["purpose", "objective", "aim", "goal", "intent", "mission", "rationale"],
  // Problems / risks / limitations
  [
    "problem",
    "issue",
    "risk",
    "limitation",
    "shortcoming",
    "weakness",
    "constraint",
    "challenge",
    "threat",
  ],
  // Results / findings / performance
  ["result", "outcome", "finding", "performance", "metric", "capability", "accuracy"],
  // Parts / components
  ["component", "part", "subsystem", "module", "element", "assembly", "feature"],
  // Cost / funding
  ["cost", "price", "budget", "expense", "funding"],
  // Method / approach
  ["method", "approach", "technique", "procedure", "process", "methodology"],
  // Requirements / specifications
  ["requirement", "specification", "criterion", "criteria", "standard"],
  // People / operators
  ["user", "operator", "personnel", "crew", "analyst", "engineer", "staff"],
  // Location
  ["location", "place", "site", "region", "area", "country", "station"],
  // Speed / timing
  ["speed", "rate", "velocity", "throughput", "latency", "frequency"],
  // Size / capacity
  ["size", "dimension", "length", "width", "height", "weight", "capacity"],
  // Testing / evaluation
  [
    "test",
    "trial",
    "exercise",
    "evaluation",
    "validation",
    "assessment",
    "verification",
  ],
];

/** Hard cap so a fuzzy question can never flood BM25 with synonyms. */
const MAX_EXPANSION_TOKENS = 24;

export interface ExpandedQuery {
  /** Original tokens followed by added synonyms (BM25 + snippet centre). */
  tokens: string[];
  /** The synonym tokens that were added (diagnostics and tests). */
  added: string[];
  /** Original query plus the added synonyms, ready for embedText(). */
  text: string;
}

/**
 * Normalises a question and expands it with synonyms from SYNONYM_GROUPS so
 * paraphrased questions still match the wording used inside the document.
 * When no concept matches, the query passes through unchanged so unrelated
 * questions rank exactly as before.
 */
export function expandQuery(query: string): ExpandedQuery {
  const base = tokenize(query);
  const present = new Set(base);
  const added: string[] = [];

  for (const group of SYNONYM_GROUPS) {
    if (added.length >= MAX_EXPANSION_TOKENS) break;
    const members = group.map(stem);
    if (!members.some((member) => present.has(member))) continue;
    for (const member of members) {
      if (added.length >= MAX_EXPANSION_TOKENS) break;
      if (present.has(member)) continue;
      present.add(member);
      added.push(member);
    }
  }

  const text = query.trim().replace(/\s+/g, " ");
  return {
    tokens: [...base, ...added],
    added,
    text: added.length > 0 ? `${text} ${added.join(" ")}` : text,
  };
}

/** Raw lowercase words of a chunk, stopwords kept, for term corroboration. */
export function rawWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Normalises a heading or heading term to comparable uppercase words. */
export function normalizeHeading(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

const MAX_HEADING_CHARS = 120;

/**
 * Detects section headings inside a chunk so a question about a named section
 * ("MUST HAVE", "Final Submission Checklist") can be matched against the real
 * heading instead of general body text.
 *
 * Handles the formats PDF extraction produces: standalone all-caps headings,
 * all-caps prefixes followed by an em dash or colon, numbered title-case
 * headings, and short lines that introduce a list.
 */
export function extractHeadings(text: string): string[] {
  const headings: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length === 0 || line.length > MAX_HEADING_CHARS) continue;

    // Strip list numbering: "8.7 Final Submission Checklist" -> heading body.
    const body = line.replace(/^\d+(?:\.\d+)*[.)]?\s*/, "").trim();
    if (body.length < 3) continue;

    // All-caps heading, optionally followed by a dash/colon or body text:
    // "MUST HAVE", "BONUS — demonstrates ...", "DEADLINE All required ...".
    const caps = /^([A-Z][A-Z0-9]*(?:[ \-/&'][A-Z0-9]+){0,5})(?=$|\s+[—–:-]|\s{2,}|\s+[a-zA-Z])/.exec(
      body,
    );
    if (caps && caps[1].length >= 3) {
      headings.push(normalizeHeading(caps[1]));
      continue;
    }

    // Short line that introduces a list.
    if (/[:—–]$/.test(body) && body.length <= 60) {
      headings.push(normalizeHeading(body.replace(/[:—–\s]+$/, "")));
      continue;
    }

    // Short title-case line, typically a numbered section heading such as
    // "8.7 Final Submission Checklist" or "Radar Systems". Sentences and list
    // items are excluded by the word count and the trailing period.
    const words = body.split(" ");
    const letters = body.replace(/[^a-zA-Z]/g, "");
    const capitalised = words.filter(
      (word) => /^[A-Z0-9]/.test(word) && word.replace(/[^a-zA-Z]/g, "").length >= 2,
    ).length;
    if (
      words.length <= 8 &&
      words.length >= 1 &&
      body.length <= 60 &&
      letters.length >= 4 &&
      !body.endsWith(".") &&
      capitalised >= Math.ceil(words.length * 0.6)
    ) {
      headings.push(normalizeHeading(body));
    }
  }

  return headings.filter((heading) => heading.length > 1);
}

/**
 * All-caps (or hyphenated all-caps) phrases in a question: "MUST-HAVE",
 * "ASTRA INTEL", "DEADLINE". These are the words a user copies out of a
 * section heading, so they carry a strong signal about which section to read.
 */
export function extractHeadingTerms(query: string): string[] {
  const terms: string[] = [];
  const pattern = /\b[A-Z][A-Z0-9]*(?:[ \-/&'][A-Z0-9]+)*\b/g;

  for (const match of query.matchAll(pattern)) {
    const words = normalizeHeading(match[0]).split(" ").filter(Boolean);
    if (words.length === 0 || words.length > 3) continue;
    // "WHAT ARE THE" from a shouted question is not a section name.
    if (words.length > 2 && words.every((word) => STOPWORDS.has(word.toLowerCase()))) {
      continue;
    }
    const term = words.join(" ");
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

/** True when the chunk holds real list content, i.e. a section body. */
export function hasListBody(text: string): boolean {
  let items = 0;
  for (const rawLine of text.split("\n")) {
    const match = /^\s*(?:\d+[.)]|[-*•‣▪◦☐☑☒□■–])\s+(\S.*)$/.exec(rawLine);
    if (!match) continue;
    // "6. The Three Challenges" is a numbered heading, not a list item.
    const words = match[1].split(" ");
    const capitalised = words.filter(
      (word) => /^[A-Z0-9]/.test(word) && word.replace(/[^a-zA-Z]/g, "").length >= 2,
    ).length;
    if (capitalised < Math.ceil(words.length * 0.6)) items += 1;
    if (items >= 2) return true;
  }
  return false;
}

/**
 * How strongly a chunk looks like the section the question asked about.
 *
 * An exact heading-term match (all of its words present in the chunk's
 * headings) scores 1.0, then scales up slightly for further terms. Distinctive
 * question tokens that appear in a heading contribute a weaker partial score,
 * which lets questions phrased in lower case ("the bonus features") still
 * prefer the BONUS section.
 *
 * Two refinements separate a real section from an incidental mention:
 *   - `hasBody`: the chunk actually holds the section's content (list items),
 *     so "MUST HAVE" plus its list beats a lone "ASTRA INTEL" label.
 *   - `chunkWords`: the remaining heading terms appearing anywhere in the
 *     chunk text corroborate which section the question meant.
 */
export function matchHeadings(args: {
  headings: string[];
  terms: string[];
  tokens: string[];
  rareTokens?: Set<string>;
  /** Fraction of the question's tokens that appear in this chunk's text. */
  coverage?: number;
  hasBody?: boolean;
  chunkWords?: Set<string>;
}): number {
  const { headings, terms, tokens, rareTokens, coverage, hasBody, chunkWords } = args;
  if (headings.length === 0) return 0;

  // Headings are raw words while query tokens are stemmed, so compare both
  // sides in the same stemmed space ("FEATURES" -> "feature").
  const stemmed = headings.map((heading) =>
    new Set(heading.split(" ").map((word) => stem(word.toLowerCase()))),
  );
  const hasWords = (words: string[]) => {
    const wanted = words.map((word) => stem(word.toLowerCase()));
    return stemmed.some((set) => wanted.every((word) => set.has(word)));
  };
  const mentionsAll = (term: string, words: Set<string>) =>
    term.split(" ").every((word) => words.has(word.toLowerCase()));

  let score = 0;
  let matchedSectionName = false;
  const matchedTerms = terms.filter((term) => hasWords(term.split(" ")));
  if (matchedTerms.length > 0) {
    matchedSectionName = true;
    // Naming one section outright is already a strong signal; matching every
    // heading term (e.g. both "MUST-HAVE" and "ASTRA INTEL") is stronger.
    score = matchedTerms.length === terms.length ? 1 : 0.9;
    if (score < 1 && chunkWords && terms.every((term) => mentionsAll(term, chunkWords))) {
      score = Math.min(1, score + 0.05);
    }
  } else if (tokens.length > 0) {
    // How many question tokens a single heading covers. Two or more is a strong
    // signal that the question named this section ("final submission" ->
    // "Final Submission Checklist"); one is a weak hint, unless that token
    // names only one heading in the whole corpus ("DEADLINE").
    let best = 0;
    let bestToken = "";
    for (const set of stemmed) {
      const found = tokens.filter((token) => set.has(token));
      if (found.length > best) {
        best = found.length;
        bestToken = found[0] ?? "";
      }
    }
    if (best >= 2) {
      score = Math.min(1, 0.75 + 0.25 * (best / tokens.length));
    } else if (best === 1) {
      // A rare heading name only decides the answer when the chunk also covers
      // the rest of the question; otherwise it is just a hint.
      const rare =
        (rareTokens?.has(bestToken) ?? false) && (coverage ?? 0) >= 0.999;
      score = rare ? 0.75 : 0.5 * (best / tokens.length);
    }
  }

  if (score === 0) return 0;
  // A heading the user typed out loud with no section content in this chunk (a
  // brand name in a list of names, a summary line) is not the section meant.
  // Distinctive-token matches are exempt: short sections such as DEADLINE have
  // no list body but are still the right passage.
  return hasBody === false && matchedSectionName ? score * 0.5 : score;
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
