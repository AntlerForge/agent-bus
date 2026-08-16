import { getWorkItem } from "./work-ledger/store.mjs";
import { createRemoteWorkLedger } from "./work-ledger/remote.mjs";
import { MESSAGE_INTENTS } from "./message-intent.mjs";

export { MESSAGE_INTENTS } from "./message-intent.mjs";

const TRUSTED_POLICIES = Object.freeze({
  "tony-direct-instruction": { senders: ["tony"] },
  "estate-steward-repair": {
    senders: ["estate-monitor", "outcome-truth", "outcome-deadman"],
    recipients: ["codex"],
  },
});

function refuse(reason_code, reason) {
  return { disposition: "refuse", provider_turn: false, state_changes_allowed: false, reason_code, reason };
}

function trustedPolicyAllows(message, policyId, policies) {
  const policy = policies[policyId];
  if (!policy) return false;
  if (policy.senders && !policy.senders.includes(message.from)) return false;
  if (policy.recipients && !policy.recipients.includes(message.to)) return false;
  return true;
}

export async function evaluateMessageAuthority(
  message,
  { getItem, trustedPolicies = TRUSTED_POLICIES } = {},
) {
  if (!MESSAGE_INTENTS.includes(message?.intent)) {
    return refuse("missing_or_invalid_intent", `Intent must be one of: ${MESSAGE_INTENTS.join(", ")}`);
  }
  if (message.intent === "inform") {
    return { disposition: "record_only", provider_turn: false, state_changes_allowed: false, reason_code: null, reason: null };
  }
  if (message.intent === "consult" || message.intent === "recommendation") {
    return { disposition: "provider", provider_turn: true, state_changes_allowed: false, reason_code: null, reason: null };
  }

  const authority = message.execution_authority;
  if (!authority || typeof authority !== "object") {
    return refuse("missing_execution_authority", "Execute intent requires an approved assignment or explicit trusted policy");
  }
  if (authority.type === "trusted_policy") {
    if (!authority.policy_id || !trustedPolicyAllows(message, authority.policy_id, trustedPolicies)) {
      return refuse("invalid_trusted_policy", "The named trusted policy does not authorize this sender and recipient");
    }
    return { disposition: "provider", provider_turn: true, state_changes_allowed: true, reason_code: null, reason: null };
  }
  if (authority.type !== "assignment" || !authority.work_item_id || !authority.assignment_id) {
    return refuse("invalid_assignment_authority", "Assignment authority requires work_item_id and assignment_id");
  }
  if (typeof getItem !== "function") {
    return refuse("authority_unavailable", "Work Ledger authority could not be queried");
  }

  let result;
  try {
    result = await getItem(authority.work_item_id);
  } catch (error) {
    return refuse("authority_lookup_failed", `Work Ledger authority lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const item = result?.item || result;
  const assignment = item?.current_assignment;
  if (!item || !assignment) return refuse("assignment_not_found", "No current approved assignment exists");
  if (!new Set(["ready", "in_progress", "blocked"]).has(item.status)) {
    return refuse("work_not_executable", `Work item status ${item.status || "unknown"} is not executable`);
  }
  if (assignment.assignment_id !== authority.assignment_id) {
    return refuse("stale_assignment", "The supplied assignment is not the current assignment");
  }
  if (assignment.agent_id !== message.to) {
    return refuse("recipient_not_assigned", "The message recipient is not the assigned agent");
  }
  return { disposition: "provider", provider_turn: true, state_changes_allowed: true, reason_code: null, reason: null };
}

export function createAuthorityLookup(root) {
  const baseUrl = process.env.AGENT_BUS_CONTROL_PLANE_URL;
  if (baseUrl) {
    const remote = createRemoteWorkLedger(baseUrl, { writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null });
    return (workItemId) => remote.getWorkItem({ work_item_id: workItemId });
  }
  return (workItemId) => getWorkItem({ work_item_id: workItemId }, root);
}
