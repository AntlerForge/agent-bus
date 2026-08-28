import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerAgent } from "../src/agents.mjs";
import { sendMessage } from "../src/mailbox.mjs";
import { evaluateRoleAttention } from "../src/role-attention.mjs";

test("attention monitor raises only aged response-required unread messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-attention-"));
  await registerAgent({ agent_id: "coherence-manager" }, root);
  await sendMessage({ from: "chief-of-staff", to: "coherence-manager", subject: "Review", body: "Please review", requires_response: true, intent: "consult" }, root);
  const early = await evaluateRoleAttention({ now_ms: Date.now(), thresholds: { unread_response_seconds: 3600, waiting_run_seconds: 3600, pending_review_seconds: 3600 } }, root);
  assert.equal(early.findings.length, 0);
  const late = await evaluateRoleAttention({ now_ms: Date.now() + 3601_000, thresholds: { unread_response_seconds: 3600, waiting_run_seconds: 3600, pending_review_seconds: 3600 } }, root);
  assert.equal(late.findings[0].type, "unread_response");
});
