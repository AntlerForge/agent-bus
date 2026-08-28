import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../deploy/antler-a6/zulip/", import.meta.url);

test("phase 1 binds Zulip only to the declared loopback port and bind mounts declared state", async () => {
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  assert.match(compose, /127\.0\.0\.1:\$\{ZULIP_HTTP_PORT:-8093\}:80/);
  for (const path of ["zulip", "postgresql", "rabbitmq", "redis"]) {
    assert.match(compose, new RegExp(`zulip-estate/data\\}\\/${path}`));
  }
  assert.doesNotMatch(compose, /published:\s*(25|80|443)/);
});

test("phase 1 has no relay, publisher or Agent Bus credential", async () => {
  const files = [
    "compose.yaml",
    "systemd/antler-zulip-stack.service",
    "systemd/antler-zulip.target",
  ];
  const text = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(text, /AGENT_BUS_WRITE_TOKEN|inbound-relay|outbound-publisher|antler-zulip-inbound|antler-zulip-outbound/);
});

test("stack startup fails closed unless 1Password injection is available", async () => {
  const unit = await readFile(new URL("systemd/antler-zulip-stack.service", root), "utf8");
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -x \/usr\/bin\/op/);
  assert.match(unit, /zulip-antlerforge\.token/);
  assert.match(unit, /antler-zulip-op-run/);
  assert.doesNotMatch(unit, /Environment=.*PASSWORD/);
});

test("1Password deployment names and references are permanent and exact", async () => {
  const refs = await readFile(new URL("zulip.op.env", root), "utf8");
  const launcher = await readFile(new URL("scripts/op-service-account-run.sh", root), "utf8");
  assert.match(refs, /op:\/\/AntlerForge Deployments\/zulip-antlerforge\/secret_key/);
  assert.doesNotMatch(refs, /REPLACE_|trial/i);
  assert.match(launcher, /stat -c '%U:%G'/);
  assert.match(launcher, /test \"\$mode\" = \"600\"/);
  assert.match(launcher, /OP_SERVICE_ACCOUNT_TOKEN/);
  assert.match(launcher, /\/usr\/bin\/op run --env-file/);
});

test("owner-facing names do not describe AntlerForge Zulip as temporary", async () => {
  const files = ["README.md", "G0-CLIENT-TEST.md", "OWNER-ACTIONS.md", "CLOUDFLARE-ACCESS-SPEC.md"];
  const text = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(text, /\btrial\b/i);
  assert.match(text, /AntlerForge Zulip/);
});
