function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function request(baseUrl, pathname, { method = "GET", body, writeToken } = {}) {
  const url = `${normalizeUrl(baseUrl)}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`Agent Work Ledger request failed (${response.status}): ${value.error || "Unknown error"}`);
  }
  return value;
}

export function createRemoteWorkLedger(baseUrl, { writeToken = null } = {}) {
  if (!normalizeUrl(baseUrl)) throw new Error("Agent Work Ledger control-plane URL is required");
  const write = (pathname, body) => request(baseUrl, pathname, { method: "POST", body, writeToken });
  return {
    createWorkItem(args) {
      return write("/api/v1/work-items", args);
    },
    listWorkItems(args = {}) {
      const query = new URLSearchParams();
      for (const key of ["status", "agent_id", "project"]) {
        if (args[key]) query.set(key, args[key]);
      }
      const suffix = query.size ? `?${query}` : "";
      return request(baseUrl, `/api/v1/work-items${suffix}`);
    },
    getWorkItem(args) {
      return request(baseUrl, `/api/v1/work-items/${encodeURIComponent(args.work_item_id)}`);
    },
    startRun(args) {
      const { work_item_id, ...body } = args;
      return write(`/api/v1/work-items/${encodeURIComponent(work_item_id)}/runs`, body);
    },
    updateRun(args) {
      const { work_item_id, run_id, ...body } = args;
      return write(`/api/v1/work-items/${encodeURIComponent(work_item_id)}/runs/${encodeURIComponent(run_id)}`, body);
    },
    submitReceipt(args) {
      const { work_item_id, ...body } = args;
      return write(`/api/v1/work-items/${encodeURIComponent(work_item_id)}/receipt`, body);
    },
    reviewWorkItem(args) {
      const { work_item_id, ...body } = args;
      return write(`/api/v1/work-items/${encodeURIComponent(work_item_id)}/review`, body);
    },
  };
}
