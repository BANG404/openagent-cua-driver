import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { noticeText } from "../i18n.mjs";

const CAPTURE_TOOLS = new Set(["get_window_state", "get_desktop_state"]);

/**
 * Prepare only explicitly requested file exports. Omitted paths keep the
 * driver's inline MCP image, without introducing a filesystem dependency.
 */
export async function prepareScreenshotRequest(message, { base, home = homedir() }) {
  const args = message?.params?.arguments;
  if (message?.method !== "tools/call" || !CAPTURE_TOOLS.has(message.params?.name) ||
      typeof args?.screenshot_out_file !== "string") return message;

  const requested = args.screenshot_out_file;
  if (!requested.trim() || (process.platform === "win32" && /^[a-z]:[^\\/]/i.test(requested))) {
    throw Object.assign(new Error("Invalid screenshot output path"), { code: "EINVAL" });
  }
  const expanded = requested === "~" ? home
    : /^~[\\/]/.test(requested) ? join(home, requested.slice(2)) : requested;
  const path = resolve(base, expanded);
  await mkdir(dirname(path), { recursive: true });
  return {
    ...message,
    params: { ...message.params, arguments: { ...args, screenshot_out_file: path } },
  };
}

/**
 * The child remains the MCP protocol owner. Forward its output unchanged;
 * serialize input preparation so a capture cannot race its parent mkdir.
 */
export function bridgeMcpScreenshots(child, {
  input = process.stdin,
  output = process.stdout,
  base = resolve(process.env.PLUGIN_DATA || process.cwd(), "screenshots"),
  locale = async () => "en",
} = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  child.stdout.pipe(output, { end: false });
  // A driver can exit while input is still queued. Release stdin as well so
  // the launcher never remains alive after its protocol child has stopped.
  const stop = () => { lines.close(); input.destroy(); };
  child.once("close", stop);
  child.stdin.on("error", stop);

  return (async () => {
    try {
      for await (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { /* Driver owns parse errors. */ }
        let forwarded = line;
        if (message) {
          try {
            const prepared = await prepareScreenshotRequest(message, { base });
            if (prepared !== message) forwarded = JSON.stringify(prepared);
          } catch (error) {
            // Report one failed tool call, retaining the transport for later
            // inline reads. Do not hide a failed export by claiming it wrote.
            if (message.id !== undefined) {
              output.write(JSON.stringify({
                jsonrpc: "2.0", id: message.id,
                result: { isError: true, content: [{ type: "text", text: noticeText(
                  "notice.screenshotPathFailed",
                  { path: message.params.arguments.screenshot_out_file, code: error.code ?? "UNKNOWN" },
                  await locale(),
                ) }] },
              }) + "\n");
            }
            continue;
          }
        }
        if (child.stdin.destroyed) break;
        await new Promise((resolveWrite, reject) => {
          child.stdin.write(forwarded + "\n", (error) => error ? reject(error) : resolveWrite());
        });
      }
    } finally {
      child.stdin.end();
    }
  })();
}
