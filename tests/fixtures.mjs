/**
 * Minimal archive writers, so the extractor's refusals are tested against
 * archives built to be refused.
 *
 * These write exactly the fields a real pinned release uses and nothing more:
 * one deflate member, or one tar member of a named type. That is the point —
 * the fixtures exist to be hostile in the ways the extractor claims to catch, so
 * they are built byte by byte rather than produced by a packer whose defaults
 * would have to be argued about.
 */

import { deflateRawSync, gzipSync } from "node:zlib";

/** A stored or deflated zip member. */
function zipMember({ name, contents, method, externalAttributes = 0, madeBy = 0x0014 }) {
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents ?? "");
  const data = method === 8 ? deflateRawSync(body) : body;
  const nameBytes = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(madeBy, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(externalAttributes, 38);

  return { local, central, nameBytes, data };
}

/** Build a zip archive from `members`. */
export function buildZip(members) {
  const parts = members.map(zipMember);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const part of parts) {
    const header = Buffer.concat([part.local, part.nameBytes]);
    locals.push(header, part.data);
    part.central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([part.central, part.nameBytes]));
    offset += header.length + part.data.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

/** A zip member whose name escapes the extraction directory. */
export function zipTraversal(name = "../escaped.txt") {
  return buildZip([{ name, contents: "escaped", method: 0 }]);
}

/** A zip member marked as a Unix symbolic link. */
export function zipSymbolicLink(name = "cua-driver", target = "/etc/passwd") {
  return buildZip([
    { name, contents: target, method: 0, madeBy: 0x0314, externalAttributes: (0xa1ff << 16) >>> 0 },
  ]);
}

/** A regular zip file member containing `contents`. */
export function zipWithFile(name, contents, method = 8) {
  return buildZip([{ name, contents, method }]);
}

const TAR_BLOCK = 512;

function tarText(value, length) {
  const buffer = Buffer.alloc(length);
  buffer.write(value, 0, Math.min(Buffer.byteLength(value), length - 1), "utf8");
  return buffer;
}

function tarOctal(value, length) {
  const text = `${value.toString(8).padStart(length - 2, "0")}\0`;
  return Buffer.from(text.slice(0, length), "latin1");
}

function tarHeader({ name, size, type, mode = 0o644, linkname = "" }) {
  const header = Buffer.alloc(TAR_BLOCK);
  tarText(name, 100).copy(header, 0);
  tarOctal(mode, 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108);
  tarOctal(0, 8).copy(header, 116);
  tarOctal(size, 12).copy(header, 124);
  tarOctal(0, 12).copy(header, 136);
  header.write(type, 156, "latin1");
  tarText(linkname, 100).copy(header, 157);
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(header, 148);
  return header;
}

/** Build a gzipped tar archive from members of shape `{ name, contents, type }`. */
export function buildTarGz(members) {
  const parts = [];
  for (const member of members) {
    const type = member.type ?? "0";
    const contents = Buffer.isBuffer(member.contents)
      ? member.contents
      : Buffer.from(member.contents ?? "");
    const size = type === "0" ? contents.length : 0;
    parts.push(tarHeader({ ...member, size, type }));
    if (size > 0) {
      parts.push(contents, Buffer.alloc(Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size));
    }
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}
