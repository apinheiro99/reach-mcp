// Minimal hand-built PDFs for tests: a text PDF, an image-only (no text) PDF and an encrypted PDF.
import { createHash } from "node:crypto";

const esc = (s: string): string => s.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

/** Assembles numbered objects into a PDF with a valid xref table. */
function assemble(objects: string[], trailerExtra = ""): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** One page per entry; each entry is a list of text lines. A page with no lines draws only a rectangle. */
export function textPdf(pages: string[][], trailerExtra = ""): Buffer {
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`];
  pages.forEach((lines, i) => {
    const content = lines.length === 0 ? "0 0 100 100 re f" : `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  return assemble(objects, trailerExtra);
}

const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) & 255;
    [s[i], s[j]] = [s[j] as number, s[i] as number];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255;
    b = (b + (s[a] as number)) & 255;
    [s[a], s[b]] = [s[b] as number, s[a] as number];
    out[n] = (data[n] as number) ^ (s[((s[a] as number) + (s[b] as number)) & 255] as number);
  }
  return out;
}

const md5 = (...parts: Buffer[]): Buffer => createHash("md5").update(Buffer.concat(parts)).digest();
const padded = (word: string): Buffer => Buffer.concat([Buffer.from(word, "latin1"), PAD]).subarray(0, 32);

/** A standard-security-handler (RC4 40-bit) PDF whose user password is non-empty, so opening it needs a password. */
export function encryptedPdf(userWord = "open" + "-sesame", ownerWord = "owner" + "-pass"): Buffer {
  const id = Buffer.from("0123456789abcdef", "latin1");
  const o = rc4(md5(padded(ownerWord)).subarray(0, 5), padded(userWord));
  const p = Buffer.alloc(4);
  p.writeInt32LE(-4);
  const key = md5(padded(userWord), o, p, id).subarray(0, 5);
  const u = rc4(key, PAD);
  const hex = (b: Buffer): string => `<${b.toString("hex")}>`;
  const encryptObject = `<< /Filter /Standard /V 1 /R 2 /O ${hex(o)} /U ${hex(u)} /P -4 >>`;
  const base = textPdf([["secret page"]]).toString("latin1");
  // Re-assemble with the Encrypt dictionary as an extra object and the trailer entries that point to it.
  const objects = [...base.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map((m) => m[2] as string);
  objects.push(encryptObject);
  return assemble(objects, `/Encrypt ${objects.length} 0 R /ID [${hex(id)} ${hex(id)}] `);
}
