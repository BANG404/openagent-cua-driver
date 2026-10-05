import { readFileSync } from "node:fs";

const i18n = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
).extensions.openagent.i18n;

export function resolveLocale(requested) {
  const tag = String(requested ?? "").trim().toLowerCase();
  if (i18n.supported_locales.includes(tag)) return tag;
  const base = tag.split("-")[0];
  return i18n.supported_locales.includes(base) ? base : i18n.default_locale;
}

export async function requestLocale(args, host) {
  const requested = args?._openagent?.locale ?? (host ? await host.locale.get() : i18n.default_locale);
  return resolveLocale(requested);
}

export const defaultLocale = i18n.default_locale;

export function noticeText(key, params = {}, locale = defaultLocale) {
  const template = i18n.translations[resolveLocale(locale)][key];
  if (typeof template !== "string") throw new Error("Unknown Cua Driver notice: " + key);
  return template.replace(/\{(\w+)\}/g, (_, field) => String(params[field] ?? "{" + field + "}"));
}

const patterns = Object.entries(i18n.translations[i18n.default_locale])
  .filter(([key]) => key.startsWith("notice.") && key !== "notice.unexpected")
  .map(([key, text]) => {
    const fields = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    const pattern = text
      .split(/\{\w+\}/)
      .map((part) => [...part].map((character) => "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character).join(""))
      .join("(.+?)");
    return { key, fields, expression: new RegExp("^" + pattern + "$") };
  });

export function translateNotice(text, locale = defaultLocale) {
  const value = String(text);
  const provision = /^Cua Driver (.+?) could not be provisioned for (.+?): (.+)\. The download is (.+), and it is cached under (.+)\.$/s.exec(value);
  if (provision) {
    return noticeText("notice.provisionFailed", {
      version: provision[1],
      platform: provision[2],
      url: provision[4],
      release: provision[5],
    }, locale);
  }
  const installation = /^Cua Driver (.+?) could not be installed under (.+?): (.+)\. Another OpenAgent process may be running a driver that has to be stopped before this release can replace it\.$/s.exec(value);
  if (installation) {
    return noticeText("notice.installFailed", { version: installation[1], release: installation[2] }, locale);
  }
  if (value.startsWith("the archive ") || value.startsWith("archive ") || value.includes(" contains an entry with an empty name")) {
    return noticeText("notice.archiveInvalid", {}, locale);
  }
  for (const { key, expression, fields } of patterns) {
    const match = expression.exec(value);
    if (!match) continue;
    return noticeText(key, Object.fromEntries(fields.map((field, index) => [field, match[index + 1]])), locale);
  }
  return null;
}

export function errorNotice(error, locale) {
  const text = error instanceof Error ? error.message : String(error);
  const translated = translateNotice(text, locale);
  if (translated !== null) return translated;
  const code = String(error?.code ?? error?.cause?.code ?? error?.status ?? "UNKNOWN");
  return noticeText("notice.unexpected", { code }, locale);
}
