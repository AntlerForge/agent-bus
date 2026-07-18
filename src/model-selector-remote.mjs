function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function request(baseUrl, pathname, { method = "GET", body, writeToken } = {}) {
  const response = await fetch(`${normalizeUrl(baseUrl)}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Remote model selector request failed (${response.status}): ${value.error || "Unknown error"}`);
  return value;
}

export function createRemoteModelSelector(baseUrl, { writeToken = null } = {}) {
  if (!normalizeUrl(baseUrl)) throw new Error("Agent Bus control-plane URL is required");
  return {
    get() {
      return request(baseUrl, "/api/v1/model-selector");
    },
    proposeWorkflow({ template_id, ...body }) {
      return request(baseUrl, `/api/v1/model-selector/templates/${encodeURIComponent(template_id)}/propose`, {
        method: "POST",
        body,
        writeToken,
      });
    },
  };
}
