/**
 * Prompt construction and output guards for ASTRA INTEL.
 *
 * Everything the model receives lives here so the grounding contract is easy
 * to audit, and every model output passes through deterministic sanitizers
 * before it can be displayed as a citation.
 */
import type { RetrievalHit } from "./retrieval";

export const NOT_FOUND_MESSAGE =
  "I couldn't find this information in the uploaded document.";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export const GROUNDING_SYSTEM_PROMPT = `You are ASTRA INTEL, a document-grounded intelligence assistant.

Answer questions ONLY using the retrieved content from the uploaded documents provided in the CONTEXT block of the user message.

Do not use outside knowledge.
Do not guess.
Do not fabricate facts, citations, page numbers, quotations, or technical details.
Every factual sentence must be supported by a passage in the CONTEXT.
Cite supporting sources inline using the labels that exist in CONTEXT, for example [S1] or [S2]. Never invent a label.
If the retrieved context does not contain enough information to answer the question, reply with exactly: ${NOT_FOUND_MESSAGE}
Use the conversation history only to resolve references such as "it", "they" or "that system". History is never evidence for a factual claim.

Answer style (shown verbatim to a reader):
- Lead with the direct answer in one or two short sentences. No preamble and no restating the question.
- Emphasise the key fact (date, number, name, threshold) with **double asterisks**, for example: The submission deadline is **1 October 2026**.
- Put the [Sx] label immediately after the sentence it supports, for example: The submission deadline is **1 October 2026**. [S1]
- Cite only sources that directly support the statement. When one page answers the question, a single citation is enough - do not list every retrieved source.
- Plain text with short paragraphs; a short bullet list is allowed for multi-part questions.
- Never paste long raw excerpts or block quotations from the document into the answer.`;

export const SUMMARY_SYSTEM_PROMPT = `You are ASTRA INTEL, a document-grounded intelligence assistant.

Summarize ONLY the document text provided in the user message. Never invent content, numbers, findings, or sources.

Use exactly these section headings, in this order, each on its own line:
OVERVIEW
KEY POINTS
IMPORTANT TECHNICAL DETAILS
MAIN FINDINGS / CONCLUSIONS

Write each section as short bullet points that start with "- ".
Append "(p. N)" to a bullet only when the source text you used shows that page marker, and never use a page number that is absent from the source text.
If the document does not provide information for a section, write "- Not specified in the document."
Keep the whole summary concise, roughly 150-300 words.`;

export const COMPARISON_SYSTEM_PROMPT = `You are ASTRA INTEL, a document-grounded intelligence assistant comparing two uploaded documents.

Compare ONLY using the two SOURCE TEXT blocks in the user message. Do not use outside knowledge. Do not invent differences, similarities, technologies, or findings.
If a document does not discuss a category, use exactly: Not specified in the document.

Return ONLY a valid JSON object, with no markdown fences and no commentary, shaped like:
{"rows":[{"category":"Main Objective","a":"...","b":"..."},{"category":"Technologies","a":"...","b":"..."},{"category":"Key Findings","a":"...","b":"..."},{"category":"Limitations","a":"...","b":"..."}]}

"a" is Document A, "b" is Document B. Use exactly those four category names, in that order.
Keep every cell to one or two sentences. End a cell with the page reference you used, for example (p. 4), using only page markers that appear in that document's source text.`;

/** Context blocks handed to the model, in the same order as the sources list. */
export function buildContextBlocks(hits: RetrievalHit[]): string {
  return hits
    .map(
      (hit, index) =>
        `[S${index + 1}] Source: ${hit.fileName}, Page ${hit.pageNumber}\n"""\n${hit.text}\n"""`,
    )
    .join("\n\n");
}

export function buildAnswerPrompt(args: {
  question: string;
  history: HistoryTurn[];
  hits: RetrievalHit[];
}): string {
  const history =
    args.history.length > 0
      ? args.history
          .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
          .join("\n")
      : "(none)";

  return `CONTEXT
======
${buildContextBlocks(args.hits)}

CONVERSATION HISTORY (for reference only - not a source of facts)
======
${history}

QUESTION
========
${args.question}

Answer using only the CONTEXT above.`;
}

export interface SourcePage {
  pageNumber: number;
  text: string;
}

/**
 * Page-marked document text for summarisation / comparison. Pages that do not
 * fit the character budget are dropped and reported so the prompt can say so.
 */
