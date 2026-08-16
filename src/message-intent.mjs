export const MESSAGE_INTENTS = Object.freeze(["inform", "consult", "recommendation", "execute"]);

export function assertMessageIntent(intent) {
  if (!MESSAGE_INTENTS.includes(intent)) {
    throw new Error(`intent is required and must be one of: ${MESSAGE_INTENTS.join(", ")}`);
  }
  return intent;
}

export function authorityPrompt(intent, stateChangesAllowed) {
  if (intent === "consult") return "Authority: consult only. Read and answer; do not change external or durable state.";
  if (intent === "recommendation") return "Authority: recommendation only. Analyse and propose; do not apply changes.";
  if (intent === "execute" && stateChangesAllowed) return "Authority: execute. State changes are limited to the approved assignment or trusted policy in this message.";
  return "Authority: no provider execution.";
}
