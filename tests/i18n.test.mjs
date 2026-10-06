import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { errorNotice, requestLocale, translateNotice } from "../bin/i18n.mjs";

const i18n = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")).extensions.openagent.i18n;

test("Cua Driver translations cover every declared metadata and notice key", () => {
  expect(i18n.supported_locales).toEqual(["en", "zh"]);
  const baseline = Object.keys(i18n.translations.en).sort();
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of i18n.supported_locales) {
    expect(Object.keys(i18n.translations[locale]).sort()).toEqual(baseline);
    for (const key of baseline) {
      expect(i18n.translations[locale][key].trim()).not.toBe("");
      expect(placeholders(i18n.translations[locale][key])).toEqual(placeholders(i18n.translations.en[key]));
    }
  }
});

test("Cua Driver uses the current locale for process notices", async () => {
  const host = { locale: { get: async () => "zh-Hans-CN" } };
  expect(await requestLocale({}, host)).toBe("zh");
  expect(translateNotice("fetching Cua Driver 1.2.2 for windows-x86_64 from https://example.test/driver.zip", "zh"))
    .toBe("正在从 https://example.test/driver.zip 下载适用于 windows-x86_64 的 Cua Driver 1.2.2");
  expect(errorNotice(new Error("the download declares 200 bytes, beyond the accepted limit"), "zh"))
    .toBe("下载声明的大小为 200 字节，超过允许上限");
  expect(translateNotice("updated Cua Driver to 0.34.0", "zh"))
    .toBe("已将 Cua Driver 更新至 0.34.0");
  expect(translateNotice("Cua Driver automatic update failed; using the last verified driver", "zh"))
    .toBe("Cua Driver 自动更新失败；继续使用上次校验通过的驱动");
});
