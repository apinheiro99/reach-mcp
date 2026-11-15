// PNG/JPEG/WebP only: extension AND content must agree, header dimensions and byte size are bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { FilesystemReader } from "../src/filesystem/index.ts";
import { code, makeFixture } from "./fixture.ts";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(Math.min(h, 4) * (1 + Math.min(w, 4) * 3), 0x7f);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function jpeg(w: number, h: number): Buffer {
  const sof = Buffer.alloc(13);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 1;
  sof[10] = 1;
  sof[11] = 0x11;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
function webp(w: number, h: number): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), Buffer.from("VP8X", "latin1"), Buffer.from([10, 0, 0, 0]), vp8x]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
}

const { root, outside } = makeFixture();
const files: Record<string, Buffer> = {
  "img/a.png": png(4, 3),
  "img/b.jpg": jpeg(8, 6),
  "img/c.webp": webp(5, 7),
  "img/mismatch.png": jpeg(2, 2),
  "img/fake.png": Buffer.from("not an image"),
  "img/vec.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  "img/anim.gif": Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
  "img/big.png": Buffer.concat([png(4, 3), Buffer.alloc(900_000)]),
  "img/wide.png": png(9000, 1),
  "img/tall.jpg": jpeg(10, 20000),
  "img/note.txt": Buffer.from("hi"),
};
mkdirSync(path.join(root, "img"));
for (const [rel, data] of Object.entries(files)) writeFileSync(path.join(root, rel), data);
writeFileSync(path.join(root, ".env.png"), png(1, 1));
writeFileSync(path.join(outside, "o.png"), png(1, 1));
symlinkSync(path.join(outside, "o.png"), path.join(root, "img/out-link.png"));
const reader = new FilesystemReader({ root, limits: { maxImageBytes: 800_000 } });

test("readImage returns the original bytes with the mime type and parsed dimensions", () => {
  for (const [p, mime, w, h] of [["img/a.png", "image/png", 4, 3], ["img/b.jpg", "image/jpeg", 8, 6], ["img/c.webp", "image/webp", 5, 7]] as const) {
    const out = reader.readImage(p);
    assert.deepEqual([out.path, out.mimeType, out.width, out.height], [p, mime, w, h]);
    assert.ok(out.data.equals(files[p] as Buffer), `${p} byte-identical`);
    assert.equal(out.bytes, (files[p] as Buffer).length);
  }
});

test("readImage refuses a wrong extension, other formats, content mismatch and non-images", () => {
  for (const p of ["img/mismatch.png", "img/fake.png", "img/vec.svg", "img/anim.gif", "img/note.txt"]) assert.equal(code(() => reader.readImage(p)), "UNSUPPORTED_FORMAT", p);
});

test("readImage bounds bytes and header dimensions", () => {
  assert.equal(code(() => reader.readImage("img/big.png")), "TOO_LARGE");
  assert.equal(code(() => reader.readImage("img/wide.png")), "DIMENSIONS_TOO_LARGE");
  assert.equal(code(() => reader.readImage("img/tall.jpg")), "DIMENSIONS_TOO_LARGE");
  const narrow = new FilesystemReader({ root, limits: { maxImageBytes: 800_000, maxImageWidth: 4 } });
  assert.equal(code(() => narrow.readImage("img/b.jpg")), "DIMENSIONS_TOO_LARGE", "limits are configurable");
});

test("readImage shares the path refusals", () => {
  const expected: [string, string][] = [
    ["../outside/o.png", "OUTSIDE_ROOT"],
    ["/etc/passwd", "OUTSIDE_ROOT"],
    ["img/out-link.png", "SYMLINK_REFUSED"],
    [".env", "DENIED"],
    [".env.png", "DENIED"],
    ["img/missing.png", "NOT_FOUND"],
    ["img", "NOT_FILE"],
    ["", "NOT_FILE"],
  ];
  for (const [p, c] of expected) assert.equal(code(() => reader.readImage(p)), c, p);
});
