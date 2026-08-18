import { createWorker } from "tesseract.js";

// pdf-parse's rendering path (getScreenshot, used below) goes through
// pdfjs-dist, which — outside a real browser — expects a global `DOMMatrix`
// to already exist and references it at MODULE LOAD time, not lazily inside
// a function. A static top-level `import { PDFParse } from "pdf-parse"`
// therefore made this file's own module evaluation throw
// "ReferenceError: DOMMatrix is not defined" before any of our code ever
// ran — confirmed live via Vercel's runtime logs, every /api/chat request
// crashing at import. @napi-rs/canvas (pdf-parse's own native dependency,
// see next.config.ts's serverExternalPackages comment) ships a real
// DOMMatrix implementation; installing it on globalThis before pdf-parse is
// loaded — and loading pdf-parse itself lazily, inside extractPdf() below,
// rather than as a static import — fixes the ordering.
let domMatrixReady: Promise<void> | null = null;
function ensureDomMatrixPolyfill(): Promise<void> {
  if (typeof (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix !== "undefined") {
    return Promise.resolve();
  }
  if (!domMatrixReady) {
    domMatrixReady = import("@napi-rs/canvas").then(({ DOMMatrix }) => {
      (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = DOMMatrix;
    });
  }
  return domMatrixReady;
}

// Below this many extracted characters per page, a PDF reads as
// image-heavy/scanned rather than real body text — e.g. a screenshot of an
// error dialog pasted into a PDF, or a scanned page. A real text-based spec
// doc comfortably clears this on almost every page; a picture-only page
// clears it only via stray OCR noise, if at all. Not a precise signal (no
// such threshold is), just cheap enough to be worth it before spending the
// extra render+vision-token cost on a PDF that's actually all text.
const SPARSE_TEXT_CHARS_PER_PAGE = 40;

// Render at most this many pages as images when a PDF is judged
// image-heavy — bounds both latency (each render is real rasterization
// work) and the vision model's token budget. Most debugging PDFs in scope
// here (a screenshot pasted into a doc, a short spec) are a handful of
// pages; a much longer scanned document would need a different approach
// entirely (this one would just describe its first few pages).
const MAX_SCREENSHOT_PAGES = 3;

export type PdfExtraction = {
  text: string;
  pageCount: number;
  // Populated only when the sparse-text heuristic above triggers — data
  // URLs (data:image/png;base64,...), ready to hand straight to a vision
  // model's image_url content part.
  pageImageDataUrls: string[];
};

/**
 * Real OCR (Tesseract, WASM, runs locally — no external API/key needed) on
 * the same rendered page images the vision-model fallback already uses.
 * Previously those images were ONLY ever handed to a vision model — no
 * actual text ever came out of a scanned/image-heavy PDF, so nothing here
 * was searchable, quotable, or usable if a request ever skipped the vision
 * path. This gives the sparse-text case real extracted text on top of (not
 * instead of) the images, best-effort: an OCR failure degrades to
 * text-and-images-only, exactly like a screenshot-rendering failure already
 * degrades to text-only above.
 */
async function runOcr(pageImageDataUrls: string[]): Promise<string> {
  if (!pageImageDataUrls.length) return "";
  const worker = await createWorker("eng");
  try {
    const pages: string[] = [];
    for (let i = 0; i < pageImageDataUrls.length; i++) {
      const {
        data: { text: pageText },
      } = await worker.recognize(pageImageDataUrls[i]);
      const trimmed = pageText.trim();
      if (trimmed) pages.push(`[page ${i + 1}]\n${trimmed}`);
    }
    return pages.join("\n\n");
  } catch (err) {
    console.warn("extractPdf: OCR pass failed:", err);
    return "";
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/**
 * Extracts text from a PDF, and — only when the extracted text looks too
 * sparse to be the real content (a scanned page, a screenshot pasted into a
 * doc) — additionally renders its first few pages as images so a vision
 * model can read what the text layer couldn't capture. Never throws; a
 * malformed/encrypted PDF that pdf-parse can't open comes back as an empty
 * extraction rather than failing the whole chat turn over one bad
 * attachment.
 */
export async function extractPdf(data: Buffer): Promise<PdfExtraction> {
  await ensureDomMatrixPolyfill();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const textResult = await parser.getText();
    const text = (textResult.text ?? "").trim();
    const pageCount = textResult.pages?.length || 1;

    const looksSparse = text.length < SPARSE_TEXT_CHARS_PER_PAGE * pageCount;
    if (!looksSparse) {
      return { text, pageCount, pageImageDataUrls: [] };
    }

    try {
      const shots = await parser.getScreenshot({
        scale: 1.5,
        first: MAX_SCREENSHOT_PAGES,
        imageDataUrl: true,
        imageBuffer: false,
      });
      const pageImageDataUrls = shots.pages
        .map((p) => p.dataUrl)
        .filter((u): u is string => Boolean(u));

      const ocrText = await runOcr(pageImageDataUrls);
      const combinedText = ocrText
        ? text
          ? `${text}\n\n--- OCR text from image-heavy pages ---\n\n${ocrText}`
          : ocrText
        : text;

      return { text: combinedText, pageCount, pageImageDataUrls };
    } catch (err) {
      // Rendering is the riskier half (real rasterization work) — losing it
      // still leaves whatever text (if any) was extracted.
      console.warn("extractPdf: page-screenshot rendering failed, text-only:", err);
      return { text, pageCount, pageImageDataUrls: [] };
    }
  } catch (err) {
    console.warn("extractPdf: failed to parse PDF:", err);
    return { text: "", pageCount: 0, pageImageDataUrls: [] };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
