---
name: mistral-vibe
description: >
  Use the Mistral Vibe Code monthly allowance through Magpie on a Windows machine.
  This repo provides the mistral-vibe-acp model provider: pick
  mistral-vibe-acp/<model> as the model of any Magpie-connected agent. A
  standalone MCP task bridge (mistral-vibe__vibe_prompt and friends, from the
  external danalec/vibe-mistral-mcp repo) can also delegate whole tasks to the
  official Vibe agent. Check remaining quota with "magpie quota mistral-vibe-acp".
argument-hint: "[task to delegate | models | quota | billing]"
license: MIT
---

# Mistral Vibe through Magpie

On a Windows machine with Magpie (gateway on http://127.0.0.1:3425) and the official
Mistral Vibe CLI signed in (credential stored in the OS keyring, never pasted
into chat), two bridges put the Vibe Code monthly allowance to work:

- **Model provider** (the Magpie plugin provided by this repo):
  `mistral-vibe-acp/mistral-large-4-0` appears in Magpie's model picker. The calling agent
  keeps its own conversation and tools; inference goes through the official Vibe ACP, so
  it bills the Vibe Code allowance. Verified end to end: a streamed tool-call round trip
  returned the expected marker and moved only the `vibe_budget`.
- **MCP task bridge** (external component, not part of this repo: GitHub
  `danalec/vibe-mistral-mcp`, installed separately as a Magpie Library server
  `mistral-vibe`, stdio, local-only, assigned to specific agents):
  `mistral-vibe__vibe_prompt` runs one self-contained task in the official Vibe
  agent and returns its final answer. `vibe_start`/`vibe_poll` for background
  jobs, `vibe_options` for models/modes, `vibe_reset` to drop the session. Vibe
  works in the given `cwd` with its own file/shell tools; that bridge runs in
  `ask` mode and cancels interactive permission requests, so tasks must not need
  approval prompts.

## Typical configuration

- Official Vibe default model: `mistral-large-4-0` in `~/.vibe/config.toml`.
- Magpie exposes `mistral-large-4-0`, `zai-glm-latest` (GLM 5.3) and
  `deepseek-v4-1-flash-1017` for both `mistral-vibe-acp` and the plain `mistral`
  API provider; other aliases stay in the catalog but are hidden from the picker.
  Re-expose one with `magpie provider models mistral-vibe-acp +<model>`.
- Other agents' default models are untouched; switch one explicitly with
  `magpie <agent> mistral-vibe-acp/mistral-large-4-0`.

## Usage

- Use as a model: pick `mistral-vibe-acp/mistral-large-4-0` in Magpie for the agent.
- Delegate a task (requires the external MCP task bridge): call
  `mistral-vibe__vibe_prompt` with a complete, self-contained prompt and an absolute
  `cwd`; restate everything Vibe needs. Long tasks: `vibe_start` then `vibe_poll`.
- Quota: `magpie quota mistral-vibe-acp` (Monthly Vibe Code), or read
  `GET http://127.0.0.1:3425/v1/magpie/native/mistral/v1/billing/budget` with header
  `Authorization: Bearer magpie-<app>`; it returns both `vibe_budget` and `api_budget`.
  Amount used = `usage_percentage x initial_budget / 100`.

## Verify billing attribution

Before/after adopting any new route, snapshot both budgets, send one short real request,
then compare. Pass criterion: `vibe_budget` increases, `api_budget` unchanged.
Sanitized evidence from a real run is in `docs/` (billing-before/after.json,
model-billing.json, model-roundtrip.mjs).

## Safety and limits

- Never paste or read the Vibe credential; it lives in the OS keyring and is resolved
  inside the Vibe process only.
- The MCP bridge cancels Vibe's interactive permission requests; give Vibe tasks that
  don't need approvals, or set `mode` explicitly per call.
- The ACP model bridge supports text and function tools only (no images, structured
  output, or forced tool choice). One prompt at a time per session; the bridge serializes
  turns. Clients may rewrite tool-call ids and prefix model ids with the provider name;
  the bridge tolerates both. Turn and session timeouts re-arm on progress (a new leg, a
  tool call, a tool result, streamed text). Lost bridge state (idle-timeout reaping,
  plugin reload, host restart) no longer fails the turn with 409: the next tool result
  seeds a fresh Vibe session from the full transcript and the turn continues.
- The Vibe Code allowance resets on the 1st of each calendar month.

## Troubleshooting

- `Missing API key for mistral provider`: re-run official `vibe --setup` (or ACP
  `authenticate` with methodId browser-auth), then re-connect the provider in Magpie.
- Model id rejected: ask `vibe_options` (external MCP bridge) or re-list the catalog
  first; ids can change between sessions (e.g. mistral-medium-3.5 -> mistral-medium-latest).
- Remove the model provider: `magpie plugin rm github:awu5425/Magpie-Mistral-Vibe-ACP-Bridge`.
  Remove the MCP bridge: `magpie library mcp rm mistral-vibe`.
