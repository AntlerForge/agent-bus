const state = {
  view: "home", overview: null, tasks: [], agents: [], threads: [], usage: null, selector: null,
  agentStatus: null, taskFilter: "all", activityFilter: "all", activityQuery: "", showRetired: false,
};
const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const taskDialog = document.querySelector("#task-dialog");
const detailDialog = document.querySelector("#task-detail-dialog");
const workflowDialog = document.querySelector("#workflow-dialog");
const composeDialog = document.querySelector("#compose-dialog");
const threadDialog = document.querySelector("#thread-dialog");
const agentDialog = document.querySelector("#agent-dialog");
const basePath = document.querySelector('meta[name="agent-bus-base-path"]')?.content || "";
const STATUS_POLL_MS = 30000;

const labels = {
  home: ["YOUR AGENTS AT A GLANCE", "Home"], agents: ["SET UP, WATCH, STAND DOWN", "Agents"],
  activity: ["EVERY JOB, NEWEST FIRST", "Activity"], ledger: ["APPROVALS & RECEIPTS", "Tracked jobs"],
  models: ["ADVISORY ROUTING", "Model routes"], usage: ["BUDGETS & COST", "Usage"],
};

// Plain-language presentation of thread (conversation) statuses.
const JOB_STATUS = {
  open: { label: "Waiting for agent", cls: "waiting", active: true },
  acknowledged: { label: "Agent has seen it", cls: "waiting", active: true },
  in_progress: { label: "Agent is working", cls: "working", active: true },
  input_required: { label: "Waiting on you", cls: "needs-you", needsYou: true },
  blocked: { label: "Stuck", cls: "needs-you", needsYou: true },
  completed: { label: "Finished", cls: "done", finished: true },
  failed: { label: "Failed", cls: "bad", finished: true },
  canceled: { label: "Cancelled", cls: "quiet", finished: true },
  closed: { label: "Closed", cls: "quiet", finished: true },
};

// Plain-language presentation of tracked work-item statuses.
const WORK_STATUS = {
  proposed: { label: "Waiting for your approval", cls: "needs-you", needsYou: true },
  ready: { label: "Approved — not started", cls: "waiting", active: true },
  in_progress: { label: "Being worked on", cls: "working", active: true },
  blocked: { label: "Stuck — needs you", cls: "needs-you", needsYou: true },
  review: { label: "Needs your sign-off", cls: "needs-you", needsYou: true },
  done: { label: "Done", cls: "done", finished: true },
  canceled: { label: "Cancelled", cls: "quiet", finished: true },
};

function jobStatus(status) { return JOB_STATUS[status] || { label: status || "unknown", cls: "quiet" }; }
function workStatus(status) { return WORK_STATUS[status] || { label: status || "unknown", cls: "quiet" }; }

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
function formatNumber(value) { return value === null || value === undefined ? "Unknown" : new Intl.NumberFormat().format(Number(value)); }
function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never"; }
function formatStatus(value) { return String(value || "unknown").replaceAll("_", " "); }
function initials(name) { return String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function chip(meta) { return `<span class="badge status-${escapeHtml(meta.cls)}">${escapeHtml(meta.label)}</span>`; }
function formatAge(seconds) {
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
function since(iso) { return iso ? formatAge(Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))) : "never"; }

