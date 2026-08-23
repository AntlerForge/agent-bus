import { createRemoteBus } from "../remote-bus.mjs";
import { getWriteToken } from "../write-token.mjs";

const DEFAULT_CONTROL_PLANE = "http://127.0.0.1:8091/agent-bus";

export function estateStewardBus({ baseUrl = process.env.AGENT_BUS_CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE } = {}) {
  return createRemoteBus(baseUrl, { writeToken: getWriteToken() });
}

export async function dispatchOutcomeFailure({ transition, bus = estateStewardBus(), evidencePath }) {
  if (!transition?.notify || transition.type === "recovered") return null;
  const card = transition.card;
  const subject = `Diagnose estate outcome: ${card.check_id}`;
  const body = [
    "A sustained semantic outcome failure needs diagnosis and repair. Do not notify Tony merely because this card exists.",
    "",
    `Check: ${card.check_id}`,
    `First observed: ${card.first_seen}`,
    `Last observed: ${card.last_seen}`,
    `Actual: ${JSON.stringify(card.actual)}`,
    `Expected: ${JSON.stringify(card.expected)}`,
    `Recovery contract: ${card.recovery_contract}`,
    `Evidence: ${evidencePath}`,
    "",
    "Diagnose the functional impact. Repair and verify it when the change is safe, reversible and inside the declared estate boundary. If this is a false positive or recurring defect, correct the observer or underlying architecture with tests so the same signature does not keep returning. Use BLOCKED only when credentials, destructive action, physical intervention or Tony's judgement is genuinely required; state one concrete action and its consequence.",
  ].join("\n");
  return bus.sendMessage({
    from: "outcome-truth",
    to: "codex",
    subject,
    body,
    priority: "high",
    ack_required: true,
    requires_response: true,
    intent: "execute",
    execution_authority: { type: "trusted_policy", policy_id: "estate-steward-repair" },
    idempotency_key: `estate-outcome:${card.card_id}:${card.first_seen}`,
  });
}

export async function dispatchSentinelDeadman({ bucket, maxMinutes, bus = estateStewardBus() }) {
  return bus.sendMessage({
    from: "outcome-deadman",
    to: "codex",
    subject: "Restore the outcome-truth sentinel",
    body: `The semantic outcome sentinel has not written a heartbeat for ${maxMinutes} minutes. Diagnose and restore it on A6, verify a fresh heartbeat, and correct recurrence. Do not notify Tony unless a concrete non-automatable action remains.`,
    priority: "high",
    ack_required: true,
    requires_response: true,
    intent: "execute",
    execution_authority: { type: "trusted_policy", policy_id: "estate-steward-repair" },
    idempotency_key: `estate-outcome-deadman:${bucket}`,
  });
}
