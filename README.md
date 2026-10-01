# ASTRA INTEL

**AI-Powered Defence Document Intelligence System**

Upload defence and technology PDFs, then get summaries, answers and comparisons that are
grounded **only** in the uploaded documents — each one traced back to the exact PDF page it
came from.

---

## 1. Problem Overview

Defence and technology programmes run on long, technical PDFs: capability studies, radar
reviews, materials assessments, programme updates. Analysts, programme offices and review
boards need answers from those documents quickly, but two problems make that hard:

1. **Provenance.** A reviewer must be able to check where a claim came from. "The system said
   so" is not acceptable when the answer feeds a decision — every fact needs a document name
   and a page number.
2. **Hallucination.** General-purpose chat models happily complete half-remembered facts,
   invent page numbers and quote passages that do not exist. In a defence context that is a
   correctness failure, not a stylistic one.

ASTRA INTEL addresses both by construction: retrieval runs *before* generation, only the
retrieved passages reach the model, sources are taken from the retriever rather than from the
model's text, and deterministic guards strip citation labels and page numbers that were never
real. When nothing relevant is found, the system refuses instead of guessing.

---

## 2. Features

### Must-have (Phase 1) — implemented

| # | Feature | Notes |
|---|---------|-------|
| 1 | **PDF upload** | Drag-and-drop + file picker, progress states, validation for: no file, wrong type, empty file, oversized file (>15 MB), corrupted/password-protected PDF, PDF with no extractable text, text over the 3 MB limit. Every case shows a specific user-facing message. |
| 2 | **PDF text extraction** | Client-side `pdfjs-dist`, line/paragraph reconstruction, real PDF page numbers preserved as `{ page, text }`. |
| 3 | **Page preservation** | Chunks never cross a page boundary; `pages` and `chunks` tables both store `pageNumber`, which is the only source of citations. |
| 4 | **AI document summary** | Overview · Key Points · Important Technical Details · Main Findings / Conclusions, generated only from that document, with "(p. N)" references validated against the real page count. |
| 5 | **Grounded Q&A** | "ASTRA INTEL Assistant" chat with a strict grounding system prompt and a deterministic refusal path when retrieval returns nothing. |
| 6 | **Page-level citations** | Every answer lists its sources (`[S1] file.pdf · p. 4`) with a real excerpt; citations are clickable and open the exact extracted page in the source panel. Source labels and page numbers are sanitised before display. |
| 7 | **Multi-turn conversation** | History is used only to resolve references ("its limitations"), never as evidence; Clear Conversation button; loading, empty and error states throughout. |
| 8 | **Error handling** | No document, processing in progress, extraction failed, empty PDF, invalid file, AI/API failure, missing AI configuration, retrieval returning nothing, multi-document scope with pending documents. |

### Should-have (Phase 2) — implemented

| # | Feature | Notes |
|---|---------|-------|
| 9 | **Multiple documents** | Sidebar library with file name, page count, size, processing status, scope checkbox and delete. Sources always identify document **and** page. |
| 10 | **Semantic search** | Natural-language search across the selected documents with rank, document, page, highlighted snippet and relevance score. |
| 11 | **Document library** | Managed from the sidebar; newly indexed documents auto-join the retrieval scope. |
| 12 | **Document comparison** | Two-document structured table (Main Objective · Technologies · Key Findings · Limitations) with per-cell page references and an explicit "Not specified in the document." |

---

