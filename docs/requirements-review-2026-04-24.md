# Requirements Review - 2026-04-24

## Review Scope

This review compared the initial Agent Bus requirements against current adjacent work in:

- Model Context Protocol (MCP);
- Agent2Agent (A2A);
- local MCP-based agent message buses;
- multi-agent framework handoff patterns.

## Relevant Signals

MCP is the right integration layer for Claude and Codex tool access, but it is not itself a
full agent-to-agent workflow model. The MCP lifecycle and roots specifications highlight
capability negotiation, request timeouts, filesystem roots, and root-boundary validation as
important implementation concerns.

A2A separates agent-to-agent delegation from agent-to-tool access. Its model highlights
agent cards, capabilities, messages, tasks, artifacts, lifecycle states, and asynchronous
patterns such as polling, streaming, and push notification.

Existing local agent buses such as MCP Agent Mail and AgentChatBus show that the practical
coordination problems are broader than send/read/reply:

- agents need persistent or semi-persistent identities;
- messages need targeted recipients, subjects, threads, and acknowledgments;
- polling needs cursors or monotonic sequence numbers;
- operators need a way to see who is active and what is blocked;
- shared files become artifacts and need metadata;
- file collisions matter once agents edit the same codebase;
- search, audit, and recovery become valuable quickly.

## Significant Missing Requirements Found

The initial requirements were a good first shape but under-specified these adjacent needs:

1. Agent identity and capability registry.
2. Message acknowledgments separate from answers.
3. Thread or task lifecycle status.
4. Sequence/cursor support for polling and lossless resume.
5. Idempotency keys for retry-safe sends.
6. Artifact metadata and artifact version linkage.
7. Operator visibility outside either agent chat.
8. Path/root validation and secret detection.
9. Optional advisory file reservations for future multi-agent coding.
10. Audit trail for lifecycle changes and message edits.

## Updates Applied

The user requirements and implementation/test plan were updated to include:

- agent registry requirements;
- message sequence and idempotency requirements;
- acknowledgment and lifecycle requirements;
- artifact metadata requirements;
- operator visibility requirements;
- stronger reliability and security requirements;
- future advisory file reservation requirements;
- expanded implementation phases and tests.

## Sources

- MCP lifecycle: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- MCP roots: https://modelcontextprotocol.io/specification/2025-06-18/client/roots
- MCP sampling: https://modelcontextprotocol.io/specification/2025-06-18/client/sampling
- A2A overview: https://a2a-protocol.org/v0.3.0/
- A2A core concepts: https://a2a-protocol.org/v0.3.0/topics/key-concepts/
- A2A agent discovery: https://a2a-protocol.org/v0.3.0/topics/agent-discovery/
- A2A task lifecycle: https://a2a-protocol.org/v0.3.0/topics/life-of-a-task/
- MCP Agent Mail: https://www.mcpagentmail.com/
- AgentChatBus: https://github.com/Killea/AgentChatBus
- A2A MCP Server: https://github.com/GongRzhe/A2A-MCP-Server