export function buildDocumentSourceText(
  pages: SourcePage[],
  maxChars: number,
): { text: string; truncatedPages: number[] } {
  const blocks: string[] = [];
  const truncatedPages: number[] = [];
  let used = 0;

  for (const page of pages) {
    const block = `--- Page ${page.pageNumber} ---\n${page.text.trim()}\n`;
    if (used + block.length > maxChars) {
      truncatedPages.push(page.pageNumber);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }

  return { text: blocks.join("\n"), truncatedPages };
}

export function buildSummaryPrompt(args: {
  fileName: string;
  pageCount: number;
  sourceText: string;
  truncatedPages: number[];
}): string {
  const note =
    args.truncatedPages.length > 0
      ? `\n\nNote: pages ${args.truncatedPages.join(", ")} were omitted because of length limits. Only summarize the text provided above and do not claim complete coverage.`
      : "";
  return `Document: ${args.fileName} (${args.pageCount} pages)

SOURCE TEXT (page markers show the original PDF page numbers)
===========================================================
${args.sourceText}${note}

Write the summary now.`;
}

export function buildComparisonPrompt(args: {
  fileNameA: string;
  pageCountA: number;
  sourceTextA: string;
  truncatedPagesA: number[];
  fileNameB: string;
  pageCountB: number;
  sourceTextB: string;
  truncatedPagesB: number[];
}): string {
  const note = (label: string, pages: number[]) =>
    pages.length > 0
      ? `\n(Note: ${label} pages ${pages.join(", ")} were omitted because of length limits.)`
      : "";
  return `DOCUMENT A: ${args.fileNameA} (${args.pageCountA} pages)
${args.sourceTextA}${note("A", args.truncatedPagesA)}

DOCUMENT B: ${args.fileNameB} (${args.pageCountB} pages)
${args.sourceTextB}${note("B", args.truncatedPagesB)}

Compare Document A and Document B now and return the JSON object only.`;
}

// ---------------------------------------------------------------------------
// Output guards (deterministic - the model never gets the last word)
// ---------------------------------------------------------------------------

/** Removes [Sx] labels the retriever never supplied. */
export function stripUnknownSourceLabels(
  text: string,
  sourceCount: number,
): string {
  return text
    .replace(/\[S(\d+)\]/g, (match, digits: string) => {
      const index = Number(digits);
      return index >= 1 && index <= sourceCount ? match : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** Removes page references outside the real page range of the document. */
export function stripOutOfRangePages(text: string, maxPage: number): string {
  if (maxPage < 1) return text;
  return text
    .replace(/\(?\b(?:p\.|page)\s*#?(\d+)\b\)?/gi, (match, digits: string) => {
      const page = Number(digits);
      if (page >= 1 && page <= maxPage) return match;
      return "";
    })
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export interface ComparisonRow {
  category: string;
  a: string;
  b: string;
}

export const COMPARISON_CATEGORIES = [
  "Main Objective",
  "Technologies",
  "Key Findings",
  "Limitations",
] as const;

export const NOT_SPECIFIED = "Not specified in the document.";

/** Tolerant JSON extraction + validation for the comparison action. */
export function parseComparisonRows(
  raw: string,
): { rows: ComparisonRow[] } | { error: string } {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { error: "The model did not return a structured comparison." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return { error: "The model returned malformed comparison JSON." };
  }

  const rows = (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) {
    return { error: "The comparison response was missing its rows." };
  }

  const byCategory = new Map<string, string>();
  const byCategoryB = new Map<string, string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const category =
      typeof record.category === "string" ? record.category.trim() : "";
    if (!category) continue;
    const a = typeof record.a === "string" ? record.a.trim() : "";
    const b = typeof record.b === "string" ? record.b.trim() : "";
    byCategory.set(category, a);
    byCategoryB.set(category, b);
  }

  if (byCategory.size === 0) {
    return { error: "The comparison response contained no usable rows." };
  }

  // Stable table shape: our four categories, filled from the model's rows.
  const normalized: ComparisonRow[] = COMPARISON_CATEGORIES.map((category) => {
    const matchKey =
      Array.from(byCategory.keys()).find(
        (key) => key.toLowerCase() === category.toLowerCase(),
      ) ?? category;
    const a = byCategory.get(matchKey) || NOT_SPECIFIED;
    const b = byCategoryB.get(matchKey) || NOT_SPECIFIED;
    return { category, a: a || NOT_SPECIFIED, b: b || NOT_SPECIFIED };
  });

  return { rows: normalized };
}