## 3. Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | React 19, TypeScript, Vite 7, Tailwind CSS v4, shadcn/ui, Framer Motion, React Router v7 |
| Backend / database | [Convex](https://convex.dev) — queries, mutations, actions, reactive client |
| Vector store | Convex **vector index** (`chunks.by_embedding`, 2048 dimensions, `documentId` filter field) |
| PDF processing | `pdfjs-dist` v6, executed in the browser (keeps raw PDFs off the server) |
| Retrieval | Hybrid: BM25 (k1 = 1.2, b = 0.75) + dense vectors, fused with Reciprocal Rank Fusion |
| Embeddings | Local deterministic feature-hashing embedder (`hashing-v1`), 2048-d, L2-normalised — no external API needed, identical vectors at index and query time |
| AI model / API | OpenAI-compatible chat completions through the project's AI integration gateway (`@vly-ai/integrations`), default model **`gpt-4o-mini`**, overridable with `ASTRA_AI_MODEL`, automatic fallback to the gateway default model |
| Authentication | Convex Auth (email OTP + anonymous), wrapped by the template's `RequireAuth` |

---

## 4. Architecture

```
User
  ↓
PDF Upload
  ↓
PDF Text Extraction          (browser, page numbers preserved)
  ↓
Page-Aware Chunking          (no chunk crosses a page boundary)
  ↓
Embeddings / Semantic Retrieval   (Convex vector index + BM25, fused)
  ↓
Relevant Context             (top passages, labelled [S1]…[Sn])
  ↓
LLM                          (grounding system prompt, server-side key)
  ↓
Grounded Answer              (sanitised: unknown labels/out-of-range pages removed)
  ↓
Page-Level Citations         (sources come from retrieval, never from the model)
```

```mermaid
flowchart TD
    U[User] --> UP[PDF Upload<br/>validate · progress · errors]
    UP --> EX[PDF Text Extraction<br/>pdfjs in browser, page numbers kept]
    EX --> CH[Page-Aware Chunking<br/>pages → passages]
    CH --> EM[Embeddings<br/>hashing-v1 · 2048-d]
    EM --> VI[(Convex vector index<br/>chunks.by_embedding)]
    CH --> PG[(pages table<br/>page text for the viewer)]

    Q[Question / Search query] --> RT{Hybrid retrieval}
    RT --> BM[BM25 lexical scoring]
    RT --> VS[Vector search<br/>filtered by selected documents]
    BM --> RF[Reciprocal rank fusion + relevance floor]
    VS --> RF
    RF -->|no hits| NF[Deterministic refusal<br/>"information not found"]
    RF -->|hits| PR[Prompt: labelled context S1…Sn<br/>+ conversation history]
    PR --> LLM[LLM · server-side API key]
    LLM --> SAN[Sanitise: unknown labels,<br/>out-of-range pages]
    SAN --> ANS[Grounded answer + sources]
    ANS --> UI[Chat with clickable page citations]
    PG --> UI
```

### Data model (Convex)

| Table | Fields | Indexes |
|-------|--------|---------|
| `documents` | `userId`, `fileName`, `fileSize`, `pageCount`, `status` (`processing`/`ready`/`failed`), `error?`, `chunkCount?`, `embeddingMode?`, `summary?` | `by_user` |
| `pages` | `documentId`, `pageNumber`, `text` | `by_document` |
| `chunks` | `documentId`, `pageNumber`, `chunkIndex`, `text`, `tokenCount`, `embedding[]` | `by_document`, vector `by_embedding` (2048-d, filter `documentId`) |
| `conversations` | `userId`, `documentIds[]` | `by_user` |
| `messages` | `conversationId`, `userId`, `role`, `content`, `sources[]` (`label`, `documentId`, `fileName`, `pageNumber`, `snippet`, `score`) | `by_conversation` |

### Backend functions

| File | Runtime | Purpose |
|------|---------|---------|
| `src/convex/ingest.ts` | action | chunk → embed → store pages/chunks → mark ready (or failed) |
| `src/convex/assistant.ts` | `"use node"` action | `ask` (retrieve → prompt → answer → persist sources), `summarize`, `compare` |
| `src/convex/search.ts` | action | retrieval only, no LLM |
| `src/convex/documents.ts` / `conversations.ts` | queries + mutations | ownership-checked CRUD, page viewer, transcript |
| `src/convex/lib/` | pure modules | `text` (tokenise/chunk/embed/BM25), `retrieval` (fusion), `prompts`, `ai` (provider layer), `validators` |

---

## 5. Data Flow

### How a PDF becomes searchable

1. The browser validates the file (type, size, emptiness) and extracts every page with
   `pdfjs`, producing `[{ pageNumber, text }]`.
2. A `documents` row is created with `status: "processing"` so the library can show progress
   immediately.
3. The `ingest` action cleans the text (de-hyphenation, whitespace), splits **each page
   separately** into ~1.1 KB passages (max 1.7 KB, 180-character overlap, sentence-aligned),
   and embeds every passage with the local 2048-d embedder.
4. Pages are written first (they power the source viewer), then chunks in small batches, then
   the document flips to `ready` with its real page count and chunk count. Any failure marks
   the document `failed` with a user-facing reason.

### How a question becomes a grounded answer

1. The client appends the user message, then calls the `ask` action with the selected
   document IDs.
2. The action re-checks ownership and status, loads the last few transcript turns, and runs
   hybrid retrieval over **ready, owned** documents only:
   - BM25 over the chunk corpus, and
   - a vector search through the Convex vector index filtered to the selected documents,
   - fused with Reciprocal Rank Fusion (k = 60), keeping only passages that clear a lexical
     **or** vector relevance floor.
3. If nothing clears the floor, the action returns the fixed refusal line immediately — no
   LLM call, so an out-of-scope question can never be answered from model memory.
4. Otherwise the top passages are wrapped as `[S1] Source: file.pdf, Page 4` context blocks,
   history is added (reference resolution only), and the grounding prompt is sent to the
   model.
5. The response is sanitised: `[Sx]` labels that were never supplied are removed, page
   numbers outside the document's real range are removed, an empty result falls back to the
   refusal line.
6. The answer and the **retriever's** sources are persisted on the assistant message. The UI
   renders the citation chips and, on click, opens the stored page text in the source panel.

---

## 6. AI / ML Pipeline

- **PDF extraction** — `pdfjs-dist` text items are re-assembled into lines and paragraphs
  using vertical gaps and horizontal spacing, so paragraph structure survives into chunking.
- **Chunking** — page-scoped, sentence-aligned, target ≈ 1100 characters, max 1700, overlap
  ≈ 180, minimum 40. A chunk's `pageNumber` is fixed forever, which is what makes citations
  exact.
- **Embeddings** — deterministic feature hashing: stemmed word unigrams (1.0), word bigrams
  (1.4), character trigrams (0.1) and quadgrams (0.1), signed-hashed into 2048 dimensions and
  L2-normalised. Weights and dimensionality were tuned empirically so unrelated queries score
  < 0.07 cosine while document-matched queries score 0.15–0.25 (see `scripts/rag-sanity.ts`).
  The provider is recorded per document in `embeddingMode`, so a remote embedding model can
  be swapped in later without ever mixing two vector spaces.
- **Retrieval** — BM25 (k1 = 1.2, b = 0.75, stopword list + conservative plural stemming)
  and vector cosine are ranked independently, then fused with RRF; floors of `BM25 > 0.01`
  or `cosine ≥ 0.14` decide whether a passage is relevant at all. Vector search is wrapped in
  a try/catch: if the index is unavailable, BM25 still answers.
- **Prompt construction** — system prompt: *"You are ASTRA INTEL, a document-grounded
  intelligence assistant. Answer questions ONLY using the retrieved content from the uploaded
  documents… Do not use outside knowledge. Do not guess. Do not fabricate facts, citations,
  page numbers, quotations, or technical details… If the retrieved context does not contain
  enough information, reply [with the refusal line]. Always return the document name and page
  number for supporting sources."* Context blocks are page-labelled; history is explicitly
  marked as non-evidence.
- **LLM generation** — one server-side completion per request (`gpt-4o-mini`, temperature
  0.2, capped output) through the project's AI gateway, with an automatic retry using the
  gateway's default model and minimal parameters if the first attempt fails. Keys are read
  from `process.env` inside a `"use node"` action — nothing reaches the browser bundle.
- **Source citation** — sources are the retriever's hits, not model output. Deterministic
  sanitizers drop unknown `[Sx]` labels and page numbers outside `1…pageCount`.
- **Summary** — page-marked source text (≤ 60 000 characters) with the four required
  sections; omitted pages are declared in the prompt instead of being guessed.
- **Comparison** — both documents page-marked (≤ 26 000 characters each), strict JSON output,
  parsed tolerantly (fence stripping, brace extraction, shape validation) and re-mapped onto a
  fixed four-row table; empty cells become "Not specified in the document."

---

## 7. Setup Instructions

### Prerequisites

- [Bun](https://bun.sh) (package manager)
- Convex CLI (bundled as `convex` in the project dependencies)

### Install

```bash
bun install
```

### Environment variables

`.env.example` lists the variable names (no secrets). Frontend variables live in `.env.local`;
server-side variables are set **on the Convex deployment**, never in client code.

| Variable | Where | Required | Purpose |
|----------|-------|----------|---------|
| `VITE_CONVEX_URL` | frontend | yes | Convex deployment URL used by the React client |
| `CONVEX_DEPLOYMENT` | frontend | yes | Deployment targeted by `bunx convex dev` |
| `VLY_INTEGRATION_KEY` | Convex (server) | **yes** | AI gateway key for chat completions (summaries, Q&A, comparison). Missing key → clear "AI API key is not configured" message instead of a crash. |
| `ASTRA_AI_MODEL` | Convex (server) | no | Overrides the default `gpt-4o-mini` |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | Convex (server) | yes (template) | Convex Auth — already configured |

Set server variables with:

```bash
bunx convex env set VLY_INTEGRATION_KEY <value>
```

### Run locally

```bash
bunx convex dev     # terminal 1: pushes Convex functions and regenerates types
bun run dev         # terminal 2: Vite dev server on http://localhost:5173
```

In the hosted Freebuff environment both processes are started by the platform automatically.

### Build

```bash
bun run build       # tsc -b && vite build → dist/
```

### Tests

```bash
bun scripts/rag-sanity.ts   # chunking, embeddings, BM25, refusal floors
```

---

## 8. Testing

### Automated

`bun scripts/rag-sanity.ts` asserts: chunks never cross pages and stay within the size
window, embeddings are deterministic / 2048-d / L2-normalised with clear separation between
related and unrelated text, a radar question ranks page 2 first, and an unrelated question
scores below both the lexical and the vector relevance floor. **All checks pass.**

### Live pipeline verification (against the real deployment)

An end-to-end smoke run (temporary internal action, since removed) ingested a synthetic
three-page document through the production chunk → embed → store path and then queried it:

| Check | Result |
|-------|--------|
| Pages stored with correct numbers | ✅ `[1, 2, 3]` |
| Chunking | ✅ 3 page-scoped passages |
| Convex vector index queryable | ✅ `usedVectorSearch: true` |
| Hybrid ranking (BM25 + vector fusion) | ✅ page 2 ranked first (BM25 2.86, cosine 0.244) |
| Unrelated question ("capital of France") | ✅ 0 hits → deterministic refusal, no LLM call |
| Grounded answer | ✅ *"…performance degradation in heavy sea state 6 conditions [S1]"* — `[S1]` maps to page 2 |
| AI gateway + `gpt-4o-mini` | ✅ `VLY_INTEGRATION_KEY` present, completion succeeded |
| Cleanup | ✅ test documents removed |

### Manual browser checklist (demo script)

1. Open the app → landing page renders, CTA enters the workspace via `/auth` when signed out.
2. Upload a valid PDF → progress (reading → extracting → indexing) → "indexed — N pages".
3. Library shows file name, page count, size, status **Ready**; it auto-joins the scope.
4. **Generate summary** → four sections, "(p. N)" references inside the real page range.
5. Ask a question answered in the PDF → grounded answer + `[S1]` chip + source excerpt.
6. Click the citation → right panel opens the exact extracted page text.
7. Follow-up question referring to the previous turn ("its limitations") → answer still grounded.
8. Ask something not in the document → *"I couldn't find this information in the uploaded document."*
9. Upload a second PDF → compare the two → table with "Not specified in the document." where needed.
10. Search: *"Find information about autonomous systems."* → ranked results with document + page + snippet.
11. Invalid inputs: `.txt` file, 0-byte file, truncated/corrupted PDF, image-only PDF → specific messages, no blank screens.
12. Clear conversation → transcript empties, empty-state sample questions return.
13. `bun run build` → production build completes with no errors.

### Error-state coverage

| Scenario | Behaviour |
|----------|-----------|
| No document uploaded | Empty state in the assistant; upload prompt in the sidebar |
| PDF still processing | Status pill + inline note; summary/ask disabled for that document |
| Extraction failed / corrupted | Document marked `failed` with the reason; upload shows the message |
| Empty PDF / no extractable text | Explicit refusal before anything is stored |
| Wrong file type / too large | Field-level validation message, file rejected |
| Retrieval finds nothing | Deterministic refusal line, no model call |
| AI/API failure | Inline error under the composer with the gateway's friendly message |
| Missing AI configuration | "AI API key is not configured…" with the variable to set |
| Not signed in | `RequireAuth` bounce to `/auth?returnTo=/dashboard` |

---

## 9. Limitations

- **Embeddings are local, not neural.** `hashing-v1` is a tuned feature-hashing model: it
  behaves like strong lexical-semantic matching, but a question that shares *no* vocabulary
  with the document (heavy paraphrase) can fall below the relevance floor and be refused.
  Remote embeddings are the planned fix (see below); BM25 + vector fusion covers normal
  questions well.
- **No OCR.** Scanned or image-only PDFs are detected and reported, not processed.
- **Page-number verification is bounded.** Out-of-range page numbers are stripped
  deterministically; an in-range but slightly wrong page number produced by the model cannot
  be fully disproved without per-claim verification (mitigated by page-labelled context).
- **Length limits.** 15 MB per file, 3 MB of extracted text per document; summaries use the
  first ~60 000 characters and comparisons ~26 000 per document, and explicitly declare any
  omitted pages.
- **Comparison output is JSON.** Tolerant parsing recovers from fences and prose, but a
  badly malformed model response surfaces as an error and needs a retry.
- **One conversation per user** (cleared manually), last 6 turns supplied for reference.
- **No PDF rendering.** The source panel shows extracted text, not the rendered page image.
- **Authentication required.** Uploads and conversations are per signed-in user.

## 10. Future Improvements

- **OCR** for scanned documents (Tesseract/Vision) with page-aligned text layers.
- **Remote embeddings** (`text-embedding-3-small` or an open-source model) behind the
  existing `embeddingMode` seam, with background re-indexing.
- **Page rendering + highlight boxes**: show the actual PDF page and outline the exact
  passage behind a citation.
- **Per-claim citation verification**: verify each sentence against its cited passage and
  flag unsupported claims instead of relying on prompt discipline.
- **Local/open-source models** (e.g. via Ollama) for air-gapped deployments — only
  `src/convex/lib/ai.ts` would change.
- **Larger collections**: sharded retrieval, pagination and cross-document deduplication for
  hundreds of documents.
- **Query rewriting** for long conversations so follow-ups retrieve with a resolved,
  standalone query.
- **Audit trail**: exported answer → source packs for review boards.

## 11. AI Usage Disclosure

AI development tools were used during development for code generation, debugging,
implementation assistance, and documentation. All generated code and dependencies were
reviewed, tested, and validated by the developer.

---

### Repository layout

```
src/
  components/astra/     UploadZone · DocumentLibrary · AssistantView · ChatMessage ·
                        SearchView · CompareView · SourcePanel
  convex/
    assistant.ts        "use node" — ask / summarize / compare
    ingest.ts           chunk → embed → store
    search.ts           retrieval-only search
    documents.ts        document/page/chunk queries + mutations
    conversations.ts    conversation + transcript
    lib/                text · retrieval · prompts · ai · validators
    schema.ts           tables + vector index
  lib/                   pdf.ts (extraction) · astra.ts (shared types)
  pages/                Landing · Auth · Dashboard (workspace) · NotFound
scripts/rag-sanity.ts   retrieval sanity checks
```
