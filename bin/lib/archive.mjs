/**
 * Extract a pinned release archive into a directory, or refuse it.
 *
 * The archives this reads are digest-verified before they get here, so the
 * checks below are not the trust anchor; they are the reason a digest mistake, a
 * re-cut upstream asset, or a change of packaging format stays a loud failure
 * instead of becoming a file written somewhere nobody chose. Everything the
 * pinned releases actually contain is accepted — regular files, directories, and
 * deflate or stored members — and every other shape is refused by name:
 * traversal, absolute paths, links, ZIP64, and PAX or GNU long-name member
 * types. Refusing the last three is deliberate: each encodes a path somewhere
 * other than the field the reader would otherwise trust, and accepting one
 * without a decoder that handles all of it is how an extractor writes outside
 * its destination.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ZIP_MAXIMUM_COMMENT = 0xffff;

const UNIX_FILE_TYPE = 0xf000;
const UNIX_SYMBOLIC_LINK = 0xa000;

const TAR_BLOCK = 512;
const TAR_UNIX_MAGIC = "ustar";

/**
 * Extract `archive` into `destination`, which must not exist yet.
 *
 * `kind` is `"zip"` or `"tar.gz"`, and `label` names the archive in the errors
 * the caller reports.
 */
export function extractBuffer(archive, kind, destination, label) {
  const entries = kind === "zip" ? zipEntries(archive) : tarEntries(gunzipSync(archive));
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = resolveTarget(destination, entry.name, label);
    if (entry.directory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.contents, entry.mode ? { mode: entry.mode } : undefined);
  }
}

/**
 * The path an archive member is allowed to become.
 *
 * The containment check is repeated after resolution rather than inferred from
 * the name, because a name is not a path until the platform has resolved it.
 */
function resolveTarget(destination, name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${label} contains an entry with an empty name`);
  }
  const name_ = name.replace(/\\/g, "/");
  if (name_.startsWith("/") || /^[a-zA-Z]:/.test(name_)) {
    throw new Error(`${label} contains the absolute entry '${name}'`);
  }
  const segments = name_.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) {
    throw new Error(`${label} contains the traversing entry '${name}'`);
  }
  const root = resolve(destination);
  const target = resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`${label} contains the escaping entry '${name}'`);
  }
  return target;
}

function zipEntries(archive) {
  const end = findEndOfCentralDirectory(archive);
  if (end < 0) {
    throw new Error("the archive does not end in a zip central directory");
  }
  const count = archive.readUInt16LE(end + 10);
  const start = archive.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff) {
    throw new Error("the archive is ZIP64, which is not a pinned release format");
  }

  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw new Error(`the archive central directory is malformed at entry ${index}`);
    }
    const madeBy = archive.readUInt16LE(offset + 4);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);

    const unixMode = externalAttributes >>> 16;
    if (madeBy >> 8 === 3 && (unixMode & UNIX_FILE_TYPE) === UNIX_SYMBOLIC_LINK) {
      throw new Error(`the archive links '${name}', which a pinned release does not contain`);
    }

    const local = archive.readUInt32LE(offset + 42);
    if (archive.readUInt32LE(local) !== ZIP_LOCAL_HEADER) {
      throw new Error(`the archive local header for '${name}' is malformed`);
    }
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    const localName = archive.toString("utf8", local + 30, local + 30 + localNameLength);
    if (localName !== name) {
      throw new Error(`the archive names '${name}' twice, and not identically`);
    }

    const data = local + 30 + localNameLength + localExtraLength;
    const contents = inflateMember(archive, method, data, compressedSize, uncompressedSize, name);
    entries.push({
      name,
      contents,
      directory: name.endsWith("/"),
      // Windows archives record no Unix mode, and a Windows executable needs
      // none; the Unix archives carry the bit that makes the driver runnable.
      mode: madeBy >> 8 === 3 ? unixMode & 0o777 : undefined,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateMember(archive, method, data, compressedSize, uncompressedSize, name) {
  const raw = archive.subarray(data, data + compressedSize);
  let contents;
  if (method === 0) {
    contents = Buffer.from(raw);
  } else if (method === 8) {
    contents = inflateRawSync(raw);
  } else {
    throw new Error(`the archive compresses '${name}' with unsupported method ${method}`);
  }
  if (contents.length !== uncompressedSize) {
    throw new Error(`the archive entry '${name}' does not inflate to its recorded size`);
  }
  return contents;
}

function findEndOfCentralDirectory(archive) {
  if (archive.length < ZIP_END_OF_CENTRAL_DIRECTORY_SIZE) return -1;
  const earliest = Math.max(
    0,
    archive.length - ZIP_END_OF_CENTRAL_DIRECTORY_SIZE - ZIP_MAXIMUM_COMMENT,
  );
  for (
    let offset = archive.length - ZIP_END_OF_CENTRAL_DIRECTORY_SIZE;
    offset >= earliest;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function tarEntries(archive) {
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    offset += TAR_BLOCK;

    if (header.subarray(257, 257 + TAR_UNIX_MAGIC.length).toString("latin1") !== TAR_UNIX_MAGIC) {
      throw new Error("the archive is not a ustar archive");
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const size = tarSize(header);
    const contents = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    const prefix = tarText(header, 345, 155);
    const leaf = tarText(header, 0, 100);
    const name = prefix ? `${prefix}/${leaf}` : leaf;

    if (type === "0" || type === "\u0000") {
      entries.push({
        name,
        contents: Buffer.from(contents),
        directory: false,
        mode: (tarMode(header) & 0o777) || 0o644,
      });
      continue;
    }
    if (type === "5") {
      entries.push({ name, contents: null, directory: true, mode: 0o755 });
      continue;
    }
    // Long names, links, sparse files, and PAX headers all move a path or a body
    // out of the fields below, so they are refused rather than half-decoded.
    throw new Error(
      `the archive contains the tar member type '${type}', which a pinned release does not use`,
    );
  }
  return entries;
}

function tarText(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

function tarMode(header) {
  return tarOctal(header.subarray(100, 108), "mode");
}

function tarSize(header) {
  return tarOctal(header.subarray(124, 136), "size");
}

/**
 * One octal header field.
 *
 * The GNU base-256 encoding is refused rather than decoded: no pinned asset is
 * large enough to need it, and a size field read as the wrong number is how an
 * extractor walks off the end of its own buffer.
 */
function tarOctal(field, label) {
  if ((field[0] & 0x80) !== 0) {
    throw new Error(`the archive uses the base-256 encoding for a tar ${label}`);
  }
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("the archive contains an unreadable tar header");
  }
  return value;
}
