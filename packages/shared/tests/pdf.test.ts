// Bounded PDF text reading over a real temporary tree: pages, pagination, caps, redaction and the refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemReader, readPdf, REDACTED, type FsLimits } from "../src/filesystem/index.ts";
import { encryptedPdf, textPdf } from "./pdf-fixture.ts";

// Secret-shaped samples are assembled from parts so this file never holds a literal one.
const SECRET_LINE = "DB_PASS" + "WORD=s3cr3t-value-here";
const KEY_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY" + "-----";

function setup(limits: Partial<FsLimits> = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "reach-pdf-"));
  const root = path.join(base, "repo");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  mkdirSync(path.join(base, "outside"));
  const put = (rel: string, data: Buffer | string) => writeFileSync(path.join(root, rel), data);
  return { root, base, put, reader: new FilesystemReader({ root, limits }) };
}

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? `RAW:${(err as Error).message}`;
  }
  return "NO_ERROR";
};

test("a multi-page text PDF is read page by page with numbers and text", async () => {
  const { put, reader } = setup();
  put("docs/a.pdf", textPdf([["Alpha page", "second line"], ["Beta page"], ["Gamma page"]]));
  const out = await readPdf(reader, "docs/a.pdf");
  assert.equal(out.totalPages, 3);
  assert.deepEqual(out.pages.map((p) => p.page), [1, 2, 3]);
  assert.equal(out.pages[0]?.text, "Alpha page\nsecond line");
  assert.equal(out.pages[2]?.text, "Gamma page");
  assert.equal(out.hasText, true);
  assert.equal(out.truncated, false);
  assert.equal(out.nextPage, null);
});

test("pagination: startPage and maxPages are respected and nextPage is deterministic", async () => {
  const { put, reader } = setup();
  put("a.pdf", textPdf([["p1"], ["p2"], ["p3"], ["p4"], ["p5"]]));
  const first = await readPdf(reader, "a.pdf", { maxPages: 2 });
  assert.deepEqual(first.pages.map((p) => p.text), ["p1", "p2"]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextPage, 3);
  const second = await readPdf(reader, "a.pdf", { startPage: first.nextPage as number, maxPages: 2 });
  assert.deepEqual(second.pages.map((p) => p.page), [3, 4]);
  assert.equal(second.nextPage, 5);
  const last = await readPdf(reader, "a.pdf", { startPage: 5 });
  assert.equal(last.nextPage, null);
  assert.equal(last.truncated, false);
  assert.equal(await refusal(() => readPdf(reader, "a.pdf", { startPage: 6 })), "INVALID_ARGUMENT");
  assert.equal(await refusal(() => readPdf(reader, "a.pdf", { startPage: 0 })), "INVALID_ARGUMENT");
  assert.equal(await refusal(() => readPdf(reader, "a.pdf", { maxPages: 0 })), "INVALID_ARGUMENT");
});

test("the page limit caps a larger request; the character cap bounds the output", async () => {
  const { put, root } = setup();
  put("a.pdf", textPdf([["p1"], ["p2"], ["p3"]]));
  const capped = new FilesystemReader({ root, limits: { maxPdfPages: 1 } });
  const out = await readPdf(capped, "a.pdf", { maxPages: 50 });
  assert.equal(out.pages.length, 1);
  assert.equal(out.nextPage, 2);

  put("wide.pdf", textPdf([["w".repeat(60)], ["next page"]]));
  const small = new FilesystemReader({ root, limits: { maxReadChars: 25 } });
  const cut = await readPdf(small, "wide.pdf");
  assert.equal(cut.pages.map((p) => p.text).join("").length <= 25, true);
  assert.equal(cut.pages[0]?.truncated, true);
  assert.equal(cut.truncated, true);
  assert.equal(cut.nextPage, 2, "the cut page is not repeated; the caller continues after it");
});

test("an image-only PDF has no text layer and is reported honestly, without OCR", async () => {
  const { put, reader } = setup();
  put("scan.pdf", textPdf([[]]));
  const out = await readPdf(reader, "scan.pdf");
  assert.equal(out.hasText, false);
  assert.equal(out.pages[0]?.text, "");
});

