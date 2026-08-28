function base(value) { return String(value).replace(/\/+$/, ""); }
async function call(url, path, { method = "GET", body, writeToken, roleWakeCredential } = {}) {
  const response = await fetch(`${base(url)}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}), ...(roleWakeCredential ? { "x-agent-bus-role-wake-identity": roleWakeCredential.identity, "x-agent-bus-role-wake-token": roleWakeCredential.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(`Remote role-seat request failed (${response.status}): ${value.error}`);
  return value;
}
export function createRemoteRoleSeats(url, { writeToken, roleWakeCredential } = {}) {
  const write = (path, body) => call(url, path, { method: "POST", body, writeToken, roleWakeCredential });
  return {
    list: () => call(url, "/api/v1/role-seats"),
    wake: (args) => write("/api/v1/role-seats/wake", args),
    claim: (args) => write("/api/v1/role-seats/claim", args),
    heartbeat: (args) => write(`/api/v1/role-seats/${encodeURIComponent(args.role)}/heartbeat`, args),
    attachSession: (args) => write(`/api/v1/role-seats/${encodeURIComponent(args.role)}/session`, args),
    recover: (args) => write("/api/v1/role-seats/recover", args),
    unseat: (args) => write(`/api/v1/role-seats/${encodeURIComponent(args.role)}/unseat`, args),
    signal: (args) => write("/api/v1/role-seats/signal", args),
    deliverNotes: (args = {}) => write("/api/v1/role-seats/deliver-notes", args),
    workerHeartbeat: (args = {}) => write("/api/v1/role-seats/worker-heartbeat", args),
    completeAttentionPass: (args) => write("/api/v1/role-seats/attention-pass", args),
  };
}
