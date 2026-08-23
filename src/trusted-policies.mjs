export const TRUSTED_POLICIES = Object.freeze({
  "tony-direct-instruction": {
    message: { senders: ["tony"] },
  },
  "chief-of-staff-relay": {
    message: { senders: ["chief-of-staff"] },
    ledger: {
      relays: ["chief-of-staff"],
      decisions: ["approve", "assign", "approve_and_assign", "cancel", "review_approve"],
    },
  },
  "estate-steward-repair": {
    message: {
      senders: ["estate-monitor", "outcome-truth", "outcome-deadman"],
      recipients: ["codex"],
    },
  },
});

export function trustedPolicyAllowsMessage(message, policyId, policies = TRUSTED_POLICIES) {
  const policy = policies[policyId];
  if (!policy) return false;
  const scope = policy.message || policy;
  if (scope.senders && !scope.senders.includes(message.from)) return false;
  if (scope.recipients && !scope.recipients.includes(message.to)) return false;
  return true;
}

export function trustedPolicyAllowsLedger(
  { relaying_role, decision },
  policyId,
  policies = TRUSTED_POLICIES,
) {
  const scope = policies[policyId]?.ledger;
  if (!scope) return false;
  if (scope.relays && !scope.relays.includes(relaying_role)) return false;
  if (scope.decisions && !scope.decisions.includes(decision)) return false;
  return true;
}
