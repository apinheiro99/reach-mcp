// Deterministic archive writers: ustar .tgz and .zip from the same in-memory entry list, with no external tool and no
// symlink support (a link is refused, so an archive can never depend on one). Timestamps are fixed so equal input gives equal bytes.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";

/** Every regular file under `root` as { path (posix, relative), data, mode }, sorted by path. Anything else is refused. */
export function collectEntries(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) entries.push({ path: path.relative(root, abs).split(path.sep).join("/"), data: readFileSync(abs), mode: st.mode & 0o111 ? 0o755 : 0o644 });
      else throw new Error(`archive: ${abs} is not a regular file or directory (links are refused)`);
    }
  };
  walk(root);
  return entries;
}

const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  let name = entry.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = [...name.matchAll(/\//g)].map((m) => m.index).find((i) => i <= 155 && Buffer.byteLength(name) - i - 1 <= 100);
    if (cut === undefined) throw new Error(`archive: path too long for ustar: ${entry.path}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  header.write(name, 0);
  header.write(octal(entry.mode, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(entry.data.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0" + "00", 257);
  header.write(prefix, 345);
  header.write(octal(header.reduce((sum, byte) => sum + byte, 0), 7).slice(0, 6) + "\0 ", 148);
  return header;
}

/** .tgz bytes (gzip level 9, no filename or time in the gzip header). */
export function tgz(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry), entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** .zip bytes: deflate entries, UTF-8 names, fixed 1980-01-01 time, unix mode in the external attributes. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const body = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
