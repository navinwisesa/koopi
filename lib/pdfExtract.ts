import { PDFParse } from "pdf-parse";

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
 * Extracts text from a PDF, and — only when the extracted text looks too
 * sparse to be the real content (a scanned page, a screenshot pasted into a
 * doc) — additionally renders its first few pages as images so a vision
 * model can read what the text layer couldn't capture. Never throws; a
 * malformed/encrypted PDF that pdf-parse can't open comes back as an empty
 * extraction rather than failing the whole chat turn over one bad
 * attachment.
 */
export async function extractPdf(data: Buffer): Promise<PdfExtraction> {
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
      return { text, pageCount, pageImageDataUrls };
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