async function api(path, options = {}) {
  const token = sessionStorage.getItem("agentBusWriteToken");
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(`${basePath}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

function showNotice(message, error = false) {
  notice.textContent = message; notice.hidden = !message; notice.classList.toggle("error", error);
  if (message && !error) setTimeout(() => { notice.hidden = true; }, 4000);
}

async function load() {
  content.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const [overview, tasks, agents, threads, usage, selector, agentStatus] = await Promise.all([
      api("/api/v1/overview"), api("/api/v1/work-items"), api("/api/v1/agents"), api("/api/v1/threads"), api("/api/v1/usage"), api("/api/v1/model-selector"), api("/api/v1/agents/status"),
    ]);
    Object.assign(state, { overview, tasks, agents, threads, usage, selector, agentStatus });
    render();
  } catch (error) { content.innerHTML = `<div class="empty">Could not load.<br>${escapeHtml(error.message)}</div>`; }
}

function anyDialogOpen() {
  return [taskDialog, detailDialog, workflowDialog, composeDialog, threadDialog, agentDialog].some((dialog) => dialog?.open);
}

async function refreshAgentStatus() {
  if (document.hidden || anyDialogOpen()) return;
  try {
    const [agentStatus, threads] = await Promise.all([api("/api/v1/agents/status"), api("/api/v1/threads")]);
    Object.assign(state, { agentStatus, threads });
    if (["home", "agents", "activity"].includes(state.view)) render();
  } catch { /* transient poll failure; the next interval retries */ }
}
setInterval(refreshAgentStatus, STATUS_POLL_MS);

// ---------- agents ----------

function statusFor(agentId) {
  return state.agentStatus?.agents?.find((agent) => agent.agent_id === agentId) || null;
}

function threadSubject(threadId) {
  return state.threads.find((thread) => thread.thread_id === threadId)?.subject || threadId;
}

// One plain sentence about whether this agent can take work right now.
function presence(agent) {
  if (!agent) return { label: "Never connected", cls: "quiet", detail: "" };
  if (agent.lifecycle_status === "retired") return { label: "Stood down", cls: "quiet", detail: "Hidden from routing until you reactivate it." };
  if (agent.state?.startsWith("working:")) {
    return { label: "Working", cls: "working", detail: threadSubject(agent.current_thread_id), threadId: agent.current_thread_id };
  }
  if (agent.connection === "channel") {
    if (["fresh", "stale"].includes(agent.liveness)) return { label: "Connected", cls: "online", detail: "A session is open right now." };
    return { label: "Opens with a session", cls: "quiet", detail: "This one lives inside Claude Code — it is available whenever you have a session open. Not a fault." };
  }
  if (agent.liveness === "fresh") return { label: "Online", cls: "online", detail: agent.queue_depth ? `${agent.queue_depth} job(s) queued` : "Ready for work" };
  if (agent.liveness === "stale") return { label: "Quiet", cls: "waiting", detail: `Last heard ${formatAge(agent.seconds_since_heartbeat)} — usually the Mac is asleep. If not, run npm run bridge:doctor.` };
  if (agent.liveness === "down") return { label: "Offline", cls: "bad", detail: "Not responding. In a terminal run: npm run bridge:doctor — it prints the exact fix." };
  return { label: "Never connected", cls: "quiet", detail: "Registered but no service has ever reported in." };
}

function visibleAgents() {
  const RANK = { online: 0, working: 0, waiting: 1, bad: 2, quiet: 3 };
  return (state.agentStatus?.agents || [])
    .filter((agent) => state.showRetired || agent.lifecycle_status !== "retired")
    .map((agent) => ({ agent, p: presence(agent) }))
    .sort((a, b) => (RANK[a.p.cls] ?? 4) - (RANK[b.p.cls] ?? 4)
      || new Date(b.agent.last_heartbeat || b.agent.last_seen || 0) - new Date(a.agent.last_heartbeat || a.agent.last_seen || 0));
}

function agentActivity(agentId) {
  return allActivity().filter((item) => item.agents.includes(agentId));
}

function agentCard({ agent, p }) {
  const last = agentActivity(agent.agent_id)[0];
  return `<article class="agent-card" data-agent="${escapeHtml(agent.agent_id)}">
    <div class="agent-card-head"><span class="avatar">${escapeHtml(initials(agent.display_name))}</span>
      <div><strong>${escapeHtml(agent.display_name)}</strong><small>${agent.connection === "channel" ? "session-based" : "always-on"}</small></div>
      ${chip(p)}</div>
    <p class="agent-card-detail">${p.threadId ? `<button class="thread-link" data-thread-id="${escapeHtml(p.threadId)}">${escapeHtml(p.detail)}</button>` : escapeHtml(p.detail || "")}</p>
    ${last && !p.threadId ? `<p class="agent-card-last">Last: <button class="thread-link" data-open-kind="${last.kind}" data-open-id="${escapeHtml(last.id)}">${escapeHtml(last.title)}</button> <small>(${escapeHtml(last.statusMeta.label.toLowerCase())}, ${escapeHtml(since(last.updated))})</small></p>` : ""}
    <div class="agent-card-actions"><button class="button primary small" data-compose="${escapeHtml(agent.agent_id)}">Give it a job</button>
    <button class="button secondary small" data-agent="${escapeHtml(agent.agent_id)}">History</button></div>
  </article>`;
}

// ---------- unified activity (conversations + tracked jobs) ----------

function allActivity() {
  const jobs = state.threads.map((thread) => ({
    kind: "thread", id: thread.thread_id, title: thread.subject,
    who: (thread.participants || []).join(" → "),
    agents: thread.participants || [],
    statusMeta: jobStatus(thread.status), rawStatus: thread.status,
    updated: thread.updated, typeLabel: "Job",
  }));
  const tracked = state.tasks.map((item) => ({
    kind: "task", id: item.work_item_id, title: item.title,
    who: `asked by ${item.proposed_by || "unknown"}${item.current_assignment ? `, ${item.current_assignment.agent_id} doing it` : ""}`,
    agents: [item.proposed_by, item.current_assignment?.agent_id].filter(Boolean),
    statusMeta: workStatus(item.status), rawStatus: item.status,
    updated: item.updated_at, typeLabel: "Tracked",
  }));
  return jobs.concat(tracked).sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));
}

function activityRows(items, emptyMessage) {
  if (!items.length) return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
  return `<div class="activity-list">${items.map((item) => `
    <button class="activity-row" data-open-kind="${item.kind}" data-open-id="${escapeHtml(item.id)}">
      <span class="type-tag ${item.kind}">${item.typeLabel}</span>
      <span class="activity-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.who)}</small></span>
      ${chip(item.statusMeta)}
      <span class="activity-when">${escapeHtml(since(item.updated))}</span>
    </button>`).join("")}</div>`;
}

// ---------- views ----------

function renderHome() {
  const activity = allActivity();
  const needsYou = activity.filter((item) => item.statusMeta.needsYou);
  const happening = activity.filter((item) => item.statusMeta.active);
  const finished = activity.filter((item) => item.statusMeta.finished).slice(0, 8);
  const agents = visibleAgents();
  return `
    <section class="panel needs-you-panel"><div class="panel-header"><div><h2>Needs you${needsYou.length ? ` (${needsYou.length})` : ""}</h2><p class="muted">Approvals, sign-offs and anything stuck. Everything else runs without you.</p></div></div>
      ${activityRows(needsYou, "Nothing needs you right now.")}</section>
    <section class="panel"><div class="panel-header"><div><h2>Happening now</h2><p class="muted">Jobs agents are on at the moment.</p></div></div>
      ${activityRows(happening, "Nothing running. Give an agent a job.")}</section>
    <section class="panel"><div class="panel-header"><div><h2>Your agents</h2><p class="muted">Click one for its history, or hand it a job directly.</p></div><button class="button secondary small" data-switch="agents">Manage</button></div>
      <div class="agent-grid">${agents.map(agentCard).join("")}</div></section>
    <section class="panel"><div class="panel-header"><div><h2>Recently finished</h2><p class="muted">Click any job to read the result and the files it produced.</p></div><button class="button secondary small" data-switch="activity">All activity</button></div>
      ${activityRows(finished, "Nothing finished yet.")}</section>`;
}

function renderAgents() {
  const agents = visibleAgents();
  const retiredCount = (state.agentStatus?.agents || []).filter((agent) => agent.lifecycle_status === "retired").length;
  return `<section class="panel"><div class="panel-header"><div><h2>Your agents</h2><p class="muted">Sorted by availability. Updates every ${STATUS_POLL_MS / 1000}s.</p></div>
      <div class="header-actions">${retiredCount ? `<button class="button secondary" data-toggle-retired>${state.showRetired ? "Hide" : "Show"} stood down (${retiredCount})</button>` : ""}<button class="button primary" data-compose="">Give an agent a job</button></div></div>
    <div class="agent-grid">${agents.map(agentCard).join("")}</div></section>
    <section class="panel help-panel"><h2>How this works</h2>
      <div class="help-columns">
        <div><h3>Give an agent a job</h3><p>Press <strong>Give it a job</strong>, write what you want in plain words, send. The agent picks it up on its own machine, works, and replies on the same job — you will see it move through <em>Agent has seen it → Agent is working → Finished</em> on Home. Files it creates are listed when you open the finished job.</p></div>
        <div><h3>Always-on vs session-based</h3><p><strong>Always-on</strong> agents (Codex, Cursor, Antigravity) run as background services on the Mac and take work day or night. If one shows <em>Offline</em>, run <code>npm run bridge:doctor</code> in a terminal — it prints the exact repair. <strong>Session-based</strong> agents (Claude Code) are only reachable while you have a session open; that is normal, not a fault.</p></div>
        <div><h3>Add a new agent</h3><p>An agent needs a small background service built for it (about an hour of work that an existing agent can do). Press <strong>Give it a job</strong> on Cursor or Codex and say: <em>"Set up a new Agent Bus bridge for &lt;provider&gt; following deploy/macos/README.md"</em>. Once its service starts reporting in, it appears here automatically.</p></div>
        <div><h3>Retire an agent</h3><p>Open its history and press <strong>Stand down</strong>. It keeps its past record but disappears from routing and this list. You can reactivate it any time.</p></div>
      </div></section>`;
}

function renderActivity() {
  const query = state.activityQuery.trim().toLowerCase();
  let items = allActivity();
  if (state.activityFilter === "needs-you") items = items.filter((item) => item.statusMeta.needsYou);
  if (state.activityFilter === "active") items = items.filter((item) => item.statusMeta.active);
  if (state.activityFilter === "finished") items = items.filter((item) => item.statusMeta.finished);
  if (query) items = items.filter((item) => `${item.title} ${item.who}`.toLowerCase().includes(query));
  const filters = [["all", "All"], ["needs-you", "Needs you"], ["active", "Active"], ["finished", "Finished"]];
  return `<section class="panel"><div class="panel-header"><div><h2>All activity</h2><p class="muted">Every job and tracked item, newest first. <strong>Job</strong> = a direct conversation with an agent. <strong>Tracked</strong> = work that goes through approval and sign-off.</p></div></div>
    <div class="activity-controls"><div class="filters">${filters.map(([key, label]) => `<button class="filter ${state.activityFilter === key ? "active" : ""}" data-activity-filter="${key}">${label}</button>`).join("")}</div>
    <input type="search" id="activity-search" placeholder="Search jobs…" value="${escapeHtml(state.activityQuery)}"></div>
    ${activityRows(items, query ? "No jobs match that search." : "No activity yet.")}</section>`;
}

function taskRows(tasks) {
  if (!tasks.length) return '<div class="empty">No tracked jobs in this view.</div>';
  const sorted = tasks.slice().sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  return `<div class="table-wrap"><table><thead><tr><th>Tracked job</th><th>Status</th><th>Asked by</th><th>Doing it</th><th>Sign-off</th><th>Updated</th></tr></thead><tbody>${sorted.map((item) => `
    <tr data-task-id="${escapeHtml(item.work_item_id)}"><td class="title-cell"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source_ref)} · ${escapeHtml(item.objective)}</small></td>
    <td>${chip(workStatus(item.status))}</td><td>${escapeHtml(item.proposed_by || "unknown")}</td><td>${escapeHtml(item.current_assignment?.agent_id || "Unassigned")}</td><td>${escapeHtml(item.review_policy === "human" ? "You" : item.review_policy === "independent_agent" ? "Another agent" : "None")}</td><td>${escapeHtml(formatDate(item.updated_at))}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderLedger() {
  const statuses = ["all", "proposed", "ready", "in_progress", "blocked", "review", "done"];
  const tasks = state.taskFilter === "all" ? state.tasks : state.tasks.filter((task) => task.status === state.taskFilter);
  return `<section class="panel"><div class="panel-header"><div><h2>Tracked jobs</h2><p class="muted">Work that goes through your approval and ends with an evidence receipt. Direct jobs to agents do not appear here — see Activity for those.</p></div><button class="button primary" id="ledger-new-task">Track a new job</button></div>
    <div class="filters">${statuses.map((status) => `<button class="filter ${state.taskFilter === status ? "active" : ""}" data-filter="${status}">${status === "all" ? "All" : workStatus(status).label}</button>`).join("")}</div>${taskRows(tasks)}
    <details class="legend"><summary>How a tracked job flows</summary>
    <p class="muted"><strong>Waiting for your approval</strong> (someone suggested it — nothing happens until you say yes) → <strong>Approved</strong> → <strong>Being worked on</strong> (an agent has picked it up) → <strong>Needs your sign-off</strong> (the agent submitted evidence of what it did) → <strong>Done</strong>. If it shows <strong>Stuck</strong>, open it and read the last event.</p></details></section>`;
}

function selectorTarget(target) {
  const model = state.selector.models.find((entry) => entry.model_id === target.model_id);
  const surface = state.selector.surfaces.find((entry) => entry.surface_id === target.surface_id);
  return `<strong>${escapeHtml(model?.display_name || target.model_id)} × ${escapeHtml(surface?.display_name || target.surface_id)}</strong><small>${target.role ? `${escapeHtml(formatStatus(target.role))} · ` : ""}${escapeHtml(target.pairing_rationale || "Validated model-harness pair")}</small>`;
}
function harnessCard(surface) {
  const capabilities = Object.entries(surface.harness?.capabilities || {}).filter(([, level]) => ["distinctive", "strong"].includes(level));
  const modelNames = (surface.models || []).map((id) => state.selector.models.find((model) => model.model_id === id)?.display_name || id);
  return `<article class="harness-card"><div class="route-card-head"><div><p class="eyebrow">${escapeHtml(surface.harness?.kind || surface.execution || "surface")}</p><h3>${escapeHtml(surface.display_name)}</h3></div><span class="badge ${escapeHtml(surface.access)}">${escapeHtml(formatStatus(surface.access))}</span></div>
    <p class="muted harness-meta">${escapeHtml(surface.provider)} · ${escapeHtml(surface.installed_version || "Hosted")} · ${escapeHtml(formatStatus(surface.harness?.execution_location || surface.execution))}</p>
    <div class="capability-tags">${capabilities.map(([name, level]) => `<span class="capability ${escapeHtml(level)}">${escapeHtml(formatStatus(name))}</span>`).join("")}</div>
    <div class="harness-columns"><div><strong>Strengths</strong><ul>${(surface.harness?.strengths || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div><div><strong>Weaknesses</strong><ul>${(surface.harness?.weaknesses || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></div>
    <p class="harness-models"><strong>Verified pairings:</strong> ${escapeHtml(modelNames.join(", "))}</p></article>`;
}
function renderModels() {
  const selector = state.selector;
  if (!selector || selector.status === "unavailable") return `<div class="empty">Model routing is unavailable.<br>${escapeHtml(selector?.warnings?.join(" ") || "No selector data was loaded.")}</div>`;
  const routes = selector.routes.map((route) => {
    const targets = route.panel || (route.primary ? [route.primary] : []);
    return `<article class="route-card"><div class="route-card-head"><div><p class="eyebrow">${escapeHtml(route.route_id)}</p><h3>${escapeHtml(route.title)}</h3></div>${route.confidence ? `<span class="confidence">${escapeHtml(route.confidence)}</span>` : ""}</div><div class="route-targets">${targets.map((target) => `<div class="route-target">${selectorTarget(target)}</div>`).join("")}</div>${route.note ? `<p class="muted route-note">${escapeHtml(route.note)}</p>` : ""}</article>`;
  }).join("");
  return `<div class="stats selector-stats"><div class="stat"><small>Selector state</small><strong class="status-word">${escapeHtml(selector.status)}</strong><div class="sub">schema ${escapeHtml(selector.schema_version)}</div></div><div class="stat"><small>Models × harnesses</small><strong>${selector.summary.model_harness_pair_count ?? "—"}</strong><div class="sub">validated execution stacks</div></div><div class="stat"><small>Available harnesses</small><strong>${selector.summary.available_surface_count}</strong><div class="sub">${selector.summary.model_count} intrinsic model profiles</div></div><div class="stat"><small>Next review</small><strong class="date-word">${escapeHtml(selector.next_review)}</strong><div class="sub">models and harnesses</div></div></div>
    ${selector.warnings.length ? `<div class="notice error">${selector.warnings.map(escapeHtml).join(" ")}</div>` : ""}
    <section class="panel"><div class="panel-header"><div><h2>Advisory execution-stack routes</h2><p class="muted">Each route recommends a validated model × harness pairing. It never dispatches work.</p></div>${selector.workflow_templates.length ? '<button class="button primary" id="new-workflow-button">Set up review panel</button>' : ""}</div><div class="route-grid">${routes}</div></section>
    <section class="panel surface-panel"><div class="panel-header"><div><h2>Harness profiles</h2><p class="muted">Operational capability, access and weaknesses are tracked separately from intrinsic model quality.</p></div></div><div class="harness-grid">${selector.surfaces.map(harnessCard).join("")}</div></section>`;
}
function renderUsage() {
  const rows = Object.entries(state.usage.by_agent || {});
  return `<div class="stats"><div class="stat"><small>Total recorded</small><strong>${formatNumber(state.usage.total_tokens)}</strong><div class="sub">tokens</div></div><div class="stat"><small>Estimated cost</small><strong>${state.usage.cost_known ? state.usage.estimated_cost.toFixed(2) : "—"}</strong><div class="sub">unknown values stay unknown</div></div></div>
  <section class="panel"><div class="panel-header"><div><h2>Usage by agent</h2><p class="muted">Provider receipts should supply these figures; the ledger never invents missing cost.</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Input</th><th>Output</th><th>Total</th><th>Estimated cost</th></tr></thead><tbody>${rows.map(([agent, usage]) => `<tr><td><strong>${escapeHtml(agent)}</strong></td><td>${formatNumber(usage.input_tokens)}</td><td>${formatNumber(usage.output_tokens)}</td><td>${formatNumber(usage.total_tokens)}</td><td>${usage.cost_known ? usage.estimated_cost.toFixed(2) : "Unknown"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No run usage has been recorded yet.</div>'}</section>`;
}

function render() {
  const [eyebrow, title] = labels[state.view];
  document.querySelector("#view-eyebrow").textContent = eyebrow; document.querySelector("#view-title").textContent = title;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  const views = { home: renderHome, agents: renderAgents, activity: renderActivity, ledger: renderLedger, models: renderModels, usage: renderUsage };
  content.innerHTML = views[state.view]();
  const search = document.querySelector("#activity-search");
  if (search) {
    search.addEventListener("input", () => { state.activityQuery = search.value; render(); document.querySelector("#activity-search")?.focus(); });
    if (state.activityQuery) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }
}

// ---------- dialogs ----------

function openCompose(agentId) {
  const select = document.querySelector("#compose-to");
  const known = (state.agentStatus?.agents || state.agents).filter((agent) => agent.lifecycle_status !== "retired" || agent.agent_id === agentId);
  select.innerHTML = known.map((agent) => `<option value="${escapeHtml(agent.agent_id)}" ${agent.agent_id === agentId ? "selected" : ""}>${escapeHtml(agent.display_name)} (${escapeHtml(agent.agent_id)})</option>`).join("");
  composeDialog.showModal();
}

function extractFiles(body) {
  const matches = String(body || "").match(/(?:file:\/\/)?(\/(?:Users|srv|tmp|Volumes)\/[^\s)`'"<>\]]+)/g) || [];
  return [...new Set(matches.map((match) => match.replace(/^file:\/\//, "").replace(/[.,;:]+$/, "")))];
}

async function showThread(threadId) {
  try {
    const thread = await api(`/api/v1/threads/${encodeURIComponent(threadId)}`);
    const others = (thread.participants || []).filter((participant) => participant !== "tony");
    const files = extractFiles(thread.body);
    threadDialog.dataset.threadId = threadId;
    document.querySelector("#thread-detail").innerHTML = `<div class="dialog-header"><div><p class="eyebrow">JOB</p><h2>${escapeHtml(thread.subject)}</h2></div><button class="icon-button" data-close-thread aria-label="Close">×</button></div>
      <p class="muted">${chip(jobStatus(thread.status))} · ${escapeHtml((thread.participants || []).join(" → "))} · updated ${escapeHtml(formatDate(thread.updated))}</p>
      ${files.length ? `<div class="files-box"><strong>Files mentioned in this job</strong>${files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>` : ""}
      <pre class="thread-body">${escapeHtml(thread.body || "(empty job)")}</pre>`;
    const replyTo = document.querySelector("#reply-to");
    replyTo.innerHTML = (others.length ? others : (thread.participants || [])).map((participant) => `<option value="${escapeHtml(participant)}">${escapeHtml(participant)}</option>`).join("");
    document.querySelector("#reply-form").hidden = !replyTo.innerHTML;
    if (!threadDialog.open) threadDialog.showModal();
  } catch (error) { showNotice(error.message, true); }
}

function showAgent(agentId) {
  const agent = statusFor(agentId);
  if (!agent) { showNotice(`Unknown agent: ${agentId}`, true); return; }
  const p = presence(agent);
  const history = agentActivity(agentId).slice(0, 20);
  const retired = agent.lifecycle_status === "retired";
  const kindLine = agent.connection === "channel"
    ? "Session-based: reachable while a Claude Code session is open."
    : `Always-on service on ${agent.host || "the Mac"}${agent.bridge_version ? ` (v${agent.bridge_version})` : ""}. If it goes offline, run npm run bridge:doctor in a terminal for the exact fix.`;
  document.querySelector("#agent-detail").innerHTML = `<div class="dialog-header"><div><p class="eyebrow">${escapeHtml(agent.agent_id)}</p><h2>${escapeHtml(agent.display_name)}</h2></div><button class="icon-button" data-close-agent aria-label="Close">×</button></div>
    <p class="muted">${chip(p)} ${escapeHtml(p.detail || "")}</p>
    <p class="muted">${escapeHtml(kindLine)}</p>
    <div class="detail-actions"><button class="button primary" data-compose="${escapeHtml(agent.agent_id)}">Give it a job</button>
      <button class="button secondary" data-stand-down="${escapeHtml(agent.agent_id)}" data-next="${retired ? "active" : "retired"}">${retired ? "Reactivate" : "Stand down"}</button></div>
    <h3>What it has done</h3>
    ${activityRows(history, "No jobs yet. Give it one.")}`;
  if (!agentDialog.open) agentDialog.showModal();
}

async function setAgentLifecycle(agentId, status) {
  try {
    await api(`/api/v1/agents/${encodeURIComponent(agentId)}/lifecycle`, { method: "POST", body: JSON.stringify({ status, actor: "tony" }) });
    if (agentDialog.open) agentDialog.close();
    showNotice(status === "retired" ? `${agentId} stood down. Its history is kept — reactivate it any time from "Show stood down".` : `${agentId} is back in the rotation.`);
    await load();
  } catch (error) { showNotice(error.message, true); }
}

async function showTask(workItemId) {
  try {
    const { item, events } = await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}`);
    const actions = [];
    if (item.status === "proposed") actions.push('<button class="button primary" data-action="approve">Approve — let it start</button>');
    if (item.status === "ready" && !item.current_assignment) actions.push('<button class="button primary" data-action="assign">Choose an agent</button>');
    if (item.status === "ready" && item.current_assignment) actions.push('<button class="button primary" data-action="start">Record run started</button>');
    detailDialog.dataset.taskId = workItemId;
    document.querySelector("#task-detail").innerHTML = `<div class="dialog-header"><div><p class="eyebrow">TRACKED JOB · ${escapeHtml(item.source_ref)}</p><h2>${escapeHtml(item.title)}</h2></div><button class="icon-button" data-close-detail aria-label="Close">×</button></div>
      <p>${escapeHtml(item.objective)}</p><div class="detail-meta"><div class="meta-card"><small>Status</small>${chip(workStatus(item.status))}</div><div class="meta-card"><small>Asked by</small><strong>${escapeHtml(item.proposed_by || "unknown")}</strong></div><div class="meta-card"><small>Doing it</small><strong>${escapeHtml(item.current_assignment?.agent_id || "No one yet")}</strong></div><div class="meta-card"><small>Sign-off</small><strong>${escapeHtml(item.review_policy === "human" ? "You" : item.review_policy === "independent_agent" ? "Another agent" : "None")}</strong></div><div class="meta-card"><small>Budget</small><strong>${item.budget_tokens === null ? "Not set" : `${formatNumber(item.budget_tokens)} tokens`}</strong></div><div class="meta-card"><small>Runs</small><strong>${item.runs.length}</strong></div></div>
      <div class="detail-actions">${actions.join("")}</div><h3>History</h3><div class="event-list">${events.slice().reverse().map((event) => `<div class="event"><strong>${escapeHtml(formatStatus(event.type))}</strong><br><small>${escapeHtml(event.actor)} · ${escapeHtml(formatDate(event.created_at))}</small></div>`).join("")}</div>`;
    detailDialog.showModal();
  } catch (error) { showNotice(error.message, true); }
}

async function taskAction(action, workItemId) {
  if (action === "approve") await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}/transition`, { method: "POST", body: JSON.stringify({ status: "ready", actor: "tony", reason: "Approved in dashboard" }) });
  if (action === "assign") {
    const agentId = window.prompt(`Which agent should do it? (${state.agents.map((agent) => agent.agent_id).join(", ")}):`, "codex");
    if (!agentId) return;
    await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}/assign`, { method: "POST", body: JSON.stringify({ agent_id: agentId, assigned_by: "tony" }) });
  }
  if (action === "start") await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}/runs`, { method: "POST", body: JSON.stringify({ actor: "tony", provider: "manual" }) });
  detailDialog.close(); await load(); showNotice("Updated.");
}

// ---------- events ----------

document.addEventListener("click", async (event) => {
  // Close buttons and dialog actions come before the generic row matchers:
  // the open dialogs carry data ids themselves, so a dialog-wide closest()
  // match would swallow every click inside them.
  if (event.target.closest("[data-close-detail]")) { detailDialog.close(); return; }
  if (event.target.closest("[data-close-thread]")) { threadDialog.close(); return; }
  if (event.target.closest("[data-close-agent]")) { agentDialog.close(); return; }
  const action = event.target.closest("[data-action]");
  if (action && detailDialog.open) {
    try { await taskAction(action.dataset.action, detailDialog.dataset.taskId); } catch (error) { showNotice(error.message, true); }
    return;
  }
  const nav = event.target.closest("[data-view], [data-switch]");
  if (nav) { state.view = nav.dataset.view || nav.dataset.switch; render(); return; }
  const filter = event.target.closest("[data-filter]"); if (filter) { state.taskFilter = filter.dataset.filter; render(); return; }
  const activityFilter = event.target.closest("[data-activity-filter]");
  if (activityFilter) { state.activityFilter = activityFilter.dataset.activityFilter; render(); return; }
  const retiredToggle = event.target.closest("[data-toggle-retired]");
  if (retiredToggle) { state.showRetired = !state.showRetired; render(); return; }
  const standDown = event.target.closest("[data-stand-down]");
  if (standDown) { await setAgentLifecycle(standDown.dataset.standDown, standDown.dataset.next); return; }
  const compose = event.target.closest("[data-compose]"); if (compose) { openCompose(compose.dataset.compose); return; }
  const opener = event.target.closest("[data-open-kind]");
  if (opener) {
    if (opener.dataset.openKind === "thread") { await showThread(opener.dataset.openId); } else { await showTask(opener.dataset.openId); }
    return;
  }
  const threadLink = event.target.closest("button[data-thread-id], tr[data-thread-id]");
  if (threadLink) { await showThread(threadLink.dataset.threadId); return; }
  const agentCardEl = event.target.closest("[data-agent]");
  if (agentCardEl) { showAgent(agentCardEl.dataset.agent); return; }
  const row = event.target.closest("tr[data-task-id]"); if (row) { await showTask(row.dataset.taskId); return; }
  if (event.target.closest("#ledger-new-task")) { taskDialog.showModal(); return; }
  if (event.target.closest("#new-workflow-button")) {
    const select = document.querySelector("#workflow-template");
    select.innerHTML = state.selector.workflow_templates.map((template) => `<option value="${escapeHtml(template.template_id)}">${escapeHtml(template.title)}</option>`).join("");
    workflowDialog.showModal();
  }
});

document.querySelector("#compose-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    const sent = await api("/api/v1/messages", { method: "POST", body: JSON.stringify({
      from: "tony",
      to: data.to,
      subject: data.subject,
      body: data.body,
      requires_response: data.requires_response === "on",
      ack_required: true,
    }) });
    composeDialog.close(); form.reset();
    showNotice(`Sent. Watch it under Happening now — the agent usually picks it up within a minute.`);
    await load();
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector("#reply-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/v1/threads/${encodeURIComponent(threadDialog.dataset.threadId)}/reply`, { method: "POST", body: JSON.stringify({
      from: "tony",
      to: data.to,
      body: data.body,
      requires_response: data.requires_response === "on",
    }) });
    form.reset();
    showNotice("Reply sent on the same job.");
    await showThread(threadDialog.dataset.threadId);
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector("#refresh-button").addEventListener("click", load);
document.querySelector("#give-job-button").addEventListener("click", () => openCompose(""));
document.querySelector("#task-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.acceptance_criteria = data.acceptance_criteria.split("\n").map((line) => line.trim()).filter(Boolean);
  data.budget_tokens = data.budget_tokens ? Number(data.budget_tokens) : null;
  data.human_owner = "tony"; data.proposed_by = "tony";
  try { await api("/api/v1/work-items", { method: "POST", body: JSON.stringify(data) }); taskDialog.close(); form.reset(); await load(); state.view = "ledger"; render(); showNotice("Tracked job created. Open it and press Approve when you are ready for an agent to start."); }
  catch (error) { showNotice(error.message, true); }
});
document.querySelector("#workflow-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const templateId = data.template_id;
  delete data.template_id;
  data.human_owner = "tony";
  data.proposed_by = "tony";
  try {
    const result = await api(`/api/v1/model-selector/templates/${encodeURIComponent(templateId)}/propose`, { method: "POST", body: JSON.stringify(data) });
    workflowDialog.close();
    await load();
    state.view = "ledger";
    render();
    showNotice(`${result.created.length} linked proposals created. Nothing has been dispatched.`);
  } catch (error) { showNotice(error.message, true); }
});
document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  const views = ["home", "agents", "activity", "ledger", "models", "usage"];
  const index = Number(event.key) - 1; if (views[index]) { state.view = views[index]; render(); }
});
load();
