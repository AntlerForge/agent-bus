const state = { view: "overview", overview: null, tasks: [], agents: [], threads: [], usage: null, selector: null, agentStatus: null, taskFilter: "all" };
const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const taskDialog = document.querySelector("#task-dialog");
const detailDialog = document.querySelector("#task-detail-dialog");
const workflowDialog = document.querySelector("#workflow-dialog");
const composeDialog = document.querySelector("#compose-dialog");
const threadDialog = document.querySelector("#thread-dialog");
const basePath = document.querySelector('meta[name="agent-bus-base-path"]')?.content || "";
const STATUS_POLL_MS = 30000;

const labels = {
  overview: ["CONTROL PLANE", "Overview"], tasks: ["WORK LEDGER", "Tasks"], agents: ["RUNTIME DIRECTORY", "Agents"],
  models: ["ADVISORY ROUTING", "Model routes"], reviews: ["QUALITY GATES", "Reviews"],
  usage: ["BUDGETS & COST", "Usage"], routes: ["AGENT BUS", "Message routes"],
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
function formatStatus(value) { return String(value || "unknown").replaceAll("_", " "); }
function formatNumber(value) { return value === null || value === undefined ? "Unknown" : new Intl.NumberFormat().format(Number(value)); }
function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never"; }
function badge(status) { return `<span class="badge ${escapeHtml(status)}">${escapeHtml(formatStatus(status))}</span>`; }
function initials(name) { return String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }

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
  if (message && !error) setTimeout(() => { notice.hidden = true; }, 3500);
}

async function load() {
  content.innerHTML = '<div class="loading">Refreshing ledger…</div>';
  try {
    const [overview, tasks, agents, threads, usage, selector, agentStatus] = await Promise.all([
      api("/api/v1/overview"), api("/api/v1/work-items"), api("/api/v1/agents"), api("/api/v1/threads"), api("/api/v1/usage"), api("/api/v1/model-selector"), api("/api/v1/agents/status"),
    ]);
    Object.assign(state, { overview, tasks, agents, threads, usage, selector, agentStatus });
    render();
  } catch (error) { content.innerHTML = `<div class="empty">Could not load the ledger.<br>${escapeHtml(error.message)}</div>`; }
}

function anyDialogOpen() {
  return [taskDialog, detailDialog, workflowDialog, composeDialog, threadDialog].some((dialog) => dialog?.open);
}

async function refreshAgentStatus() {
  if (document.hidden || anyDialogOpen()) return;
  try {
    const [agentStatus, threads] = await Promise.all([api("/api/v1/agents/status"), api("/api/v1/threads")]);
    Object.assign(state, { agentStatus, threads });
    if (["agents", "overview"].includes(state.view)) render();
  } catch { /* transient poll failure; the next interval retries */ }
}
setInterval(refreshAgentStatus, STATUS_POLL_MS);

function taskRows(tasks) {
  if (!tasks.length) return '<div class="empty">No work items in this view.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Work item</th><th>Status</th><th>Delegate</th><th>Review</th><th>Updated</th></tr></thead><tbody>${tasks.map((item) => `
    <tr data-task-id="${escapeHtml(item.work_item_id)}"><td class="title-cell"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source_ref)} · ${escapeHtml(item.objective)}</small></td>
    <td>${badge(item.status)}</td><td>${escapeHtml(item.current_assignment?.agent_id || "Unassigned")}</td><td>${escapeHtml(formatStatus(item.review_policy))}</td><td>${escapeHtml(formatDate(item.updated_at))}</td></tr>`).join("")}</tbody></table></div>`;
}

const LIVENESS_PRESENTATION = {
  fresh: { icon: "✔", label: "Fresh" },
  stale: { icon: "◐", label: "Stale" },
  down: { icon: "✖", label: "Down" },
  unknown: { icon: "?", label: "Unknown" },
};

function livenessBadge(liveness, secondsSince) {
  const { icon, label } = LIVENESS_PRESENTATION[liveness] || LIVENESS_PRESENTATION.unknown;
  const age = secondsSince === null || secondsSince === undefined ? "" : ` · ${formatAge(secondsSince)}`;
  return `<span class="badge liveness-${escapeHtml(liveness)}"><span aria-hidden="true">${icon}</span> ${escapeHtml(label)}${escapeHtml(age)}</span>`;
}

