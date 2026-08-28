function base(value) { return String(value).replace(/\/+$/, ""); }
async function call(url, path, { method = "GET", body, writeToken } = {}) {
  const response = await fetch(`${base(url)}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(`Remote role-seat request failed (${response.status}): ${value.error}`);
  return value;
}
export function createRemoteRoleSeats(url, { writeToken } = {}) {
  const write = (path, body) => call(url, path, { method: "POST", body, writeToken });
  return {
    list: () => call(url, "/api/v1/role-seats"),
    wake: (args) => write("/api/v1/role-seats/wake", args),
    claim: (args) => write("/api/v1/role-seats/claim", args),
    unseat: (args) => write(`/api/v1/role-seats/${encodeURIComponent(args.role)}/unseat`, args),
  };
}
