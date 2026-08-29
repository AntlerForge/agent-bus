import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../deploy/antler-a6/zulip/", import.meta.url);

test("phase 1 binds Zulip only to the declared loopback port and bind mounts declared state", async () => {
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  assert.match(compose, /127\.0\.0\.1:\$\{ZULIP_HTTP_PORT:-8093\}:80/);
  for (const path of ["zulip", "postgresql", "rabbitmq", "redis"]) {
    assert.match(compose, new RegExp(`zulip-estate/data\\}\/${path}`));
  }
  assert.doesNotMatch(compose, /published:\s*(25|80|443)/);
});

test("phase 1 has no relay, publisher or Agent Bus credential", async () => {
  const files = ["compose.yaml", "systemd/antler-zulip-stack.service", "systemd/antler-zulip.target"];
  const text = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(text, /AGENT_BUS_WRITE_TOKEN|inbound-relay|outbound-publisher|antler-zulip-inbound|antler-zulip-outbound/);
});

test("stack startup fails closed unless A6 custody files pass metadata checks", async () => {
  const unit = await readFile(new URL("systemd/antler-zulip-stack.service", root), "utf8");
  const check = await readFile(new URL("scripts/check-secrets.sh", root), "utf8");
  assert.match(unit, /ExecStartPre=\/usr\/local\/libexec\/antler-zulip-check-secrets/);
  assert.match(unit, /ExecStart=\/usr\/local\/libexec\/antler-zulip-start/);
  assert.match(check, /\/etc\/antlerforge\/secrets\/zulip-antlerforge/);
  assert.match(check, /stat -c '%U:%G'/);
  assert.match(check, /stat -c '%a'/);
  assert.match(check, /smtp_password/);
  assert.doesNotMatch(unit, /Environment=.*PASSWORD/);
});

test("Compose mounts one named file secret per credential", async () => {
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  for (const name of ["postgres_password", "memcached_password", "rabbitmq_password", "redis_password", "secret_key", "smtp_password"]) {
    assert.match(compose, new RegExp(`file: /etc/antlerforge/secrets/zulip-antlerforge/${name}`));
  }
  assert.doesNotMatch(compose, /environment:\s+ZULIP__|op:\/\/|1Password/i);
});

test("internal provisioning is silent, root-only and does not manufacture SMTP authority", async () => {
  const provision = await readFile(new URL("scripts/provision-secrets.sh", root), "utf8");
  assert.match(provision, /install -d -o root -g root -m 0700/);
  assert.match(provision, /install -o root -g root -m 0600/);
  assert.match(provision, /openssl rand -base64 48/);
  assert.doesNotMatch(provision, /smtp_password/);
  assert.doesNotMatch(provision, /echo.*\$|cat.*target/);
});

test("owner-facing names do not describe AntlerForge Zulip as temporary", async () => {
  const files = ["README.md", "G0-CLIENT-TEST.md", "OWNER-ACTIONS.md", "CLOUDFLARE-ACCESS-SPEC.md"];
  const text = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(text, /\btrial\b/i);
  assert.match(text, /AntlerForge Zulip/);
});
