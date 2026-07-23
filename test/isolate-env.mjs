// Test runner preload: no test may inherit production Agent Bus routing or provider state.
for (const key of [
  "AGENT_BUS_CONTROL_PLANE_URL",
  "AGENT_BUS_WRITE_TOKEN",
  "AGENT_BUS_CODEX_SESSION_STORE",
  "AGENT_BUS_CODEX_SESSION_ID",
  "AGENT_BUS_ROOT",
]) delete process.env[key];

process.env.NODE_ENV = "test";
process.env.AGENT_BUS_ALLOW_LOCAL = "1";
