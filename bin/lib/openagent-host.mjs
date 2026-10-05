const URL_ENV = "OPENAGENT_PLUGIN_HOST_URL";
const TOKEN_ENV = "OPENAGENT_PLUGIN_HOST_TOKEN";
const ID_ENV = "OPENAGENT_PLUGIN_ID";

export function createHostClient({ environment = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = String(environment?.[URL_ENV] ?? "").trim();
  const token = String(environment?.[TOKEN_ENV] ?? "").trim();
  const pluginId = String(environment?.[ID_ENV] ?? "").trim();
  if (!url || !token || !pluginId) throw new Error("OpenAgent plugin host credentials are not set");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  async function call(operation) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ operation, args: { plugin_id: pluginId } }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      const error = new Error(String(body?.error ?? "plugin host operation failed"));
      error.code = response.status ? "HOST_HTTP_" + response.status : "HOST_OPERATION_FAILED";
      throw error;
    }
    return body.result;
  }

  const locale = {
    async get() {
      const result = await call("locale.get");
      if (result?.version !== 1 || typeof result.locale !== "string" || !result.locale.trim()) {
        const error = new Error("unsupported host locale response");
        error.code = "HOST_LOCALE_VERSION";
        throw error;
      }
      return result.locale;
    },
  };
  return Object.freeze({ locale });
}