test("extracted secret assignments are redacted with the shared policy; key material refuses the whole call", async () => {
  const { put, reader } = setup();
  put("s.pdf", textPdf([["before line", SECRET_LINE, "after line"]]));
  const out = await readPdf(reader, "s.pdf");
  assert.ok(!out.pages[0]?.text.includes("s3cr3t-value-here"));
  assert.ok(out.pages[0]?.text.includes(REDACTED));
  assert.ok(out.pages[0]?.text.includes("before line") && out.pages[0]?.text.includes("after line"));
  assert.equal(out.redactions, 1);
  put("k.pdf", textPdf([["innocent intro", KEY_BEGIN, "abc"]]));
  assert.equal(await refusal(() => readPdf(reader, "k.pdf")), "DENIED");
});

test("path policy comes from the shared reader: denied, traversal, symlink and missing paths are refused", async () => {
  const { put, reader, base, root } = setup();
  put("ok.pdf", textPdf([["x"]]));
  put(".env.pdf", textPdf([["x"]]));
  writeFileSync(path.join(base, "outside", "o.pdf"), textPdf([["outside"]]));
  symlinkSync(path.join(base, "outside", "o.pdf"), path.join(root, "link.pdf"));
  symlinkSync(path.join(root, "ok.pdf"), path.join(root, "in-link.pdf"));
  assert.equal(await refusal(() => readPdf(reader, "../outside/o.pdf")), "OUTSIDE_ROOT");
  assert.equal(await refusal(() => readPdf(reader, "/etc/x.pdf")), "OUTSIDE_ROOT");
  assert.equal(await refusal(() => readPdf(reader, "link.pdf")), "SYMLINK_REFUSED");
  assert.equal(await refusal(() => readPdf(reader, "in-link.pdf")), "SYMLINK_REFUSED");
  assert.equal(await refusal(() => readPdf(reader, ".env.pdf")), "DENIED");
  assert.equal(await refusal(() => readPdf(reader, "missing.pdf")), "NOT_FOUND");
  assert.equal(await refusal(() => readPdf(reader, "docs")), "UNSUPPORTED_FORMAT");
});

test("an oversized PDF is refused by size before any parsing", async () => {
  const { put, root } = setup();
  put("big.pdf", Buffer.alloc(5000, 0x61));
  const reader = new FilesystemReader({ root, limits: { maxFileBytes: 1000 } });
  assert.equal(await refusal(() => readPdf(reader, "big.pdf")), "TOO_LARGE", "garbage content proves the parser never ran");
});

test("wrong extension, non-PDF bytes, damaged and truncated PDFs fail with stable codes", async () => {
  const { put, reader } = setup();
  const good = textPdf([["hello"]]);
  put("valid.txt", good);
  put("fake.pdf", "just some text, not a pdf\n");
  put("garbage.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("not really a document at all")]));
  put("cut.pdf", good.subarray(0, Math.floor(good.length / 2)));
  assert.equal(await refusal(() => readPdf(reader, "valid.txt")), "UNSUPPORTED_FORMAT");
  assert.equal(await refusal(() => readPdf(reader, "fake.pdf")), "UNSUPPORTED_FORMAT");
  for (const name of ["garbage.pdf", "cut.pdf"]) assert.equal(await refusal(() => readPdf(reader, name)), "UNSUPPORTED_FORMAT", name);
  put("UPPER.PDF", good);
  assert.equal((await readPdf(reader, "UPPER.PDF")).pages[0]?.text, "hello", "the extension check is case-insensitive");
});

test("a password-protected PDF fails closed without any password handling", async () => {
  const { put, reader } = setup();
  put("locked.pdf", encryptedPdf());
  assert.equal(await refusal(() => readPdf(reader, "locked.pdf")), "UNSUPPORTED_FORMAT");
});

test("the parser path makes no network request", async () => {
  const { put, reader } = setup();
  put("a.pdf", textPdf([["offline"]]));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("network is not allowed");
  }) as typeof fetch;
  try {
    assert.equal((await readPdf(reader, "a.pdf")).pages[0]?.text, "offline");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});