function formatAge(seconds) {
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function statusFor(agentId) {
  return state.agentStatus?.agents?.find((agent) => agent.agent_id === agentId) || null;
}

function agentRows(agents, limit) {
  const list = limit ? agents.slice(0, limit) : agents;
  return `<div class="agent-list">${list.map((agent) => {
    const live = statusFor(agent.agent_id);
    return `<div class="agent-row"><span class="avatar">${escapeHtml(initials(agent.display_name))}</span><div><strong>${escapeHtml(agent.display_name)}</strong><small>${escapeHtml(agent.current_work_item?.title || agent.type)}${agent.queued_count ? ` · ${agent.queued_count} queued` : ""}</small></div>${live ? livenessBadge(live.liveness, live.seconds_since_heartbeat) : badge(agent.derived_status)}</div>`;
  }).join("")}</div>`;
}

function agentThreads(agentId) {
  const threads = state.threads.filter((thread) => (thread.participants || []).includes(agentId)).slice(0, 3);
  if (!threads.length) return '<span class="muted">No threads yet</span>';
  return threads.map((thread) => `<button class="thread-link" data-thread-id="${escapeHtml(thread.thread_id)}">${escapeHtml(thread.subject)} <small>(${escapeHtml(formatStatus(thread.status))})</small></button>`).join("");
}

function agentStatusRows() {
  if (!state.agentStatus) return '<div class="empty">Liveness status is unavailable.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Liveness</th><th>State</th><th>Queue</th><th>Bridge</th><th>Recent threads</th><th></th></tr></thead><tbody>${state.agentStatus.agents.map((agent) => {
    const workload = state.agents.find((entry) => entry.agent_id === agent.agent_id);
    const working = agent.state?.startsWith("working:");
    return `<tr>
      <td class="title-cell"><strong>${escapeHtml(agent.display_name)}</strong><small>${escapeHtml(agent.agent_id)} · ${escapeHtml(agent.type || "unknown")}${workload?.current_work_item ? ` · ledger: ${escapeHtml(workload.current_work_item.title)}` : ""}</small></td>
      <td>${livenessBadge(agent.liveness, agent.seconds_since_heartbeat)}</td>
      <td>${working ? `<span class="badge working"><span aria-hidden="true">▶</span> Working</span><br><button class="thread-link" data-thread-id="${escapeHtml(agent.current_thread_id)}">${escapeHtml(agent.current_thread_id)}</button>` : escapeHtml(formatStatus(agent.state))}</td>
      <td>${agent.queue_depth ?? "—"}</td>
      <td><small>${agent.host ? `${escapeHtml(agent.host)} · pid ${escapeHtml(agent.pid)}` : "No heartbeat seen"}${agent.bridge_version ? ` · v${escapeHtml(agent.bridge_version)}` : ""}${agent.last_receipt_at ? `<br>Last receipt ${escapeHtml(formatDate(agent.last_receipt_at))}` : ""}</small></td>
      <td class="thread-cell">${agentThreads(agent.agent_id)}</td>
      <td><button class="button secondary small" data-compose="${escapeHtml(agent.agent_id)}">Message</button></td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderOverview() {
  const { counts, usage } = state.overview;
  return `<div class="stats">
    <div class="stat"><small>Active work</small><strong>${counts.active}</strong><div class="sub">${counts.ready} ready</div></div>
    <div class="stat"><small>Awaiting review</small><strong>${counts.review}</strong><div class="sub">quality gates</div></div>
    <div class="stat"><small>Blocked</small><strong>${counts.blocked}</strong><div class="sub">needs attention</div></div>
    <div class="stat"><small>Recorded tokens</small><strong>${formatNumber(usage.total_tokens)}</strong><div class="sub">${usage.cost_known ? `£/$ ${usage.estimated_cost.toFixed(2)}` : "cost incomplete"}</div></div>
  </div><div class="grid-two"><section class="panel"><div class="panel-header"><h2>Recent work</h2><button class="button secondary small" data-switch="tasks">View all</button></div>${taskRows(state.overview.recent_work)}</section>
  <section class="panel"><div class="panel-header"><h2>Agents</h2><button class="button secondary small" data-switch="agents">Directory</button></div>${agentRows(state.overview.agents, 7)}</section></div>`;
}

function renderTasks() {
  const statuses = ["all", "proposed", "ready", "in_progress", "blocked", "review", "done"];
  const tasks = state.taskFilter === "all" ? state.tasks : state.tasks.filter((task) => task.status === state.taskFilter);
  return `<section class="panel"><div class="panel-header"><div><h2>Delegated work</h2><p class="muted">One durable outcome can have several agent runs and reviews.</p></div></div>
    <div class="filters">${statuses.map((status) => `<button class="filter ${state.taskFilter === status ? "active" : ""}" data-filter="${status}">${formatStatus(status)}</button>`).join("")}</div>${taskRows(tasks)}</section>`;
}
function renderAgents() {
  const generated = state.agentStatus ? `Bridge heartbeats as of ${formatDate(state.agentStatus.generated_at)}; refreshes every ${STATUS_POLL_MS / 1000}s.` : "Bridge heartbeats unavailable.";
  return `<section class="panel"><div class="panel-header"><div><h2>Live agents</h2><p class="muted">${escapeHtml(generated)} Liveness is transport health from bridge heartbeats — it never changes task status.</p></div><button class="button primary" data-compose="">Message an agent</button></div>${agentStatusRows()}</section>`;
}
function selectorTarget(target) {
  const model = state.selector.models.find((entry) => entry.model_id === target.model_id);
  const surface = state.selector.surfaces.find((entry) => entry.surface_id === target.surface_id);
  return `<strong>${escapeHtml(model?.display_name || target.model_id)} × ${escapeHtml(surface?.display_name || target.surface_id)}</strong><small>${target.role ? `${escapeHtml(formatStatus(target.role))} · ` : ""}${escapeHtml(target.pairing_rationale || "Validated model-harness pair")}</small>`;
}
function harnessCard(surface) {
  const capabilities = Object.entries(surface.harness?.capabilities || {}).filter(([, level]) => ["distinctive", "strong"].includes(level));
  const modelNames = (surface.models || []).map((id) => state.selector.models.find((model) => model.model_id === id)?.display_name || id);
  return `<article class="harness-card"><div class="route-card-head"><div><p class="eyebrow">${escapeHtml(surface.harness?.kind || surface.execution || "surface")}</p><h3>${escapeHtml(surface.display_name)}</h3></div>${badge(surface.access)}</div>
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
function renderReviews() { return `<section class="panel"><div class="panel-header"><div><h2>Awaiting review</h2><p class="muted">Completion gates keep independent review visible and auditable.</p></div></div>${taskRows(state.tasks.filter((task) => task.status === "review"))}</section>`; }
function renderUsage() {
  const rows = Object.entries(state.usage.by_agent || {});
  return `<div class="stats"><div class="stat"><small>Total recorded</small><strong>${formatNumber(state.usage.total_tokens)}</strong><div class="sub">tokens</div></div><div class="stat"><small>Estimated cost</small><strong>${state.usage.cost_known ? state.usage.estimated_cost.toFixed(2) : "—"}</strong><div class="sub">unknown values stay unknown</div></div></div>
  <section class="panel"><div class="panel-header"><div><h2>Usage by agent</h2><p class="muted">Provider receipts should supply these figures; the ledger never invents missing cost.</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Input</th><th>Output</th><th>Total</th><th>Estimated cost</th></tr></thead><tbody>${rows.map(([agent, usage]) => `<tr><td><strong>${escapeHtml(agent)}</strong></td><td>${formatNumber(usage.input_tokens)}</td><td>${formatNumber(usage.output_tokens)}</td><td>${formatNumber(usage.total_tokens)}</td><td>${usage.cost_known ? usage.estimated_cost.toFixed(2) : "Unknown"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No run usage has been recorded yet.</div>'}</section>`;
}
function renderRoutes() { return `<section class="panel"><div class="panel-header"><div><h2>Agent Bus threads</h2><p class="muted">Routes show message delivery. They do not determine task status. Select a thread to read it and reply.</p></div><button class="button primary" data-compose="">New message</button></div>${state.threads.length ? `<div class="table-wrap"><table><thead><tr><th>Thread</th><th>Status</th><th>Participants</th><th>Updated</th></tr></thead><tbody>${state.threads.map((thread) => `<tr class="clickable" data-thread-id="${escapeHtml(thread.thread_id)}"><td class="title-cell"><strong>${escapeHtml(thread.subject)}</strong><small>${escapeHtml(thread.thread_id)}</small></td><td>${badge(thread.status)}</td><td>${escapeHtml((thread.participants || []).join(" → "))}</td><td>${escapeHtml(formatDate(thread.updated))}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No Agent Bus threads yet.</div>'}</section>`; }

function openCompose(agentId) {
  const select = document.querySelector("#compose-to");
  const known = state.agentStatus?.agents || state.agents;
  select.innerHTML = known.map((agent) => `<option value="${escapeHtml(agent.agent_id)}" ${agent.agent_id === agentId ? "selected" : ""}>${escapeHtml(agent.display_name)} (${escapeHtml(agent.agent_id)})</option>`).join("");
  composeDialog.showModal();
}

async function showThread(threadId) {
  try {
    const thread = await api(`/api/v1/threads/${encodeURIComponent(threadId)}`);
    const others = (thread.participants || []).filter((participant) => participant !== "tony");
    threadDialog.dataset.threadId = threadId;
    document.querySelector("#thread-detail").innerHTML = `<div class="dialog-header"><div><p class="eyebrow">${escapeHtml(threadId)}</p><h2>${escapeHtml(thread.subject)}</h2></div><button class="icon-button" data-close-thread aria-label="Close">×</button></div>
      <p class="muted">${badge(thread.status)} · ${escapeHtml((thread.participants || []).join(" → "))} · updated ${escapeHtml(formatDate(thread.updated))}</p>
      <pre class="thread-body">${escapeHtml(thread.body || "(empty thread)")}</pre>`;
    const replyTo = document.querySelector("#reply-to");
    replyTo.innerHTML = (others.length ? others : (thread.participants || [])).map((participant) => `<option value="${escapeHtml(participant)}">${escapeHtml(participant)}</option>`).join("");
    document.querySelector("#reply-form").hidden = !replyTo.innerHTML;
    if (!threadDialog.open) threadDialog.showModal();
  } catch (error) { showNotice(error.message, true); }
}

function render() {
  const [eyebrow, title] = labels[state.view];
  document.querySelector("#view-eyebrow").textContent = eyebrow; document.querySelector("#view-title").textContent = title;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  const views = { overview: renderOverview, tasks: renderTasks, agents: renderAgents, models: renderModels, reviews: renderReviews, usage: renderUsage, routes: renderRoutes };
  content.innerHTML = views[state.view]();
}

async function showTask(workItemId) {
  try {
    const { item, events } = await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}`);
    const actions = [];
    if (item.status === "proposed") actions.push('<button class="button primary" data-action="approve">Approve proposal</button>');
    if (item.status === "ready" && !item.current_assignment) actions.push('<button class="button primary" data-action="assign">Assign agent</button>');
    if (item.status === "ready" && item.current_assignment) actions.push('<button class="button primary" data-action="start">Record run started</button>');
    detailDialog.dataset.taskId = workItemId;
    document.querySelector("#task-detail").innerHTML = `<div class="dialog-header"><div><p class="eyebrow">${escapeHtml(item.source_ref)}</p><h2>${escapeHtml(item.title)}</h2></div><button class="icon-button" data-close-detail aria-label="Close">×</button></div>
      <p>${escapeHtml(item.objective)}</p><div class="detail-meta"><div class="meta-card"><small>Status</small>${badge(item.status)}</div><div class="meta-card"><small>Human owner</small><strong>${escapeHtml(item.human_owner)}</strong></div><div class="meta-card"><small>Agent delegate</small><strong>${escapeHtml(item.current_assignment?.agent_id || "Unassigned")}</strong></div><div class="meta-card"><small>Review</small><strong>${escapeHtml(formatStatus(item.review_policy))}</strong></div><div class="meta-card"><small>Budget</small><strong>${item.budget_tokens === null ? "Not set" : `${formatNumber(item.budget_tokens)} tokens`}</strong></div><div class="meta-card"><small>Runs</small><strong>${item.runs.length}</strong></div></div>
      <div class="detail-actions">${actions.join("")}</div><h3>History</h3><div class="event-list">${events.slice().reverse().map((event) => `<div class="event"><strong>${escapeHtml(formatStatus(event.type))}</strong><br><small>${escapeHtml(event.actor)} · ${escapeHtml(formatDate(event.created_at))}</small></div>`).join("")}</div>`;
    detailDialog.showModal();
  } catch (error) { showNotice(error.message, true); }
}

async function taskAction(action, workItemId) {
  if (action === "approve") await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}/transition`, { method: "POST", body: JSON.stringify({ status: "ready", actor: "tony", reason: "Approved in dashboard" }) });
  if (action === "assign") {
    const agentId = window.prompt(`Assign to agent (${state.agents.map((agent) => agent.agent_id).join(", ")}):`, "codex");
    if (!agentId) return;
    await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}/assign`, { method: "POST", body: JSON.stringify({ agent_id: agentId, assigned_by: "tony" }) });
  }
  if (action === "start") await api(`/api/v1/work-items/${encodeURIComponent(workItemId)}/runs`, { method: "POST", body: JSON.stringify({ actor: "tony", provider: "manual" }) });
  detailDialog.close(); await load(); showNotice("Work item updated.");
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view], [data-switch]");
  if (nav) { state.view = nav.dataset.view || nav.dataset.switch; render(); return; }
  const filter = event.target.closest("[data-filter]"); if (filter) { state.taskFilter = filter.dataset.filter; render(); return; }
  const compose = event.target.closest("[data-compose]"); if (compose) { openCompose(compose.dataset.compose); return; }
  const threadLink = event.target.closest("[data-thread-id]"); if (threadLink) { await showThread(threadLink.dataset.threadId); return; }
  const row = event.target.closest("[data-task-id]"); if (row) { await showTask(row.dataset.taskId); return; }
  if (event.target.closest("[data-close-detail]")) { detailDialog.close(); return; }
  if (event.target.closest("[data-close-thread]")) { threadDialog.close(); return; }
  const action = event.target.closest("[data-action]");
  if (action && detailDialog.open) { try { await taskAction(action.dataset.action, detailDialog.dataset.taskId); } catch (error) { showNotice(error.message, true); } }
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
    showNotice(`Sent ${sent.message_id} on ${sent.thread_id}.`);
    await load();
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector("#reply-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    const sent = await api(`/api/v1/threads/${encodeURIComponent(threadDialog.dataset.threadId)}/reply`, { method: "POST", body: JSON.stringify({
      from: "tony",
      to: data.to,
      body: data.body,
      requires_response: data.requires_response === "on",
    }) });
    form.reset();
    showNotice(`Replied with ${sent.message_id}.`);
    await showThread(threadDialog.dataset.threadId);
  } catch (error) { showNotice(error.message, true); }
});
document.querySelector("#new-task-button").addEventListener("click", () => taskDialog.showModal());
document.querySelector("#refresh-button").addEventListener("click", load);
document.addEventListener("click", (event) => {
  if (!event.target.closest("#new-workflow-button")) return;
  const select = document.querySelector("#workflow-template");
  select.innerHTML = state.selector.workflow_templates.map((template) => `<option value="${escapeHtml(template.template_id)}">${escapeHtml(template.title)}</option>`).join("");
  workflowDialog.showModal();
});
document.querySelector("#task-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "submit") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.acceptance_criteria = data.acceptance_criteria.split("\n").map((line) => line.trim()).filter(Boolean);
  data.budget_tokens = data.budget_tokens ? Number(data.budget_tokens) : null;
  data.human_owner = "tony"; data.proposed_by = "tony";
  try { await api("/api/v1/work-items", { method: "POST", body: JSON.stringify(data) }); taskDialog.close(); form.reset(); await load(); state.view = "tasks"; render(); showNotice("Proposal created. It has not been dispatched."); }
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
    state.view = "tasks";
    render();
    showNotice(`${result.created.length} linked proposals created. Nothing has been dispatched.`);
  } catch (error) { showNotice(error.message, true); }
});
document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  const views = ["overview", "tasks", "agents", "models", "reviews", "usage", "routes"];
  const index = Number(event.key) - 1; if (views[index]) { state.view = views[index]; render(); }
});
load();
