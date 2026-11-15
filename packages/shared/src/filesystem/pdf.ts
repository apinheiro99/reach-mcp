// Bounded, non-OCR PDF text reading. Path authorisation, the byte ceiling and secret redaction are the shared owners'
// (FilesystemReader.resolve, maxFileBytes, secret-policy); this module only validates the bytes and extracts the
// embedded text layer with a pinned pdfjs-dist. Local bytes in, text out: no OCR, rendering, network or subprocess.
import { readFileSync, statSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { FsError } from "./errors.ts";
import type { FilesystemReader } from "./reader.ts";
import { hasPrivateKey, redactText } from "./secret-policy.ts";

export type PdfReadOptions = {
  /** First page to return, 1-based. Default 1. */
  startPage?: number;
  /** Pages wanted from startPage; capped by the maxPdfPages limit. */
  maxPages?: number;
};

export type PdfPage = { page: number; text: string; truncated: boolean };

export type PdfReadResult = {
  path: string;
  totalPages: number;
  startPage: number;
  endPage: number;
  pages: PdfPage[];
  /** False when none of the returned pages carries a text layer (for example scanned images); nothing is OCRed. */
  hasText: boolean;
  redactions: number;
  /** True when pages or characters were left out; nextPage says where to continue. */
  truncated: boolean;
  nextPage: number | null;
};

const SIGNATURE_WINDOW = 1024;

/** Line text of one page: items joined as PDF.js reports them, end-of-line flags kept, trailing blanks trimmed. */
function pageText(items: readonly unknown[]): string {
  let out = "";
  for (const item of items) {
    const { str, hasEOL } = item as { str?: string; hasEOL?: boolean };
    if (typeof str !== "string") continue;
    out += str + (hasEOL ? "\n" : "");
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

function parseFailure(err: unknown): FsError {
  const name = (err as { name?: string } | null)?.name;
  if (name === "PasswordException") return new FsError("UNSUPPORTED_FORMAT", "the PDF is encrypted or password protected; passwords are not supported");
  return new FsError("UNSUPPORTED_FORMAT", "the file is not a readable PDF (invalid, damaged or truncated)");
}

export async function readPdf(reader: FilesystemReader, input: string, options: PdfReadOptions = {}): Promise<PdfReadResult> {
  const { rel, abs } = reader.resolve(input);
  const limits = reader.fsLimits;
  if (!rel.toLowerCase().endsWith(".pdf")) throw new FsError("UNSUPPORTED_FORMAT", "only .pdf files can be read as PDF");
  const stat = statSync(abs);
  if (!stat.isFile()) throw new FsError("NOT_FILE", `not a file: ${rel}`);
  if (stat.size > limits.maxFileBytes) throw new FsError("TOO_LARGE", `PDF is ${stat.size} bytes; the limit is ${limits.maxFileBytes}`);
  const bytes = readFileSync(abs);
  if (!bytes.subarray(0, SIGNATURE_WINDOW).includes("%PDF-")) throw new FsError("UNSUPPORTED_FORMAT", "the file does not carry a PDF signature");

  const startPage = options.startPage ?? 1;
  if (!Number.isInteger(startPage) || startPage < 1) throw new FsError("INVALID_ARGUMENT", "startPage must be a positive integer");
  const wanted = options.maxPages ?? limits.maxPdfPages;
  if (!Number.isInteger(wanted) || wanted < 1) throw new FsError("INVALID_ARGUMENT", "maxPages must be a positive integer");
  const pageBudget = Math.min(wanted, limits.maxPdfPages);

  // A copy: PDF.js takes ownership of the buffer it is given.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0,
  });
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    throw parseFailure(err);
  }
  try {
    const totalPages = doc.numPages;
    if (startPage > totalPages) throw new FsError("INVALID_ARGUMENT", `startPage ${startPage} is past the last page (${totalPages})`);
    const pages: PdfPage[] = [];
    let redactions = 0;
    let charsLeft = limits.maxReadChars;
    let nextPage: number | null = null;
    for (let n = startPage; n <= totalPages; n++) {
      if (pages.length >= pageBudget || charsLeft <= 0) {
        nextPage = n;
        break;
      }
      let raw: string;
      try {
        raw = pageText((await (await doc.getPage(n)).getTextContent()).items);
      } catch (err) {
        throw parseFailure(err);
      }
      // Key material anywhere in a page fails the whole call: no surrounding text is returned.
      if (hasPrivateKey(raw)) throw new FsError("DENIED", `page ${n} contains private key material; the PDF is not readable`);
      const redacted = redactText(raw);
      redactions += redacted.redactions;
      const cut = redacted.text.length > charsLeft;
      const text = cut ? redacted.text.slice(0, charsLeft) : redacted.text;
      charsLeft -= text.length;
      pages.push({ page: n, text, truncated: cut });
    }
    const last = pages[pages.length - 1] as PdfPage;
    if (nextPage === null && last.page < totalPages) nextPage = last.page + 1;
    return {
      path: rel,
      totalPages,
      startPage,
      endPage: last.page,
      pages,
      hasText: pages.some((p) => p.text !== ""),
      redactions,
      truncated: nextPage !== null || pages.some((p) => p.truncated),
      nextPage,
    };
  } finally {
    await task.destroy();
  }
}
