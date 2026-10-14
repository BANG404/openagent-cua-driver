import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { bridgeMcpScreenshots, prepareScreenshotRequest } from "../bin/lib/mcp-screenshots.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cua-screenshots-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(name, path, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: {
    name, arguments: { pid: 123, window_id: 456, session: "test",
      ...(path === undefined ? {} : { screenshot_out_file: path }) },
  } };
}

describe("MCP screenshot paths", () => {
  test("creates missing absolute parents before the driver writes, including repeated captures", async () => {
    const root = await fixture();
    const path = join(root, "new", "截图 with spaces", "capture.png");
    for (const name of ["get_window_state", "get_desktop_state", "get_window_state"]) {
      const result = await prepareScreenshotRequest(request(name, path), { base: root });
      await writeFile(result.params.arguments.screenshot_out_file, "PNG");
      expect(await readFile(path, "utf8")).toBe("PNG");
    }
  });

  test("relative exports use a fixed data base, with other arguments retained", async () => {
    const root = await fixture();
    const base = join(root, "plugin-data", "screenshots");
    const original = request("get_window_state", "nested/capture.png");
    const result = await prepareScreenshotRequest(original, { base });
    expect(result.params.arguments).toEqual({
      ...original.params.arguments, screenshot_out_file: resolve(base, "nested/capture.png"),
    });
    expect(original.params.arguments.screenshot_out_file).toBe("nested/capture.png");
    await writeFile(result.params.arguments.screenshot_out_file, "PNG");
  });

  test("expands slash and backslash home paths without sending a literal tilde", async () => {
    const root = await fixture();
    for (const path of ["~/nested/capture.png", "~\\nested/capture.png"]) {
      const result = await prepareScreenshotRequest(request("get_window_state", path), { base: "/unused", home: root });
      expect(result.params.arguments.screenshot_out_file).toBe(join(root, "nested", "capture.png"));
      await writeFile(result.params.arguments.screenshot_out_file, "PNG");
    }
  });

  test("keeps inline reads, protocol messages, unrelated tools and invalid types unchanged", async () => {
    const root = await fixture();
    for (const message of [request("get_window_state"), request("get_desktop_state"),
      request("click", "uncreated/file.png"), request("get_window_state", 42),
      { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" }]) {
      expect(await prepareScreenshotRequest(message, { base: root })).toBe(message);
    }
  });

  test("rejects empty paths and Windows drive-relative paths", async () => {
    const root = await fixture();
    for (const path of ["", "  ", ...(process.platform === "win32" ? ["C:shot.png"] : [])]) {
      await expect(prepareScreenshotRequest(request("get_window_state", path), { base: root }))
        .rejects.toMatchObject({ code: "EINVAL" });
    }
  });
});

// This process stands in for the driver: it can write only if preparation
// finished, and its cwd intentionally differs from the request's stable base.
const DRIVER = `
  const fs = require('node:fs');
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const message = JSON.parse(line);
    const path = message.params?.arguments?.screenshot_out_file;
    if (path) fs.writeFileSync(path, 'PNG');
    if (message.id !== undefined) console.log(JSON.stringify({ jsonrpc:'2.0', id:message.id,
      result: { content: [{ type: 'image', mimeType: 'image/png', data: 'UE5H' }],
        ...(path ? { structuredContent: { screenshot_file_path:path } } : {}) } }));
  });
`;

async function throughBridge(messages, { root, locale = "en" }) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
  const child = spawn(process.execPath, ["-e", DRIVER], { cwd: dirname(root), stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveClose(code));
  });
  const pumping = bridgeMcpScreenshots(child, { input, output, base: root, locale: async () => locale });
  // Fragment a multi-byte path across writes to exercise stdio framing.
  const bytes = Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  for (let offset = 0; offset < bytes.length; offset += 3) input.write(bytes.subarray(offset, offset + 3));
  input.end();
  await pumping;
  expect(await closed).toBe(0);
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

describe("stdio screenshot bridge", () => {
  test("preserves request IDs and inline images through a different driver cwd", async () => {
    const root = await fixture();
    const result = await throughBridge([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request("get_window_state", "截图/a.png", "capture"),
      request("get_desktop_state", undefined, 2),
    ], { root });
    expect(result.map((response) => response.id)).toEqual(["capture", 2]);
    expect(result[0].result.structuredContent.screenshot_file_path).toBe(join(root, "截图", "a.png"));
    expect(await readFile(join(root, "截图", "a.png"), "utf8")).toBe("PNG");
    expect(result[1].result.content[0]).toEqual({ type: "image", mimeType: "image/png", data: "UE5H" });
  });

  test("a failed mkdir returns one localized tool error and subsequent inline reads still work", async () => {
    const root = await fixture();
    await writeFile(join(root, "blocked"), "file");
    for (const locale of ["en", "zh"]) {
      const result = await throughBridge([
        request("get_window_state", "blocked/a.png", 10),
        request("get_window_state", undefined, 11),
      ], { root, locale });
      const error = result.find((response) => response.id === 10);
      expect(error.result.isError).toBe(true);
      expect(error.result.content[0].text).toContain(locale === "zh" ? "无法准备截图输出路径" : "Cannot prepare screenshot output path");
      expect(error.result.content[0].text).toContain("screenshot_out_file");
      expect(result.find((response) => response.id === 11).result.content[0].type).toBe("image");
    }
  });

  test("driver shutdown releases an input stream whose caller has not closed it", async () => {
    const input = new PassThrough();
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    const pumping = bridgeMcpScreenshots(child, { input, output: new PassThrough() });
    expect(await closed).toBe(7);
    await pumping;
    expect(input.destroyed).toBe(true);
  });
});
