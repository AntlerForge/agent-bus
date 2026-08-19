# AMB User-Level Requirements

Status: authoritative  
Owner: Tony  
Date: 2026-08-19

## Purpose

AMB is Tony's lightweight, semi-manual agent messaging board. It removes the
need for Tony to copy and paste information between agent conversations. An
ordinary use is one agent leaving another agent the path to its context file.

AMB and Agent Bus are different things with different purposes:

- AMB is a passive name-and-mailbox board. Agents read it when Tony asks them
  to, or when their own workflow chooses to check it.
- Agent Bus is governed coordination machinery for transport, bridges,
  delegated work, typed intent, execution authority, runs and receipts.
- They may share private A6 plumbing, but they must not share registries,
  inboxes, lifecycle state or user-visible semantics.

## Requirements

| ID | Requirement |
|---|---|
| UR-AMB-001 | A standalone skill named `amb` is discovered whenever Tony begins a chat message with `amb`, in every supported harness. |
| UR-AMB-002 | `amb status` returns an in-chat table containing only AMB-registered names and their plain-English roles. |
| UR-AMB-003 | `amb add <name>` registers the current agent as that AMB identity; `--role` records what it does. |
| UR-AMB-004 | `amb message <name> <text>` leaves a passive AMB note from the current agent to the named registered AMB identity. |
| UR-AMB-005 | `amb read` reads only the current agent's unread AMB notes, shows their full text and marks the displayed notes read. `--all` includes older read notes. |
| UR-AMB-006 | The sender identity is the agent Tony is sitting with, not Tony. It is the return address for a later AMB reply. |
| UR-AMB-007 | `amb who <name>` shows only AMB identity information. `amb retire <name>` retires only the AMB registration. |
| UR-AMB-008 | No AMB command reads or mutates Agent Bus agents, messages, threads, heartbeats, queues, assignments, runs, reviews, receipts or execution authority. |
| UR-AMB-009 | An AMB note never starts a provider turn or grants authority. It waits until the receiving agent reads it. |
| UR-AMB-010 | Agent Bus traffic never appears in `amb read`, and AMB traffic never appears in an Agent Bus inbox. |
| UR-AMB-011 | The same AMB registry and mailbox are reached from Mac and A6 through the existing private localhost route. Failure is explicit and never interpreted as prose. |
| UR-AMB-012 | The adapter is deterministic and version-controlled. The skill is canonical in the KV skills catalog and deployed to every active harness path. |
| UR-AMB-013 | Registration or refresh can record a current/recent-work description, topic tags, a human-usable chat/session locator, and trustworthy last-active/update timestamps without discarding older registrations. |
| UR-AMB-014 | `amb find <query>` deterministically ranks active AMB identities using only AMB recent-work metadata and recency, and shows each matching name and chat locator. |
| UR-AMB-015 | Empty and equally ranked top results are explicit; neither the adapter nor the skill silently guesses which identity Tony meant. |
| UR-AMB-016 | During substantive work, a registered agent refreshes its AMB recent-work and locator metadata when those facts are known and safe to publish on Tony's private board. |
| UR-AMB-017 | A natural-language request such as “message the agent recently working on X” resolves through AMB, asks Tony to choose if ambiguous, then leaves only a passive AMB note. |
| UR-AMB-018 | Recent-work discovery and chat locators remain AMB-only records; they never query or mirror Agent Bus agents, work, threads, runs, bridges or lifecycle state. |

## Current-agent identity

In chat, the skill executes the adapter with `AMB_AGENT` set to the current
agent's registered AMB name. This allows several agent conversations on the
same Mac to keep distinct identities. A saved identity file is only a terminal
fallback. If neither source identifies the agent, commands that need a sender
or inbox fail with the exact `amb add <name>` remedy.

Tony does not need an AMB identity. He speaks through the agent whose chat he
is using.

## Explicit non-requirements

AMB has no task lifecycle, thread workflow, automatic response, bridge,
heartbeat, queue, liveness promise, artifact upload, typed intent, execution
authority, approval, assignment, run, review, receipt, model selection or cost
tracking. Those belong to Agent Bus and the Agent Work Ledger.

## Acceptance examples

1. In the Chief of Staff chat: `amb message DadCare Dad's context is at /path/to/file`.
2. Later in the DadCare chat: `amb read` shows that note and its sender as
   `chief-of-staff`, then marks it read.
3. `amb read --all` in either chat shows only AMB notes for that AMB identity,
   never Agent Bus operational messages.
4. `amb status` contains DadCare and Chief of Staff if they registered, but it
   contains no queue, work item, heartbeat or bridge columns.
5. Agent A refreshes with “GitHub repository rationalisation” and its chat
   locator. Agent B runs `amb find github repository`, sees A and the locator,
   leaves A a note, and A later reads the full note and sender.
6. Two equally relevant recent-work registrations produce an explicit
   ambiguous result and require Tony to select a name before messaging.
