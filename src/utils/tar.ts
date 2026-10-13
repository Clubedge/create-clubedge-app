import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/*
 * A minimal ustar writer: regular files only, as a gzipped archive in memory. Enough to send a
 * project's source to a VM in one stream, without a tar dependency or a system tar on Windows.
 */

const block = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** ustar keeps the path in name (100 bytes) and prefix (155 bytes), split at a slash. */
function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`The path ${path} is too long to upload.`);
}

function header(path: string, size: number, mode: number, mtime: number): Buffer {
  const buffer = Buffer.alloc(block);
  const { name, prefix } = splitPath(path);
  buffer.write(name, 0, 100, "utf8");
  buffer.write(octal(mode, 8), 100, 8, "ascii");
  buffer.write(octal(0, 8), 108, 8, "ascii");
  buffer.write(octal(0, 8), 116, 8, "ascii");
  buffer.write(octal(size, 12), 124, 12, "ascii");
  buffer.write(octal(mtime, 12), 136, 12, "ascii");
  buffer.write("        ", 148, 8, "ascii");
  buffer.write("0", 156, 1, "ascii");
  buffer.write("ustar\0", 257, 6, "ascii");
  buffer.write("00", 263, 2, "ascii");
  buffer.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return buffer;
}

/**
 * Packs the files at `paths` (relative, with forward slashes) under `root` into a .tar.gz.
 * Missing files and anything that is not a regular file are skipped.
 */
export async function createTarGz(root: string, paths: string[]): Promise<{ archive: Buffer; files: number; bytes: number }> {
  const parts: Buffer[] = [];
  let files = 0;
  let bytes = 0;
  for (const path of paths) {
    const stats = await lstat(join(root, path)).catch(() => null);
    if (!stats?.isFile()) continue;
    const content = await readFile(join(root, path));
    const executable = (stats.mode & 0o111) !== 0;
    parts.push(header(path, content.length, executable ? 0o755 : 0o644, Math.floor(stats.mtimeMs / 1000)), content);
    const padding = (block - (content.length % block)) % block;
    if (padding) parts.push(Buffer.alloc(padding));
    files += 1;
    bytes += content.length;
  }
  parts.push(Buffer.alloc(block * 2));
  return { archive: gzipSync(Buffer.concat(parts)), files, bytes };
}
