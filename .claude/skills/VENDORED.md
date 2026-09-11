# Vendored skills

These skills are **not ours**. They are vendored verbatim from
[mattpocock/skills](https://github.com/mattpocock/skills), MIT licensed,
Copyright (c) 2026 Matt Pocock. The full licence is in [LICENSE](LICENSE).

- **Upstream commit:** `3cca18b368ae95cdbdebbff572ccafa662551015` (2026-09-04)
- **Vendored on:** 2026-09-11

## What is here, and why

`wayfinder` is the one we invoke; the rest are its dependencies — it calls
them through the Skill tool while resolving tickets.

| Skill | Role |
|---|---|
| `wayfinder` | Plans work too big for one session as decision tickets on the issue tracker |
| `grilling` | Conversational interrogation; wayfinder's default ticket type |
| `domain-modeling` | Paired with grilling to pin down the domain |
| `research` | Resolves research tickets (AFK, via subagent) |
| `prototype` | Resolves prototype tickets by building something cheap to react to |
| `setup-matt-pocock-skills` | Re-run to reconfigure the tracker or domain docs |

## Updating

Re-copy from upstream rather than editing in place, so local changes never
silently diverge. If we do need to diverge, fork the skill under a different
name instead of patching the vendored copy.
