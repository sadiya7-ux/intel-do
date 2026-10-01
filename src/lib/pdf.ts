import * as pdfjs from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

/** Upload guard: refuse files that are certainly not processable. */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
/** Total extracted-text budget handed to the backend. */
export const MAX_TOTAL_TEXT = 3_000_000;

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdf {
  pageCount: number;
  pages: ExtractedPage[];
}

/** Structural shape of a pdf.js text run (types are not re-exported). */
interface PdfTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

/** Returns a user-facing error message, or null when the file looks valid. */
export function validatePdfFile(file: File | undefined | null): string | null {
  if (!file) return "No file selected. Choose a PDF and try again.";
  const looksLikePdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!looksLikePdf) {
    return `"${file.name}" is not a PDF. Only PDF files are supported.`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty (0 bytes).`;
  }
  if (file.size > MAX_PDF_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `"${file.name}" is ${mb} MB. The maximum upload size is 15 MB.`;
  }
  return null;
}

function friendlyPdfError(error: unknown): Error {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name.includes("Password")) {
    return new Error(
      "This PDF is password-protected. Remove the password and try again.",
    );
  }
  if (name.includes("InvalidPDF") || /invalid pdf/i.test(message)) {
    return new Error(
      "This PDF could not be read. The file appears to be corrupted.",
    );
  }
  if (/abort|cancel/i.test(message)) {
    return new Error("Reading the PDF was cancelled.");
  }
  return new Error(
    "This PDF could not be read. It may be corrupted or incomplete.",
  );
}

/** Messages that were already written for the user should surface verbatim. */
function isFriendlyMessage(message: string): boolean {
  return (
    message.includes("No extractable text") ||
    message.includes("processing limit") ||
    message.includes("no pages")
  );
}

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str: unknown }).str === "string"
  );
}

/**
 * Rebuilds readable page text from positioned PDF text runs:
 * vertical jumps become line/paragraph breaks, horizontal gaps become spaces.
 */
function pageTextFromContent(content: { items: readonly unknown[] }): string {
  let out = "";
  let previousY: number | null = null;
  let previousRight = 0;

  for (const item of content.items) {
    if (!isTextItem(item)) continue;

    const transform = item.transform ?? [];
    const x = Number(transform[4] ?? 0);
    const y = Number(transform[5] ?? 0);
    const size =
      Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? 0)) ||
      item.height ||
      10;

    if (previousY !== null && out.length > 0) {
      const deltaY = previousY - y;
      if (deltaY > size * 1.9) {
        out += "\n\n";
      } else if (deltaY > size * 0.4) {
        out += "\n";
      } else if (x - previousRight > Math.max(0.8, size * 0.12)) {
        if (!/\s$/.test(out) && !/^\s/.test(item.str)) out += " ";
      }
    }

    out += item.str;
    if (item.hasEOL && !out.endsWith("\n")) out += "\n";
    previousY = y;
    previousRight = x + (item.width || 0);
  }

  return out
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts text from every page of a PDF while preserving real page numbers.
 * Throws an Error with a user-facing message when the file cannot be read.
 */
export async function extractPdfPages(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractedPdf> {
  // A fresh worker per extraction: pdf.js may terminate the port with the
  // document, and each upload starts from a clean worker anyway.
  try {
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  } catch {
    // Worker creation failure surfaces as a read error below.
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error("The file could not be read from disk.");
  }

  type LoadingTask = Awaited<ReturnType<typeof pdfjs.getDocument>>;
  let task: LoadingTask;
  try {
    task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  } catch (error) {
    throw friendlyPdfError(error);
  }

  try {
    const doc = await task.promise;

    if (doc.numPages < 1) {
      throw new Error("This PDF contains no pages.");
    }

    const pages: ExtractedPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push({ pageNumber, text: pageTextFromContent(content) });
        page.cleanup();
      } catch {
        pages.push({ pageNumber, text: "" });
      }
      onProgress?.(pageNumber, doc.numPages);
    }

    const totalText = pages.reduce((sum, page) => sum + page.text.length, 0);
    if (totalText === 0) {
      throw new Error(
        "No extractable text was found in this PDF. Scanned or image-only PDFs need OCR, which is not supported yet.",
      );
    }
    if (totalText > MAX_TOTAL_TEXT) {
      throw new Error(
        "This document's text exceeds the 3 MB processing limit. Split it into smaller PDFs and try again.",
      );
    }

    return { pageCount: doc.numPages, pages };
  } catch (error) {
    if (error instanceof Error && isFriendlyMessage(error.message)) {
      throw error;
    }
    throw friendlyPdfError(error);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
