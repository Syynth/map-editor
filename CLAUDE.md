# map-editor

A desktop editor for building 3D levels in a Paper Mario / HD-2D style, where
the artist never models anything in 3D. See
[`level-editor-design-brief.md`](level-editor-design-brief.md) for the vision
and [`docs/stack.md`](docs/stack.md) for what it is built from.

## Decision log

User decisions, and the reasoning behind them, are captured in
[`docs/decision-log.md`](docs/decision-log.md) as they happen. Watch for them
during interactive work and record them there.

## How work happens here (2026-09-11, supersedes the wayfinder setup)

**Wayfinding is retired.** The map at
[#2](https://github.com/Syynth/map-editor/issues/2) is closed out — its route is clear and every
decision it made is recorded in `docs/decision-log.md` and on its tickets. Do not chart new
maps, do not create wayfinder tickets, do not invoke the wayfinder skill. It was tried and the
owner does not want it.

**Two modes, in order:**

1. **Finishing the refactor** — the actor migration (#66), emit and project references (#46),
   the tail items (#48, #56). This runs on the `autonomous-pump` skill: serial trains for
   dependent work, parallel waves for disjoint work, adversarial review on every step, `main`
   protected by the `gate` check. Config in
   [`.claude/skills/autonomous-pump/MAP-EDITOR-CONFIG.md`](.claude/skills/autonomous-pump/MAP-EDITOR-CONFIG.md).
2. **Building features** — once the refactor lands, the owner and the assistant build features
   together, directly, in conversation. No pump, no chips, no tickets-as-process. Decisions still
   go in the decision log; that is the one process that stays.

### Issue tracker

GitHub Issues via `gh`. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
The "Wayfinding operations" section there is historical.

### Domain docs

Single-context: [`CONTEXT.md`](CONTEXT.md) is the glossary. See
[`docs/agents/domain.md`](docs/agents/domain.md).

## Vendored skills

`.claude/skills/` contains skills vendored from
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT). They are not
ours — see [`.claude/skills/VENDORED.md`](.claude/skills/VENDORED.md) before
editing any of them.
