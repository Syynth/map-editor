# XState v5: topology, availability, and testing

Research for [#4](https://github.com/Syynth/map-editor/issues/4), under the map
[#2](https://github.com/Syynth/map-editor/issues/2). Feeds the root-actor command-dispatch prototype
([#8](https://github.com/Syynth/map-editor/issues/8)) and the actor-topology decision.

**Date:** 2026-09-11. **Primary version under test:** `xstate@5.32.6` (published 2026-08-25).

Claims are tagged by how they were established:

- **[measured]** — run locally against a clean install of the stated version (Node 26.8.1, Apple
  Silicon; React 19.2.0 + jsdom for the React figures).
- **[source]** — read out of the shipped `dist/` of that exact published version, or the linked file
  in `statelyai/xstate`.
- **[docs]** / **[npm]** — an official Stately docs page or npm registry metadata.
- **NOT VERIFIED** — could not be settled. Left as a gap rather than guessed at.

---

## Summary

1. **A root actor with dynamically spawned children works**, but addressing has one sharp edge:
   `sendTo('<string-id>', …)` **throws** when the child is gone, and the throw kills the *sending*
   actor — `status: 'error'`, transition rolled back, every later event ignored. Address children by
   `ActorRef`, never by bare id, wherever a child's lifetime is dynamic.
2. **`snapshot.can(event)` is reliable for deeply nested and parallel machines.** It runs the real
   transition-selection algorithm and evaluates guards. Six limits matter here, two of them
   load-bearing for the dispatch design: a **wildcard `'*'` transition makes it return `true` for
   every event**, and it **does not consult child actors**.
3. **Model-based testing has moved twice and `@xstate/test` is formally deprecated on npm.** The
   live home is `xstate/graph`, a subpath of core since **xstate 5.20.0**. Adopt it selectively, not
   as a testing strategy; plain Vitest driving `createActor` is the idiom.
4. **Keep the document store in a machine-factory closure — not in `context`, and not in `input`.**
   Measured: a 1M-cell store in context costs **~70 ms and 11.5 MB** per snapshot serialisation; a
   factory closure costs **0.009 ms / 86 chars**. `input` is *not* a safe alternative — it rides on
   the `xstate.init` event and reaches the inspector anyway.
5. **Inspection is effectively free when detached and ruinous when attached.** Core dispatch is
   ~2.7 µs/event; `@statelyai/inspect` costs **4× to 3,177× that**, scaling linearly with context
   size. **Critically: `filter` and `sanitizeContext` do not save you the serialisation cost** —
   the snapshot is stringified *before* either runs. That invalidates the obvious mitigation.
6. **`@xstate/react@6.1.0` re-render behaviour is better than the docs imply.** No-op sends cost
   zero renders because the snapshot reference is preserved. `createActorContext` has only three
   members — there is no `.useActor()`.
7. **XState v6 is in active alpha** (`6.0.0-alpha.53`, published 2026-09-11). It restructures the
   inspection protocol. See [§7](#7-the-v6-question) — the finding most likely to change the plan.

---

## 1. Root actor with dynamically spawned and stopped children

### 1.1 The two spawn APIs

```ts
// A. spawnChild(...) — a plain action. The child exists; no ref lands in context.
on: {
  'panel.open': {
    actions: spawnChild('panel', { id: 'outliner', systemId: 'panel:outliner', input: { … } }),
  },
}

// B. spawn(...) from inside assign — stores the ActorRef in context.
on: {
  'panel.open': {
    actions: assign({
      panels: ({ context, spawn, event }) => ({
        ...context.panels,
        [event.name]: spawn('panel', { id: event.name, input: { name: event.name } }),
      }),
    }),
  },
}
```

[docs: Spawn](https://stately.ai/docs/spawn) calls `spawnChild` the "preferred method for most use
cases". Options on both: `id`, `input`, `systemId`, `syncSnapshot`.

The docs carry the cleanup warning verbatim — *"make sure you remove the ActorRef from context to
prevent memory leaks when the spawned actor is no longer needed"* and *"Stopping a child actor does
not remove it from context"* — prescribing `[stopChild('id'), assign({ ref: undefined })]`.
**[measured]** confirms: after `stopChild('outliner')`, `snapshot.children` no longer lists it but
`context.panels.outliner` still holds a ref whose `getSnapshot().status` is `'stopped'`.

### 1.2 Three ways to address a child, and which to use

| Handle | Source | When the child is gone |
|---|---|---|
| `snapshot.children[id]` | the machine's own snapshot | `undefined` — safe to test |
| `system.get(systemId)` | `actor.system` | `undefined` — safe to test **[measured]** |
| bare string id in `sendTo('id', …)` | the `id` option | **throws, killing the sender** |

**[measured]** `system.get('panel:outliner')` returns the *same object identity* as
`snapshot.children.outliner`; after the child stops it returns `undefined`.

The dangerous one is the third. **[source]** `resolveSendTo` in `dist/log-3beea04f.cjs.js` (5.32.6):

```js
targetActorRef = extra.deferredActorIds?.includes(resolvedTarget)
  ? resolvedTarget
  : snapshot.children[resolvedTarget];
if (!targetActorRef) {
  throw new Error(`Unable to send event to actor '${resolvedTarget}' from machine '${snapshot.machine.id}'.`);
}
```

That throw happens during **action resolution** — before any action in the transition executes.
**[measured]**, one run:

```
n after successful PING_BY_ID: 100
errors captured: [ "Unable to send event to actor 'k' from machine 'hostA'." ]
actor status after the error: error
n after failing PING_BY_ID (did the assign in the same batch commit?): 100   <- no, rolled back
n after BUMP on the errored actor: 100                                       <- dead
```

One stale id does three bad things at once: the whole transition is rolled back (an `assign` in the
same `actions` array never commits), the actor moves to `status: 'error'`, and **every subsequent
event is ignored**. With no `error` observer attached it resurfaces as an unhandled throw on a later
macrotask — **[source]** `reportUnhandledError` is `setTimeout(() => { throw err; })`, commented
in-source as *"This function makes sure that unhandled errors are thrown in a separate macrotask."*
During this research that behaviour cost real debugging time: the first failing run killed the Node
process from a `setTimeout` several sections *after* the actual fault.

**The safe dispatch pattern** resolves the ref first and skips when absent:

```ts
on: {
  'panel.ping': {
    actions: enqueueActions(({ enqueue, event, self }) => {
      const ref = self.getSnapshot().children[event.name];
      if (ref) enqueue.sendTo(ref, { type: 'PING' });
      // else: the panel is closed; dropping the command is correct
    }),
  },
}
```

**[measured]** this leaves the parent `active` where the id form left it `error`. `sendTo(ref, …)` is
likewise safe: **[source]** `Actor._send` early-returns when `_processingStatus === Stopped`, so a
send to a dead ref is a silent no-op.

`craftgen` uses the id-in-context variant of this at scale — storing `parent: { id }` rather than a
ref and resolving on demand with `sendTo(({ context, system }) => system.get(context.parent.id))`
([input-socket.ts](https://github.com/craftgen/craftgen)). Same principle: never hand a bare string
to `sendTo`.

### 1.3 Duplicate ids behave differently from duplicate `systemId`s

**[measured]**

- Two spawns with the same `id` and **no** `systemId`: no error, one entry in `children`, actor stays
  `active`. Silent.
- Two spawns with the same `systemId`: `Error: Actor with system ID 'panel.a' already exists.` and
  the parent goes to `status: 'error'`.

Panels keyed by a stable name that can be reopened must release the `systemId` (stop the previous
holder) before reusing it, or the root dies.

### 1.4 What happens to in-flight events when a child stops

Three questions, three answers.

**(a) Events queued before the stop signal: processed.** **[measured]** with
`actions: [sendTo('k', WORK 1), sendTo('k', WORK 2), stopChild('k')]` the child logged `WORK 1` then
`WORK 2` and only then disappeared. Stop is itself an event — **[source]** `Actor._stop()` does
`this.mailbox.enqueue({ type: XSTATE_STOP })` — so the mailbox is FIFO and earlier sends win.

**(b) Anything still in the mailbox when the stop is processed: dropped.** **[source]**
`_stopProcedure()`:

```js
// Cancel all delayed events
this.system.scheduler.cancelAll(this);
// TODO: mailbox.reset
this.mailbox.clear();
```

**(c) Events sent after the stop:** silently dropped if addressed by ref, fatal if by id (§1.2).

Related lifecycle facts, all **[measured]**:

- **Delayed events (`after`, `raise({delay})`) are cancelled on stop.** A child with `after: { 10: … }`
  stopped at t=0 never fired.
- **`fromPromise` receives an `AbortSignal`, and it *is* aborted on stop.** The promise still settles
  in JS (nothing cancels a bare `setTimeout`) but `onDone` never fires and the `abort` listener ran.
  Use the signal for real cancellation — relevant to worker meshing, file load, glTF export.
- **`fromCallback` cleanup functions do run on stop.**
- **`childRef.stop()` throws `A non-root actor cannot be stopped directly.`** — **[source]**
  `Actor.stop()` guards on `this._parent`. Stop children via `stopChild`, or by stopping the root.

### 1.5 Exit actions do **not** run when an actor is stopped

The most surprising lifecycle fact, and easy to build cleanup on by mistake. **[measured]** neither a
state-level `exit` nor a root-level `exit` ran when the actor was stopped — via `stopChild` on a
child, or `actor.stop()` on the root.

**[source]** the reason is explicit in `macrostep`:

```js
// Handle stop event
if (event.type === XSTATE_STOP) {
  nextSnapshot = cloneMachineSnapshot(stopChildren(nextSnapshot, event, actorScope), {
    status: 'stopped'
  });
  addMicrostep([nextSnapshot, []], event, []);
  return { snapshot: nextSnapshot, microsteps };
}
```

`xstate.stop` short-circuits before transition selection. Only children are stopped and the status is
set; no exit set is ever computed.

Reported as
[statelyai/xstate#4630](https://github.com/statelyai/xstate/issues/4630) — **closed**, labelled
*"working as designed"* and *"has workaround"*. A top-level `exit` *does* run when the machine
reaches a top-level final state; that is a different code path. See also
[discussion #4801, "xstate v5: a 'before stop' action?"](https://github.com/statelyai/xstate/discussions/4801).

**Implication for the editor:** cleanup that must happen when a tool or panel actor goes away —
releasing the store write handle, flushing a half-finished stroke, disposing three.js resources —
cannot live in `exit`. It needs (i) an explicit `'tool.teardown'` command sent before `stopChild`,
(ii) a `fromCallback` child whose disposer does the work, or (iii) driving the actor into a final
state rather than stopping it.

### 1.6 The root does not notify when a child transitions

**[measured]**, and fundamental for both React and any availability cache:

```
a child transitioning entirely on its own
root notifications from a direct child send: 0
```

A parent's subscribers are **not** notified when a child's snapshot changes. `syncSnapshot: true` on
`spawn`/`invoke` exists to forward child snapshot changes to the parent as events (likec4 uses it for
its hotkey and overlay actors); its exact semantics were **NOT VERIFIED** here. Otherwise, anything
that needs to react to a child must subscribe to that child ref directly.

### 1.7 Cost of churning children

**[measured]** 3600 spawn+stop cycles took 33.2 ms — **9.2 µs per open/close pair**. Spawning a
panel or tool actor per interaction is not a performance concern. (With the Stately inspector
attached this changes completely — see §5.3.)

### 1.8 What real v5 apps actually do

Five substantial open-source v5 apps were examined, and they use **five different topologies**.
There is no canonical answer, and the ecosystem's own reference material is weak: the xstate
monorepo's 49 `examples/` directories contain **zero** uses of `spawnChild`, the v5 `todomvc-react`
no longer spawns a machine per todo (the v4 one did), and the only `awesome-xstate` list was last
touched 2023-01-02 and is entirely pre-v5.

- **[likec4/likec4](https://github.com/likec4/likec4)** — architecture diagram editor on React Flow,
  5.6k stars, `xstate 5.32.6` / `@xstate/react 6.1.0`, pushed daily. **The closest analogue to this
  project and the best living reference.** Root machine plus six statically-named children declared
  through a local `defineActors({ hotkey, overlays, search, mediaPrint, editor, navigationPanel })`
  helper, addressed by `systemId`. The dynamic-spawn pattern lives in `overlays/overlaysActor.ts`:
  an overlay *stack* where each entry is spawned with a generated id from a `seq` counter, and
  context holds **descriptors (`{ id, type, subject }`), not refs**. Notably they do **not** use
  `createActorContext` — they hand-rolled `createSafeContextForActor<…>()`, and their
  `defineActors` helper carries the doc comment that it exists "to minimize type inference issues
  with XState ActorSystem". That is a real signal that v5 actor-system typing hurts at scale.
- **[KittyCAD/modeling-app](https://github.com/KittyCAD/modeling-app)** (Zoo Design Studio) —
  production 3D CAD, `xstate ^5.32.5`, 141 machine files, one of them 7,892 lines. **Deliberately
  not an actor system:** zero `spawnChild`, zero `systemId`. Each subsystem is its own root actor in
  a bespoke DI container, bridged to UI with preact signals. Cross-machine addressing is a sibling
  `ActorRef` stored in context.
- **[craftgen/craftgen](https://github.com/craftgen/craftgen)** — node-graph AI workflow builder.
  The only true three-level actor *system* found (editor → node → socket → value), addressed via
  `system.get(id)` at ~20 sites. `xstate 5.14.0`, last push 2025-02-27 — read it for patterns, not
  as current practice.
- **[sanity-io/sanity](https://github.com/sanity-io/sanity)** — `xstate ^5.32.6`. Cleanest small
  `spawn` + `systemId` example; child machine *logic* is injected via `input`, making the parent
  trivially testable.
- **[shapeshift/web](https://github.com/shapeshift/web)** — nine independent `createActorContext`
  roots, one per UI flow. No shared system.

**Stately has no maintained official v5 application template.** `sky-starter-app` pins `xstate 5.2.1`
and was last touched 2024-07-29; `statelyai/agent` is already on `6.0.0-alpha.48`; and Stately's own
canvas app [`statelyai/sketch`](https://github.com/statelyai/sketch) uses **no state machine for app
state at all** — one `createStore` from `@xstate/store` holds the whole graph.

---

## 2. `snapshot.can(event)`

### 2.1 What it actually does

**[source]** `dist/raise-c90786ef.development.esm.js` (5.32.6), verbatim:

```js
const machineSnapshotCan = function can(event) {
  if (!this.machine) {
    console.warn(`state.can(...) used outside of a machine-created State object; this will always return false.`);
  }
  const transitionData = this.machine.getTransitionData(this, event);
  return !!transitionData?.length &&
  // Check that at least one transition is not forbidden
  transitionData.some(t => t.target !== undefined || t.actions.length);
};
```

`getTransitionData` is the real selection algorithm, not an approximation:

```js
getTransitionData(snapshot, event) {
  return transitionNode(this.root, snapshot.value, snapshot, event) || [];
}
```

`transitionNode` dispatches to `transitionAtomicNode` / `transitionCompoundNode` /
`transitionParallelNode`, recursing to the deepest leaf first, bubbling to ancestors when no inner
transition matches, and unioning across parallel regions. Guards are evaluated in `StateNode.next`
against `snapshot.context`.

### 2.2 It is reliable for deep nesting and parallel states

**[measured]** on a parallel root with a four-level-deep `tool.terrain.sculpt.idle` region:

```
value {"tool":{"terrain":{"sculpt":"idle"}},"selection":"none"}
can terrain.raise (depth 4):             true
can terrain.end (wrong leaf):            false
can sel.set (other parallel region):     true
can tool.paint (ancestor-level):         true
can unknown:                             false
```

Depth is not a problem. Neither are parallel regions nor ancestor-level handlers.

### 2.3 The six limits

**(1) Wildcard transitions poison it.** **[measured]** — a root with `on: { '*': { actions: … } }`
returns `can() === true` for *every* event type, including `{ type: 'nonsense' }`. A root actor that
routes unknown commands through `'*'` cannot also be asked "is this command available?".
**Either the root enumerates its commands explicitly, or availability comes from somewhere other
than `can()` on the root.** These two are mutually exclusive, and this is the sharpest constraint on
the dispatch prototype.

**(2) It does not consult children.** **[measured]** a parent invoking a child that handles
`child.do` reports `parent.can({type:'child.do'}) === false` while
`snapshot.children.kid.getSnapshot().can({type:'child.do'}) === true`. Availability across a topology
has to be an explicit walk. **[measured]** that walk is cheap: a root + 2 children × 8 commands costs
**6.8 µs**; a 200-command sweep on a single snapshot costs **0.184 ms**.

But a naive union over-reports. **[measured]** in `playing` mode the root would no longer route
`terrain.beginStroke`, yet the still-alive terrain child reports `can() === true`. A correct answer
has to model *routing*, not just "some live actor would accept this".

**(3) Guards that read state outside the machine.** The ticket's question, and the answer is:
`can()` reads external state correctly but the result is **not reactive**. **[measured]**:

```
can DELETE (external=false):                                 false
can DELETE on the SAME snapshot object after external flip:  true
snapshot identity changed?                                   false
subscriber notifications from external change:               0
```

The snapshot is not frozen with respect to guards — `can()` re-runs the guard closure every call, so
it sees the current world. But nothing tells React the answer changed: the snapshot identity is
unchanged and no subscriber fires. A toolbar whose enabled state depends on a guard reading
`store.selection` will silently go stale.

Two workable answers, both of which the topology ticket has to choose between:

- **Mirror the decision bit into machine context.** `hasSelection: boolean`, kept in sync by a
  command; the guard reads context; every change produces a new snapshot and a re-render. Cheap (a
  boolean, not the document) and keeps `can()` honest.
- **Recompute availability on the document revision as well as the snapshot.** The store already has
  a revision counter; an availability hook subscribes to both. Keeps guards free to read the store,
  but makes availability a derived value rather than a machine fact.

**(4) A throwing guard makes `can()` throw.** **[measured]** `can() THREW: Unable to evaluate guard in
transition for event 'X' in state node '(machine).a'`. **[source]** `StateNode.next` wraps guard
evaluation in `try/catch` and rethrows with context. A guard reading a store handle that is
`undefined` during startup crashes the render that asked for availability rather than returning
`false`. Availability sweeps must be defensive.

**(5) It ignores `status`.** **[measured]** a machine with a root-level `on: { GLOBAL: … }` reports
`can({type:'GLOBAL'}) === true` after `actor.stop()` (status `'stopped'`) *and* after reaching a
top-level final state (status `'done'`). The implementation never looks at `status`. Gate on
`snapshot.status === 'active'` yourself.

**(6) Edge-case transition configs.** **[measured]**:

| Config | `can()` |
|---|---|
| `EVT: undefined` (explicit forbidden) | `false` |
| `EVT: {}` (no target, no actions) | `false` |
| `EVT: { actions: fn }` (internal, action-only) | `true` |
| `EVT: { target: 'b', guard: () => false }` | `false` |
| `EVT: { target: 'a' }` (self-transition) | `true` |

**Guards run as side effects of `can()`.** **[measured]** three `can()` calls evaluated the guard
three times. Guards must stay pure and cheap; a 200-command sweep runs every matching guard once.

---

## 3. Testing

### 3.1 `@xstate/test` is deprecated; MBT has moved twice

**[npm]**, checked 2026-09-11:

| Package | Latest | Published | Status |
|---|---|---|---|
| `@xstate/test` | **0.5.1** | **2022-01-27** | npm `deprecated`: *"Please use @xstate/graph instead."* peer `xstate ^4.29.0` |
| `@xstate/test` | `1.0.0-beta.5` | 2024-01-11 | never promoted; the only v5-aware artifact |
| `@xstate/graph` | `3.0.4` | 2025-05-31 | **also legacy**, no npm deprecation flag, frozen |
| `xstate/graph` | ships with `xstate` | since **5.20.0** (2025-06-19) | **the live home** |

`packages/xstate-test/` and `packages/xstate-graph/` both return **404** on the repo's main branch.
[PR #5287](https://github.com/statelyai/xstate/pull/5287) (merged 2025-06-08) moved the graph and
model-based-testing utilities into core, released as xstate **5.20.0**. [docs: Graph](https://stately.ai/docs/graph)
says plainly: *"Import from `xstate/graph` instead of the deprecated `@xstate/graph` package."*

**[measured]** exports from `xstate@5.32.6`'s `xstate/graph` subpath:

```
TestModel, createTestModel, getShortestPaths, getSimplePaths, getPathsFromEvents,
getAdjacencyMap, adjacencyMapToArray, getStateNodes, joinPaths, serializeSnapshot,
toDirectedGraph, createShortestPathsGen, createSimplePathsGen
```

`TestPath` is `{ state, steps, weight, description, test(params) }`, where `description` is
auto-generated and makes a good test name, e.g.
`Reaches state "active"({"count":2}): xstate.init → toggle → inc → inc → toggle → toggle`.
Traversal options: `events`, `filterEvents`, `limit`, `fromState`, `toState`, `stopWhen`,
`serializeState`, `serializeEvent`, `input`. `filterEvents` is **core-only** (added in 5.30.0,
[PR #5493](https://github.com/statelyai/xstate/pull/5493)) and absent from `@xstate/graph@3.0.4`.

**Two documentation bugs found**, worth knowing before trusting the page:
[docs: Graph](https://stately.ai/docs/graph) documents `import { deduplicatePaths } from 'xstate/graph'`
but **[measured]** `typeof deduplicatePaths === 'undefined'` — the module exists in the bundle's
sourcemap but is not re-exported. And [docs: xstate-test](https://stately.ai/docs/xstate-test) still
says the utilities live in `@xstate/graph`, contradicting the `graph` page.

### 3.2 Is model-based testing worth adopting in 2026? — selectively, no

**Maintenance is fine; the branding churn is the problem.** `statelyai/xstate` is active (30.1k stars,
last commit to main 2026-08-25, alphas shipping weekly), MBT now rides core's release cadence, and
the old "is `@xstate/test` abandoned?" risk is genuinely gone. But the utilities have moved home
**three times** (`@xstate/test` → `@xstate/graph` → `xstate/graph`), the docs lag reality, and one
documented export does not exist.

**A real footgun, hit during this research:** an unguarded `assign` that grows context makes the state
space infinite and traversal OOMs — the first attempt killed a Vitest worker with SIGABRT before the
counter was bounded. Always pass `limit`, `stopWhen` or `filterEvents`, and keep traversed context
finite. Nothing in the docs warns about this.

**Verdict for this project: do not adopt it as a testing strategy.** The payoff — exhaustive path
coverage of a state machine — is weakest exactly where this project's risk lives (three.js rendering,
store mutation correctness, pointer gesture feel) and strongest where risk is already low (whether a
declared transition fires). Two narrow uses are worth keeping in view:

- **Enumerating every command a machine declares**, which the command layer wants anyway.
  `StateNode.events` (**[source]** a memoised recursive walk of `ownEvents` over all descendants)
  may be enough on its own, without `xstate/graph`.
- **E2E coverage of a genuinely finite UI flow** — a save dialog, an export wizard — where
  `path.test({ events, states })` drives Playwright.

### 3.3 What a plain Vitest test looks like

The idiom needs nothing beyond `xstate` and `vitest`.
[docs: Testing](https://stately.ai/docs/testing) uses Arrange/Act/Assert with `createActor`.

```ts
import { createActor } from 'xstate';
import { expect, test, vi } from 'vitest';

test('a stroke compacts patches per address', () => {
  const applyPatch = vi.fn();
  const actor = createActor(
    strokeMachine.provide({ actions: { applyPatch } }),   // stub actions
  );
  const errors: unknown[] = [];
  actor.subscribe({ error: (e) => errors.push(e) });      // ALWAYS do this
  actor.start();

  actor.send({ type: 'stroke.begin', at: [0, 0] });
  actor.send({ type: 'stroke.move',  at: [1, 0] });
  actor.send({ type: 'stroke.end' });

  expect(actor.getSnapshot().status).toBe('active');       // catch silent death
  expect(actor.getSnapshot().value).toBe('idle');
  expect(actor.getSnapshot().context.patches.size).toBe(2);
  expect(errors).toEqual([]);
  actor.stop();
});
```

The non-obvious parts:

- **Always attach an `error` observer.** **[source]** `Actor._reportError` calls
  `reportUnhandledError` (a `setTimeout` rethrow) when there are no observers and no parent. Without
  one, a machine error surfaces as an unhandled rejection *in a later test*, or crashes the runner
  with a stack pointing nowhere useful.
- **Assert `status` after sends.** An errored actor stops processing but `send()` does not throw;
  assertions on `value` then silently assert the pre-error state.
- **`machine.provide({ actions, actors, guards, delays })`** injects spies and stubs children.
  `setup({ actors })` declares them; `provide` overrides per test. The spy call shape is
  `(actionArgs, params)` — e.g. `expect(notify).toHaveBeenCalledWith(expect.anything(), { message: 'Active!' })`.

**The snapshot surface** — **[measured]** own keys of a live machine snapshot:

```
_nodes, can, children, context, error, getMeta, hasTag, historyValue,
machine, matches, output, status, tags, toJSON, value
```

`status` is `'active' | 'done' | 'error' | 'stopped'`. `tags` is a `Set`. `output` is populated only
when `status === 'done'`, and only from the **machine root**'s `output`, not a final state's.
`getMeta()` returns `{ 'machineId.stateKey': meta }`. `waitFor(actor, pred, { timeout })` and
`toPromise(actor)` are exported from `xstate` for async cases.

### 3.4 Asserting on actions: `snapshot.actions` is gone

**Confirmed removed in xstate 5.0.0.** [PR #4059](https://github.com/statelyai/xstate/pull/4059):
*"Removed `State['actions']`. Actions are considered to be a side-effect of a transition, things that
happen in the moment and are not meant to be persisted beyond that."* **[measured]**
`'actions' in snapshot === false` at runtime, and `@ts-expect-error` on `snapshot.actions`
typechecks — the property is genuinely off the type.

Three replacements, all verified:

1. **`provide` with a spy** — the docs' own recommendation, and the default choice.
2. **`emit()` + `actor.on()`** — added in **xstate 5.9.0** (2024-03-01),
   [PR #4746](https://github.com/statelyai/xstate/pull/4746): *"The new `emit(…)` action creator
   emits events that can be received by listeners. Actors are now event emitters."* Wildcard
   `actor.on('*', …)` added in **5.13.1** ([PR #4905](https://github.com/statelyai/xstate/pull/4905)).
   `actor.on()` returns `{ unsubscribe }`. [docs: Event emitter](https://stately.ai/docs/event-emitter).
   This is the right mechanism for anything the app genuinely needs to observe (a committed edit, a
   completed export) — not just tests.
3. **`createActor(logic, { inspect })`** — `@xstate.action` inspection events carry
   `{ type, params }`. **[measured]** they fire for named actions (with resolved params) and for
   inline functions as `{ type: '(anonymous)' }`; builtins like `assign` do **not** appear. Note
   `@xstate.action` is emitted but **not documented** — do not rely on it as stable public API.

### 3.5 Timers and children in tests

- **`SimulatedClock`** is exported from `xstate`: `createActor(m, { clock })` + `clock.increment(ms)`.
  API: `now()`, `setTimeout`, `clearTimeout`, `start(speed)`, `increment(ms)`, `set(ms)`.
  **[measured]** working; **[docs]** coverage is a stub —
  [docs: Delayed transitions](https://stately.ai/docs/delayed-transitions) has a `## Testing` heading
  whose entire body is the bullet "Simulated clock".
- **`vi.useFakeTimers()` also works** with the default clock, because the default resolves the global
  lazily: **[source]** `clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) }`.
- **Live children** are reachable as `actor.getSnapshot().children.kid.send(...)` / `.getSnapshot()`.
- **Gotcha flagged by the docs:** states entered *and* left via `always` within one macrostep are
  never observable to subscribers. Use `@xstate.microstep` inspection, or `after: { 0: … }`.

---

## 4. Keeping the document store out of machine context

### 4.1 The measurement that settles it

**[measured]**, one 1024×1024 `Int32Array` store, `JSON.stringify(snapshot.toJSON())`:

| Where the store lives | Serialised size | Time |
|---|---|---|
| `context: { store }` | 11,471,920 chars | **69.7 ms** |
| `input: { store }` → `context.storeRef` | 11,471,923 chars | **75.5 ms** |
| machine-factory closure | **86 chars** | **0.009 ms** |

Per-event, with a serialising inspector attached:

| | per event |
|---|---|
| big context, no inspector | 0.003 ms |
| big context, noop inspector | 0.002 ms |
| big context, inspector that stringifies the snapshot | **55.3 ms** |

A 60 fps frame budget is 16.7 ms. A store in context plus any serialising inspector is **3.3× over
budget on serialisation alone, for one event**. The constraint written into `docs/stack.md` — "XState's
inspector would try to serialise the whole map every transition" — is correct, and now has a number.

### 4.2 `input` is **not** a safe alternative to a closure

This is the finding most likely to be got wrong. [docs: Input](https://stately.ai/docs/input) says
input *"is not stored separately"* and *"persists only through the context it initializes"*, which
reads as though passing a store via `input` and not putting it in context would keep it invisible.
It does not, because of the sentence just above: *"If input is provided to the
`createActor(logic, { input })` function, it will be included in the `xstate.init` event."*

**[source]** `Actor.start()`:

```js
const initEvent = createInitEvent(this.options.input);
this.system._sendInspectionEvent({
  type: '@xstate.event',
  sourceRef: this._parent,
  actorRef: this,
  event: initEvent
});
```

**[measured]** with the machine's `context` builder deliberately ignoring `input`:

```
first @xstate.event: xstate.init
does it carry the store? true
JSON of that init event: {"type":"xstate.init","input":{"store":{"cells":{…},"tag":"THE-WHOLE-DOCUMENT"}}}
snapshot context: {"n":0}
```

So `input` leaks the store to the inspector **once per actor start**, even with clean context. For a
root actor started once that is a one-off ~70 ms stall and a multi-megabyte `postMessage` —
survivable, not free. For an actor spawned per tool activation or per panel it recurs.

### 4.3 The idiomatic v5 answer: machine factory closure

```ts
// core/store.ts
export function createDocumentStore(): { reader: ReadonlyMapDoc; writer: DocumentWriter } { … }

// editor/machine.ts — the writer never appears in context, input, or any event payload
export function createEditorMachine(writer: DocumentWriter) {
  return setup({
    types: {} as { context: EditorContext; events: EditorEvent },
    actions: {
      applyPatch: (_, params: { addr: number; value: number }) => {
        writer.set(params.addr, params.value);   // closed over, invisible to XState
      },
    },
  }).createMachine({
    context: { /* only small, serialisable, control-flow state */ },
    /* … */
  });
}

// app bootstrap
const { reader, writer } = createDocumentStore();
const editor = createActor(createEditorMachine(writer), { systemId: 'editor' });
```

**[measured]** the store is mutated correctly and appears in no inspection event:

```
every inspection event, stringified:
  {"t":"@xstate.actor"} | {"t":"@xstate.event","ev":"xstate.init"} |
  {"t":"@xstate.snapshot","ev":"xstate.init","ctx":{"n":0}} | {"t":"@xstate.event","ev":"T"} |
  {"t":"@xstate.action"} | {"t":"@xstate.microstep","ev":"T","ctx":{"n":1}} |
  {"t":"@xstate.snapshot","ev":"T","ctx":{"n":1}}
store mutated: true
```

Trade-offs, stated honestly:

- **Against:** the machine is no longer a static value, so it cannot be serialised or sent to the
  Stately editor as a definition without being instantiated. `setup()`'s `actions` keys still
  enumerate fine, so the *shape* stays inspectable; the closure hides only the store.
- **Against:** it interacts badly with persistence. `actor.getPersistedSnapshot()` +
  `createActor(logic, { snapshot })` restores context, but a factory closure cannot be rebuilt from a
  serialised snapshot alone — the app must reconstruct the machine with a live writer before
  rehydrating. This matters for autosave and crash recovery and was **NOT VERIFIED** in detail here.
- **For:** it is the only option that keeps the store out of `context` *and* out of `xstate.init`.
- **For:** it matches the "one write path" constraint in `docs/stack.md` exactly — only the module
  that constructs the machine holds `writer`.

**Safe to put in context: `ActorRef`s.** **[measured]** one serialises as
`{"xstate$$type":1,"id":"k2"}` — 30 characters. **[source]** `Actor.toJSON()` returns exactly
`{ xstate$$type: $$ACTOR_TYPE, id: this.id }`. Holding child refs in context costs nothing.

**What real apps do.** Two verified strategies, and honest counter-evidence:

- **modeling-app** puts long-lived **manager objects** in context — `kclManager`,
  `engineCommandManager`, `rustContext`, `wasmInstance` — while the CAD geometry itself lives in
  Rust/WASM behind those handles and is never serialised. Context holds only `currentTool`,
  `selection`, `sketchDetails`, `mouseState`. This is the closest match to the shape proposed here.
- **craftgen** puts only **ids** in context and resolves refs via `system.get`.
- **Counter-evidence:** likec4 is *hybrid* — its `Context extends Input` includes `xystore: XYStoreApi`
  (a handle to the xyflow Zustand store, so the live graph lives outside) but it *also* keeps
  `context.xyedges` and `context.view` in context. `timeline-studio` puts its entire project —
  `tracks[]`, `clips[]`, history — straight in context. Neither of those apps runs a 60 fps brush.
- **Nobody uses WeakMaps** for this.

**The escape hatch if the store ever must live in context** (it should not): `@statelyai/inspect`
has a `sanitizeContext` option — **but see §5.3, it does not save the serialisation cost.**

---

## 5. Inspection and devtools

### 5.1 The core API is effectively zero-cost when unused

`createActor(logic, { inspect })` takes an observer or a function
([docs: Inspection](https://stately.ai/docs/inspection)).

**[source]** `createSystem` in 5.32.6:

```js
const sendInspectionEvent = event => {
  if (!inspectionObservers.size) {
    return;
  }
  const resolvedInspectionEvent = { ...event, rootId: rootActor.sessionId };
  inspectionObservers.forEach(observer => observer.next?.(resolvedInspectionEvent));
};
```

Short-circuits on an empty observer set. **It is not literally zero**: all seven call sites build
their object-literal argument eagerly, so you pay ~3 small allocations + 3 calls + 3 `Set.size`
checks per `send()`. **[measured]** that is inside the noise — no-inspector 2.7 µs/event vs
noop-inspector 2.4 µs/event over 3600 events. You do not need to conditionally construct the actor.

**[source]** one non-obvious constraint: `inspect` is honoured **only on the root actor** —

```js
if (inspect && !parent) {
  // Always inspect at the system-level
  this.system.inspect(toObserver(inspect));
}
```

Passing `inspect` when spawning a child is silently ignored.

### 5.2 What is emitted, and how often

**[measured]** per `actor.send(...)`: **three** inspection events (`@xstate.event`,
`@xstate.microstep`, `@xstate.snapshot`), plus `@xstate.actor` once at start and one
`@xstate.action` per *executed* action (`assign` is a builtin resolved during the microstep and does
**not** produce one).

**[measured]** the exact keys:

| Event | Keys |
|---|---|
| `@xstate.actor` | `type, actorRef, rootId` |
| `@xstate.event` | `type, sourceRef, actorRef, event, rootId` |
| `@xstate.snapshot` | `type, actorRef, event, snapshot, rootId` |
| `@xstate.microstep` | `type, actorRef, event, snapshot, _transitions, rootId` |
| `@xstate.action` | `type, actorRef, action: { type, params }` |

Two corrections to the obvious reading of the type definitions:

- **`@xstate.transition` is declared in the v5 `InspectionEvent` union but never emitted.**
  **[source]** grepping the whole `xstate@5.32.6` `dist/` for `"@xstate.transition"` matches only
  `declarations/src/inspection.d.ts` — no JS bundle contains it. Dead type surface in v5 (it becomes
  the central event in v6 — §7).
- **`@xstate.action` is real but undocumented** — [docs: Inspection](https://stately.ai/docs/inspection)
  lists only four types.

`@xstate.microstep` is worth knowing about: the docs note that *"subscribers to an actor only receive
the final snapshot after all transitions"*, so intermediate states entered by `always` transitions
are invisible to `subscribe` and visible only to inspection.

### 5.3 `@statelyai/inspect` — the cost, and why the obvious mitigation fails

**[npm]** `@statelyai/inspect@0.7.2`, published 2026-06-14, peer `xstate ^5.5.1`. Dependencies
include `fast-safe-stringify`, `safe-stable-stringify`, `superjson`, `partysocket` and `ws` — it is a
serialisation-and-transport package.

**[source]** default options in 0.7.2. Four of these are **not on**
[the docs page](https://stately.ai/docs/inspector), which lists only `filter`, `serialize`,
`autoStart`, `url`, `iframe`:

```js
const defaultInspectorOptions = {
  filter: () => true,
  serialize: (event) => event,
  autoStart: true,
  maxDeferredEvents: 200,
  serializationDepthLimit: 10,
  sanitizeEvent: (event) => event,
  sanitizeContext: (context) => context
};
```

**The path for one inspection event**, reading `dist/index.mjs` top to bottom:

1. **`inspect.next(event)` defers via `idleCallback`** (`requestIdleCallback || requestAnimationFrame`,
   falling back to `setTimeout(cb, 0)`). Work is off the send path, but **one callback is scheduled
   per inspection event**, each closing over the full snapshot. At a sustained 60 fps stroke,
   `requestIdleCallback` is exactly what gets starved — the queue grows while holding snapshots alive.
2. **`convertXStateEvent()` deep-serialises.** For `@xstate.snapshot`:
   `snapshot: JSON.parse(safeStringify$1(inspectionEvent.snapshot, safeReplacer) ?? "null")`, where
   `safeStringify$1 = safeStableStringify.configure({ maximumDepth: depthLimit })` — that is
   **`safe-stable-stringify`, which sorts object keys**, over the entire snapshot including context,
   then a full `JSON.parse` back. `createSafeStringify(depthLimit)` is rebuilt **freshly on every
   event** rather than hoisted. For `@xstate.actor` it stringifies the whole `actorRef.logic.config`
   — the entire machine definition.
3. **`sendAdapter()`** applies `filter` → `sanitizeContext`/`sanitizeEvent` → `serialize` → `adapter.send`.
4. **`BrowserAdapter.send()`** applies `filter` **again** and `serialize` **again** — a second full
   round-trip through a *different* library:
   `JSON.parse(safeStringify(e, void 0, 2, { depthLimit, edgesLimit: depthLimit }))` — that is
   `fast-safe-stringify` **with two-space pretty-printing**. Then
   `targetWindow.postMessage(serializedEvent, "*")`, a third deep copy via structured clone,
   cross-window, per event.
5. **Unconditional retention:** `this.deferredEvents.push(event)` runs *even when connected*, capped
   at `maxDeferredEvents` (200). Two hundred full snapshots are held live at all times.

**The critical gotcha: `filter` and `sanitizeContext` do NOT save you the serialisation.**
`convertXStateEvent()` runs inside `inspect.next`, **before** `sendAdapter()` — and `filter` /
`sanitize*` live inside `sendAdapter`. The expensive pass over your context has already happened by
the time your filter says "skip this".

**[measured]** (Node 26, no-op adapter so transport costs nothing), context = a 4096-element array:

| Configuration | µs/event |
|---|---|
| no `inspect` option | **3.7** |
| `inspect: () => {}` (raw observer) | **2.0** |
| `createInspector(noopAdapter)` | 307.9 |
| …+ `filter: () => false` | **308.7** ← saves nothing |
| …+ `sanitizeContext: () => ({})` | **300.1** ← saves nothing |
| …+ custom JSON `serialize` | 393.9 |

**It scales linearly with context size** **[measured]**:

| context array length | no inspect | inspector | ratio |
|---|---|---|---|
| 0 | 7.2 µs | 25.4 µs | 4× |
| 1,024 | 4.9 | 86.6 | 18× |
| 4,096 | 1.7 | 296.1 | 176× |
| 16,384 | 4.3 | 1,340 | 310× |
| **65,536** | 1.9 | **5,952** | **3,177×** |

A 256×256 heightfield in context costs **~6 ms of main-thread CPU per event** with the inspector
attached — over a third of a frame, for one event per frame. **[measured]** spawning is charged
separately, proportional to the *child machine's config size*: 500 spawn+stop cycles went from
43 µs → 117 µs (2-state child) and 24 µs → 212 µs (200-state child).

**Documented perf warning: none.** Neither [docs: Inspector](https://stately.ai/docs/inspector) nor
[docs: Inspection](https://stately.ai/docs/inspection) contains one. Related issues:

- [statelyai/inspect#42](https://github.com/statelyai/inspect/issues/42) — inspector and parent window
  freeze serialising an HTML element (closed; origin of `serializationDepthLimit`).
- [statelyai/inspect#29](https://github.com/statelyai/inspect/issues/29) — "Possible memory leak
  within createBrowserInspector", *"memory of the Chrome tab keeps growing, reaching to couple of
  gigabytes"* (closed). Consistent with the unconditional `deferredEvents.push`.
- [statelyai/xstate#5114](https://github.com/statelyai/xstate/issues/5114) — non-JSON-serialisable
  values interfere with inspector operation (open).
- v4-era, same code path: [#2332](https://github.com/statelyai/xstate/issues/2332) —
  *"`fast-safe-stringify`'s runtime is somewhat linear to the complexity of a state chart"* — and
  [#2048](https://github.com/statelyai/xstate/issues/2048) "XState Inspector can be slow".

Searching `statelyai/inspect` for `slow OR performance OR lag OR freeze` returns **zero open
performance issues**. This cost is not on anyone's radar.

**Recommended posture for this app:**

1. **Never ship `createBrowserInspector().inspect` on the stroke path.** `filter` provably does not
   help. Either the inspector is off, or the hot actor is not the one being inspected.
2. **Gate it at build time.** likec4 does exactly this:
   `export const inspector = { inspect: import.meta.env.DEV ? createBrowserInspector().inspect : () => {} }`
   — and, tellingly, in `DiagramActorProvider.tsx` the line that would use it reads
   `// ...inspector,`, **commented out**. A maintained 5.6k-star canvas app on the newest xstate
   keeps the Stately inspector off even in dev.
3. **If you want hot-path visibility, pass your own observer** — **[measured]** ~2 µs/event — and
   sample or throttle it yourself. A 30-line dev overlay that renders `snapshot.value` and the last
   twenty event types would cost nothing and answer most debugging questions.
4. **Keep the store out of context regardless** (§4). That is what actually makes inspection viable
   at all, since `filter` cannot.

### 5.4 Other devtools

- **`@xstate/inspect`** (the v4-era package): latest `0.8.0`, **last published 2023-03-02**, peer
  `xstate ^4.37.0`. **[npm]** `npm view @xstate/inspect deprecated` returns empty — it is *not*
  formally deprecated, merely abandoned. Do not use it with v5. (Related open bug:
  [#4827](https://github.com/statelyai/xstate/issues/4827) "@xstate/inspect has 4x peer dependency".)
- **Stately Sky:** `createSkyInspector()` still ships in 0.7.2 and hardcodes a
  `*.partykit.dev` host. **NOT VERIFIED** whether Sky is discontinued — no sunset announcement found,
  but `statelyai/sky-starter-app` is untouched since 2024-07-29.
- **Browser extension: none official.** The only v5-capable Chrome extension is community-built
  ("XState DevTools" by *mjbeswick*, **40 users**). Treat as unadopted.
- **VS Code extension and CLI: v4 only.** [docs: Developer tools](https://stately.ai/docs/developer-tools)
  states plainly: *"The XState developer tools currently only work for XState version 4."*

---

## 6. `@xstate/react`

**[npm]**, checked 2026-09-11: `@xstate/react@6.1.0`, published **2026-02-26**. Peers:

```json
{ "react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0", "xstate": "^5.28.0" }
```

React 19 is supported (added in `@xstate/react@5.0.0`,
[PR #5109](https://github.com/statelyai/xstate/pull/5109)); the project's `react@^18.3.1` is in range.
Major versions of `xstate` and `@xstate/react` are deliberately not aligned. A `7.0.0-alpha.2` exists
tracking `xstate@6`. The only change in 6.1.0:
*"`useActor` and `useSelector` now throw when the actor reaches an error state, allowing errors to be
caught by React error boundaries"* ([PR #5470](https://github.com/statelyai/xstate/pull/5470)) —
which, given §1.2, is a meaningful safety net: a root actor killed by a bad `sendTo` will surface as
a React error boundary rather than a silently frozen UI.

### 6.1 The hooks

- **`useActor(logic, options?)`** — **the v4→v5 flip is real**: in v4 it took an *actor ref*; in v5 it
  takes *logic* and creates the actor. Breaking change in `@xstate/react@4.0.0`
  ([PR #4006](https://github.com/statelyai/xstate/pull/4006)). The library actively guards against
  the old shape — **[source]**
  [`useActor.ts` L28-37](https://github.com/statelyai/xstate/blob/main/packages/xstate-react/src/useActor.ts#L28-L37):

  ```ts
  if (isDevelopment && !!logic && 'send' in logic && typeof logic.send === 'function') {
    throw new Error(
      `useActor() expects actor logic (e.g. a machine), but received an ActorRef. Use the useSelector(actorRef, ...) hook instead to read the ActorRef's snapshot.`
    );
  }
  ```

  Returns `[SnapshotFrom<TLogic>, Actor<TLogic>['send'], Actor<TLogic>]`.
- **`useActorRef(logic, options?, observerOrListener?)`** — returns the started actor and **never
  subscribes**, so the host component never re-renders. **[measured]** 0 re-renders across 8 events.
  The third argument exists in the typings but is undocumented.
- **`useSelector(actorRef, selector, compare?)`** — **three parameters, not four.** **[source]**
  [`useSelector.ts`](https://github.com/statelyai/xstate/blob/main/packages/xstate-react/src/useSelector.ts):
  `function defaultCompare<T>(a: T, b: T) { return a === b; }` — the default is **strict `===`**.
  `shallowEqual` is exported for object/array selectors. ⚠️ The docs headline it as
  `useSelector(actorRef, selector, compare?, getSnapshot?)`; **the `getSnapshot` fourth argument is
  stale** — removed in 4.0.0 ([PR #3148](https://github.com/statelyai/xstate/pull/3148)) and absent
  from the 6.1.0 typings.
- **`useMachine`** — alive, an alias, **not** deprecated. It was deprecated during the v5 betas then
  un-deprecated in `4.0.0-beta.10` ([PR #4240](https://github.com/statelyai/xstate/pull/4240)).
  Current source is `/** @alias useActor */` + `return useActor(machine, options)`, narrowed to
  `AnyStateMachine`. Use either; `useActor` is the general one.

### 6.2 `createActorContext` has only three members

**[measured]** `Object.keys(createActorContext(m))` → `['Provider', 'useActorRef', 'useSelector']`.
**There is no `.useActor()`** — removed in 4.0.0
([PR #4006](https://github.com/statelyai/xstate/pull/4006)): *"`useActor` has been removed from the
created actor context, you should be able to replace its usage with `MyCtx.useSelector` and
`MyCtx.useActorRef`."* The `Provider` takes `logic` and `options` props and **throws** on the legacy
`machine` prop.

```tsx
import { createActorContext } from '@xstate/react';

const EditorContext = createActorContext(editorMachine);

function App() {
  return (
    <EditorContext.Provider options={{ input: { … } }}>
      <Toolbar />
    </EditorContext.Provider>
  );
}

const selectBrushSize = (s) => s.context.brushSize;   // define selectors outside the component

function Toolbar() {
  const brushSize = EditorContext.useSelector(selectBrushSize);
  const actorRef = EditorContext.useActorRef();       // stable, never re-renders
  return <Slider value={brushSize} onChange={(v) => actorRef.send({ type: 'brush.setSize', v })} />;
}
```

To swap implementations per subtree: `<EditorContext.Provider logic={editorMachine.provide({ actions: { … } })}>`.

Note that likec4 — the closest real analogue to this project — **does not** use `createActorContext`,
having hand-rolled `createSafeContextForActor<…>()` instead (§1.8).

### 6.3 Re-render behaviour

**Implementation:** `useSyncExternalStore`. **[source]** `useActor` uses
`useSyncExternalStore(subscribe, getSnapshot, getSnapshot)` from `use-sync-external-store/shim`
([`useActor.ts` L56-60](https://github.com/statelyai/xstate/blob/main/packages/xstate-react/src/useActor.ts#L56-L60));
`useSelector` uses `useSyncExternalStoreWithSelector(…, selector, compare)`
([`useSelector.ts` L47-53](https://github.com/statelyai/xstate/blob/main/packages/xstate-react/src/useSelector.ts#L47-L53)).

**The answer is not "every transition" — it is "every transition that produces a new snapshot
object."** Two facts compose:

1. The actor notifies subscribers on **every** `send()`, unconditionally — **[source]** `_process`
   has no bail-out and `update` loops `observers`. **[measured]** exactly 1 notification per `send()`,
   including for an unknown event type.
2. But `microstep` returns the **identical snapshot reference** when nothing structural happened —
   **[source]** [`stateUtils.ts` L1021-1023](https://github.com/statelyai/xstate/blob/main/packages/core/src/stateUtils.ts#L1021-L1023):
   `if (!transitions.length) { return [currentSnapshot, actions]; }` — and `Object.is` equality makes
   `useSyncExternalStore` bail out.

**[measured]** render counts (React 19.2.0 + jsdom), one `send` per row:

| event | `useActor` | `useSelector(s => s.value)` | `useSelector(s => s.context.obj)` (default `===`) | same, `shallowEqual` | `useActorRef` host |
|---|---|---|---|---|---|
| unhandled event type | **0** | 0 | 0 | 0 | 0 |
| internal self-transition, no actions | **0** | 0 | 0 | 0 | 0 |
| internal self-transition, plain fn action | **0** | 0 | 0 | 0 | 0 |
| external self-transition (`reenter: true`) | **0** | 0 | 0 | 0 | 0 |
| `assign` writing an **identical** value | **1** | 0 | 0 | 0 | 0 |
| `assign` of a new object with equal fields | **1** | 0 | **1** | **0** | 0 |
| `assign` changing context | **1** | 0 | 0 | 0 | 0 |
| real state change | **1** | **1** | 0 | 0 | 0 |

Takeaways:

- `useActor` / `useMachine` re-render on **any** snapshot-object change — including a context change
  the component does not read, and including `assign({ frozen: 1 })` writing a value already equal.
  `assign` always clones the snapshot; there is no value-equality check. **This is the hook that
  makes "changing brush size re-renders every panel" happen.**
- No-op sends cost **zero** renders because the snapshot reference is preserved. Better than the docs
  imply.
- `useSelector` bails out exactly when `compare(prev, next)` is true. Object/array selectors need
  `shallowEqual` or a custom compare.
- `useActorRef` hosts never re-render at all.

### 6.4 Guidance on high-frequency scenarios

Thin. There is **no** dedicated performance page in the v5 docs (all 130 `content/docs/*.mdx` files
were enumerated). The only guidance is two sentences on
[docs: @xstate/react](https://stately.ai/docs/xstate-react):

> "The `useActorRef(...)` hook is useful when you want fine-grained control, e.g. to add logging, or
> minimize re-renders. In contrast to `useActor(...)` that would flush each update from the machine to
> the React component, `useActorRef(...)` instead returns a static reference (to just the machine
> actor) which will not rerender when its state changes."

plus a `### Shallow comparison` section recommending `shallowEqual`. Anything richer in search results
(e.g. `useInterpret`) is v4-era and does not apply. **NOT VERIFIED:** any official v5 guidance beyond
these.

One lever worth knowing, not in the React docs: **`actor.select(selector, equalityFn = Object.is)`**,
added in **xstate 5.29.0** ([PR #5299](https://github.com/statelyai/xstate/pull/5299)) — returns a
`Readable` with `.subscribe()` (emits only on change) and `.get()`. **[measured]** 0 emissions for a
context write that did not change the selected value, 1 for one that did. This is the right tool for
driving the three.js viewport from actor state **without touching React's render loop at all** —
which is exactly the seam `docs/stack.md` already draws between control flow and per-frame telemetry.

---

## 7. The v6 question

**[npm]**, checked 2026-09-11:

| Tag | Version | Published |
|---|---|---|
| `xstate@latest` | **5.32.6** | 2026-08-25 |
| `xstate@alpha` | **6.0.0-alpha.53** | **2026-09-11** (the day of this research) |
| `@xstate/react@latest` | 6.1.0 | 2026-02-26 |
| `@xstate/react@alpha` | 7.0.0-alpha.2 | 2026-09-03 (peer `xstate ^6.0.0-alpha.52`) |

v6 development lives on the repo's **`next` branch** (verified by fetching
`packages/core/src/inspection.ts` at both refs). Stately's docs site already has a versioned path,
`https://stately.ai/docs/xstate/v6/...`, including "How XState runs your machine" and an FAQ.

**v6 restructures inspection substantially.** **[source]**, `inspection.ts` on `next`:

```ts
export type InspectionEvent =
  | ActorInspectionEvent        // '@xstate.actor'      { parentRef, id, src, snapshot }
  | TransitionInspectionEvent   // '@xstate.transition' { eventType, event, sourceRef, targetRef,
                                //                        snapshot, microsteps, actions, sent }
  | DeadLetterInspectionEvent;  // '@xstate.deadletter' { sourceRef, event, reason, issues?, error? }
```

The source comment calls `@xstate.transition` "a superset of the v5
`@xstate.event`/`@xstate.snapshot`/`@xstate.action`/`@xstate.microstep` events", and **[measured]**
v6 emits exactly **one** event per `send()` where v5 emits three-plus. The v6 system also lazily
allocates its observer set and exposes `_hasInspectionObservers()`. `@statelyai/inspect@0.7.2` peers
on `xstate ^5.5.1`, so **there is no inspector for v6 yet** (NOT VERIFIED whether one is planned).
Also noted: v6 drops top-level `assign` from the root export.

The `@xstate.deadletter` event is directly interesting for the dispatch design — a first-class
notification that an event reached no handler is exactly what a command router wants, and v5 has no
equivalent.

**This contradicts nothing in the map, but it is a decision the map does not currently contain.**
`docs/stack.md` says "XState — actors all the way up" without pinning a major. Adopting v5 now while
v6 alphas ship weekly means a migration is on the horizon. **NOT VERIFIED:** the full v6 breaking-change
list, whether `setup` / `spawnChild` / `can` survive unchanged, or any release timeline. The alpha's
changelog was not read and should be before the topology decision is locked.

The conservative reading: **build on 5.32.6**, keep the machine surface small and
factory-constructed (§4 argues for that on other grounds anyway), and treat the v6 migration as a
scheduled cost rather than a surprise.

---

## 8. What this means for the two downstream decisions

### For the root-actor command dispatch prototype (#8)

1. **Do not route with a wildcard `'*'` transition** if `can()` is also the availability oracle —
   §2.3(1). They are mutually exclusive, and this is the first thing the prototype should settle.
2. **Never address children by string id** in a dispatch path — §1.2. Resolve
   `self.getSnapshot().children[id]` inside `enqueueActions` and drop the command when absent. The
   failure mode is not a dropped event; it is a dead root actor.
3. **Availability is a walk, not a call.** Root's `can()` ∪ each live child's `can()`, gated on
   `status === 'active'`, minus whatever the root would not actually route. **[measured]** 6.8 µs for
   a small topology, 0.184 ms for a 200-command sweep — cheap enough per render.
4. **Subscribe per actor, not to the root** — §1.6. The root does not notify on child transitions.
   `useSelector` on the specific child ref, or `actor.select()` (§6.4) outside React.
5. **Decide where guards read from.** Guards reading the store work but are not reactive (§2.3(3)).
   Either mirror decision bits into context or recompute availability on the store's revision.
6. **Consider `emit()` for command outcomes** (§3.4) — it is the v5-native way for a command to
   report "this happened" to the app without that fact entering context.

### For the actor topology decision

1. **Cleanup cannot live in `exit`** — §1.5. Whatever owns the store write handle, a three.js
   resource, or an unfinished stroke needs an explicit teardown command or a `fromCallback` disposer.
   This is a topology constraint, not a style note.
2. **`systemId` is a scarce, collision-fatal namespace** — §1.3. Reusable panel identities need a
   release protocol, or should use plain `id` + `snapshot.children` lookup. likec4's overlay stack
   (descriptors in context, generated ids from a counter) is a working precedent.
3. **The machine that touches the store must be factory-constructed** — §4.3. This decides which
   module holds `writer`, so it is structural.
4. **In-flight semantics are safe in the common case** — §1.4. Events queued before a stop are
   processed; delayed events and promise actors are cancelled. Every unsafe case is an addressing
   mistake, not a race.
5. **`useActor` at the top of the tree is the re-render problem** — §6.3. The `docs/stack.md` item
   "changing brush size stops re-rendering every panel" is solved by `useActorRef` + `useSelector`,
   not by adopting XState per se.
6. **Expect actor-system typing to fight you at scale** — §1.8. The one comparable app in the wild
   wrote a helper specifically "to minimize type inference issues with XState ActorSystem". Budget
   for that.

---

## 9. Gaps and things not verified

- **What XState v6 actually changes** beyond inspection. Not read. Should be, before the topology
  decision is locked (§7).
- **`syncSnapshot`** on `spawn` / `invoke` — present in the option list and used by likec4; behaviour
  not exercised here.
- **Persistence and rehydration** (`actor.getPersistedSnapshot()`, `createActor(logic, { snapshot })`).
  Intersects with §4.3 — a factory closure cannot be rehydrated from a serialised snapshot alone —
  and will matter for autosave and crash recovery.
- **Whether Stately Sky is discontinued.** No sunset announcement found; supporting repos are stale.
- **Whether `sanity-io/sanity` or `shapeshift/web` use `createActorContext` or dynamic spawning
  beyond the files examined.**
- **GitHub code search caveat:** `gh search code '"xstate": "^5" path:package.json'` returns a 422
  parse error, and code search indexes default branches only and truncates. A missing hit is weak
  evidence, so the survey in §1.8 is a floor, not a census.

---

## Appendix: reproducing the measurements

Figures came from standalone Node scripts and a Vitest suite run against clean installs of
`xstate@5.32.6`, `@xstate/react@6.1.0` and `@statelyai/inspect@0.7.2` (Node 26.8.1, Apple Silicon;
React 19.2.0 + jsdom for §6.3). The scripts were throwaway and are not checked in; every shape they
exercised is described inline above and each is a dozen lines.

Timings are single-run and not statistically rigorous. They are order-of-magnitude evidence —
2.7 µs versus 55 ms is the kind of gap being asserted — not benchmarks. The one figure worth
re-measuring against real data before acting on it is the linear-scaling table in §5.3, since the
editor's actual context size is not yet known.
