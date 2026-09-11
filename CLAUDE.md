# map-editor

A desktop editor for building 3D levels in a Paper Mario / HD-2D style, where
the artist never models anything in 3D. See
[`level-editor-design-brief.md`](level-editor-design-brief.md) for the vision
and [`docs/stack.md`](docs/stack.md) for what it is built from.

## Decision log

User decisions, and the reasoning behind them, are captured in
[`docs/decision-log.md`](docs/decision-log.md) as they happen. Watch for them
during interactive work and record them there.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven through the `gh` CLI. See
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).

## Vendored skills

`.claude/skills/` contains skills vendored from
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT). They are not
ours — see [`.claude/skills/VENDORED.md`](.claude/skills/VENDORED.md) before
editing any of them.
