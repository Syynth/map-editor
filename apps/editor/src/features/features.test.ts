import { createDocument, SURFACE_TOP, cellIndex, createMap, paintTint, patchAddress, raise, topKey, type Patch, type SurfaceAddress } from '@map-editor/document'
import { createHost, type Host, type PointerPress } from '@map-editor/editor-host'
import { commands, evaluate, panels, tools } from '@map-editor/registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { features } from './index'

/**
 * The composition this app is: a host, the features it installs, and nothing
 * else. It lives here rather than in either package because #35 rules that a
 * feature never imports the host and the host never imports a feature — so an
 * app is the only place the two halves can be seen at once, and the test that
 * proves the seam works has to sit where the seam is assembled.
 *
 * Every assertion about behavior goes through `dispatch`, `Host.input` and
 * `reader` (#10). Setup may build documents directly — `apply` below stands in
 * for the app's own writes, which is what the mid-drag test is about — but no
 * assertion reads anything else.
 */
const TERRAIN = 'terrain'

/** Every id this file dispatches, for the enumeration test at the bottom. */
const dispatched = new Set<string>()

/**
 * Every host this file builds, so `afterEach` can stop each one. A host holds
 * a module-level install hook that only `stop()` releases (`editor-host`'s
 * `releaseFeatureHook`) and a running root actor, and the feature registry is
 * a process-wide singleton — leaving them alive would have one file's abandoned
 * hosts spawning logic for the next hot re-import, which is exactly what the
 * host's own comment says must not happen.
 */
const started: Host[] = []

function makeHost(): { host: Host; dispatch: Host['dispatch'] } {
  const host = createHost({ document: createDocument(createMap(8, 8)), features })
  started.push(host)
  const dispatch: Host['dispatch'] = (id, args) => {
    dispatched.add(id)
    return host.dispatch(id, args)
  }
  // Every stroke below is a terrain stroke; the editor opens on Select.
  host.dispatch('tools.set', { tool: 'terrain' })
  return { host, dispatch }
}

/**
 * Setup: one labelled edit, at the document actor's own event rather than
 * through a command. A test holds the ref the same way the stroke actor does —
 * there is no writer to reach for, which is the point (#13).
 */
function apply(host: Host, label: string, patches: Patch[]): void {
  host.children.document.send({ type: 'patch', label, patches })
}

let live: ReturnType<typeof makeHost>
beforeEach(() => {
  live = makeHost()
})
afterEach(() => {
  for (const host of started.splice(0)) host.stop()
})

describe('what the feature declares, before anything is running', () => {
  // #9's claim, and the reason the declaration registries are static: a
  // palette, a keybinding editor and this test can all enumerate a feature's
  // surface with no actor in existence. `features` was imported at module
  // scope; no host has been built at the point these ids were registered.
  it('is enumerable from the import alone, under the feature\'s own owner', () => {
    const ids = commands
      .all()
      .filter((command) => commands.ownerOf(command.id) === TERRAIN)
      .map((command) => command.id)
      .sort()
    expect(ids).toEqual([
      'terrain.flatten',
      'terrain.material',
      'terrain.paint.cliff',
      'terrain.paint.tint',
      'terrain.paint.top',
      'terrain.raise',
      'terrain.ramp',
      'terrain.water',
    ])
    expect(tools.get('terrain')).toMatchObject({ title: 'Terrain', icon: 'terrain' })
    // The bar panel is the tool's row of controls; the inspector ones are gated.
    expect(panels.ownerOf('terrain.bar')).toBe(TERRAIN)
    expect(panels.get('terrain.bar')).toMatchObject({ slot: 'bar' })
    expect(typeof panels.get('terrain.bar')?.component).toBe('function')
    expect(panels.get('terrain.ramp')?.slot).toBeUndefined()
    expect(panels.get('terrain.paint')?.when).toBeDefined()
  })
})

describe('the terrain commands, dispatched through the host', () => {
  it('raises what the arguments name, seen through reader', () => {
    const { host, dispatch } = live
    const index = cellIndex(host.reader.doc.size, 2, 3)
    const before = host.reader.doc.terrain.height[index]

    expect(dispatch('terrain.raise', { cells: [[2, 3]], delta: 2 })).toEqual({ ok: true })

    expect(host.reader.doc.terrain.height[index]).toBe(before + 2)
    // One labelled edit, on the undo stack the document actor owns — the
    // feature has no writer and never saw one.
    expect(host.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(host.reader.doc.terrain.height[index]).toBe(before)
  })

  it('carries the rest of the verbs, each addressing its target by data', () => {
    const { host, dispatch } = live
    const size = host.reader.doc.size

    expect(dispatch('terrain.flatten', { cells: [[1, 1]], height: 4 })).toEqual({ ok: true })
    expect(host.reader.doc.terrain.height[cellIndex(size, 1, 1)]).toBe(4)

    expect(dispatch('terrain.ramp', { cells: [[1, 1]], dir: 2 })).toEqual({ ok: true })
    expect(host.reader.doc.terrain.ramp[cellIndex(size, 1, 1)]).toBe(2)

    expect(dispatch('terrain.water', { cells: [[1, 1]], level: 3 })).toEqual({ ok: true })
    expect(host.reader.doc.terrain.water[cellIndex(size, 1, 1)]).toBe(3)

    expect(dispatch('terrain.material', { cells: [[1, 1]], material: 1 })).toEqual({ ok: true })
    expect(host.reader.doc.terrain.material[cellIndex(size, 1, 1)]).toBe(1)

    expect(dispatch('terrain.paint.top', { cells: [[1, 1]], tile: 5 })).toEqual({ ok: true })
    expect(host.reader.doc.paint.top[topKey(1, 1)]).toBe(5)

    expect(dispatch('terrain.paint.tint', { cells: [[1, 1]], tint: 0x00ff00 })).toEqual({ ok: true })
    expect(dispatch('terrain.paint.cliff', { faces: [{ x: 1, y: 1, dir: 2, level: 0 }], tile: 7 })).toEqual({ ok: true })
    expect(host.reader.undoLabel()).toBe('Paint')
  })

  it('refuses arguments the schema does not admit, before anything is sent', () => {
    const { host, dispatch } = live
    const before = host.reader.doc.terrain.height[cellIndex(host.reader.doc.size, 2, 3)]

    // A stray key, a missing one, and the shape that matters most: `undefined`
    // where a value belongs, which is not JSON and so cannot be an argument.
    expect(dispatch('terrain.raise', { cells: [[2, 3]], delta: 1, verb: 'raise' })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('terrain.raise', { cells: [[2, 3]] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('terrain.raise', { cells: [], delta: 1 })).toMatchObject({ ok: false, kind: 'invalid-args' })

    expect(host.reader.doc.terrain.height[cellIndex(host.reader.doc.size, 2, 3)]).toBe(before)
    expect(host.reader.canUndo()).toBe(false)
  })
})

describe('the tool contract, which a declaration cannot carry', () => {
  const top: SurfaceAddress = { x: 4, y: 4, kind: SURFACE_TOP, dir: 0, level: 0 }

  it('is reachable from the host by the tool\'s id, and answers with patches', () => {
    const { host, dispatch } = live
    const index = cellIndex(host.reader.doc.size, 4, 4)
    const before = host.reader.doc.terrain.height[index]
    const contract = host.toolContract('terrain')
    expect(contract).toBeDefined()

    const handler = contract?.stroke({ pick: { surface: top, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } })
    expect(handler?.label).toBe('Raise')
    // The contract reads the tool parameters live, through the deps the host
    // handed it — so a `tools.set` between the press and the tick is seen.
    expect(dispatch('tools.set', { brush: { size: 3, shape: 'square' } })).toEqual({ ok: true })
    const patches = handler?.begin({ pick: { surface: top, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } })
    expect(patches).toHaveLength(9)

    // And it applied nothing: a handler answers with patches, and the stroke
    // actor is what sends them to the document (#13).
    expect(host.reader.doc.terrain.height[index]).toBe(before)
  })

  it('declines a press that missed the terrain', () => {
    const contract = live.host.toolContract('terrain')
    expect(contract).toBeDefined()
    expect(contract?.stroke({ pick: { surface: null, point: null, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false } })).toBeUndefined()
  })

  it('is undefined for a tool nobody declared', () => {
    expect(live.host.toolContract('nonesuch')).toBeUndefined()
  })
})

// --- pointer input -------------------------------------------------------------

const NO_MODIFIERS = { shift: false, alt: false, ctrl: false }

function topAt(x: number, y: number): SurfaceAddress {
  return { kind: SURFACE_TOP, x, y, dir: -1, level: 0 }
}

function pressAt(x: number, y: number, extra: Partial<PointerPress> = {}): PointerPress {
  return { x: x * 10, y: y * 10, button: 0, modifiers: NO_MODIFIERS, pick: { surface: topAt(x, y), point: { x, z: y }, objectId: null }, ...extra }
}

/** One committed edit, so a test has terrain to work against. */
function raiseOnce(host: Host, x: number, y: number, by = 1): void {
  apply(host, 'Raise', raise(host.reader.doc, [[x, y]], by))
}

/**
 * A terrain drag, end to end, and the reason these tests live in the app
 * rather than in `editor-host`: the stroke actor now runs the CONTRACT the
 * terrain feature contributed, and the host may not import a feature (#35), so
 * the only place a press can travel the whole path — arbitration actor, stroke
 * actor, the feature's handler, the document actor — is where the two halves
 * are composed. `editor-host`'s own pointer tests keep the object tool, whose
 * handler is still the host's, plus a stub contract for the routing itself.
 */
describe('a terrain stroke, from the pointer to the document', () => {
  it('a left drag sculpts on every tick and lands as one undo entry, one patch per address', () => {
    const { host, dispatch } = live
    dispatch('tools.set', { brush: { size: 3, shape: 'square' } })
    const doc = host.reader.doc
    const before = doc.terrain.height.slice()
    const at = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]
    // What the document actor received, off the system's inspector (v6's
    // `Actor.send` is a getter and cannot be spied on). Matched by the id the
    // host spawns it under: `ActorRefLike`, which is what an inspection event
    // carries, has no typed `sessionId` to compare a child ref against.
    const received: Array<{ type: string } & Record<string, unknown>> = []
    host.actor.system.inspect((event) => {
      if (event.type === '@xstate.transition' && 'id' in event.actorRef && event.actorRef.id === 'document') received.push(event.event)
    })

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('stroke')
    expect(at(3, 3)).toBe(before[cellIndex(doc.size, 3, 3)] + 1)
    for (const [x, y] of [[4, 3], [5, 3], [4, 3], [3, 3]] as const) {
      expect(host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })).toBe('stroke')
      const seen = at(x, y)
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
      expect(at(x, y)).toBe(seen + 1)
    }
    expect(host.input.strokeOrigin()).toEqual([3, 3])
    host.input.pointerUp({ x: 30, y: 30 })
    expect(host.input.gesture()).toBe('none')
    expect(host.input.strokeOrigin()).toBeNull()

    const patches = received.flatMap((event) => (event.type === 'strokePatch' ? (event.patches as Patch[]) : []))
    const record = received.find((event) => event.type === 'endStroke')
    const unique = new Set(patches.map(patchAddress)).size
    expect(patches.length).toBeGreaterThan(unique)
    expect((record?.patches as Patch[] | undefined)?.length).toBe(unique)

    expect(host.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
  })

  it('records an app write that lands mid-drag, so one undo brings it back', () => {
    // `App`'s Delete keybinding is a `window` keydown listener: pointer
    // capture does not stop it, so `store.apply` is reachable in the middle of
    // an open stroke. Once, that write was applied and recorded by nothing —
    // the store refused it and the stroke's compaction map holds only patches
    // the stroke itself produced.
    const { host, dispatch } = live
    const doc = host.reader.doc
    const height = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]
    const before = doc.terrain.height.slice()

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('stroke')
    apply(host, 'Elsewhere', raise(doc, [[7, 7]], 1))
    expect(height(7, 7)).toBe(before[cellIndex(doc.size, 7, 7)] + 1)
    host.input.pointerUp({ x: 30, y: 30 })

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(height(3, 3)).toBe(before[cellIndex(doc.size, 3, 3)])
    expect(host.reader.undoLabel()).toBe('Elsewhere')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
  })

  it('a rect stroke commits nothing until release, then one block from the press cell to the last', () => {
    const { host, dispatch } = live
    dispatch('tools.set', { strokeShape: 'rect' })
    const doc = host.reader.doc
    const before = doc.terrain.height.slice()
    const height = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]

    expect(host.input.pointerDown(pressAt(2, 2))).toBe('stroke')
    // Nothing on the press, and nothing mid-drag: a rectangle is only known
    // once both corners are.
    expect(doc.terrain.height).toEqual(before)
    for (const [x, y] of [[3, 3], [4, 4]] as const) {
      host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
    }
    expect(doc.terrain.height).toEqual(before)
    // The preview grows from the press cell, which is what `strokeOrigin` is for.
    expect(host.input.strokeOrigin()).toEqual([2, 2])

    host.input.pointerUp({ x: 40, y: 40 })
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) expect(height(x, y)).toBe(before[cellIndex(doc.size, x, y)] + 1)
    expect(height(5, 5)).toBe(before[cellIndex(doc.size, 5, 5)])
    expect(height(1, 1)).toBe(before[cellIndex(doc.size, 1, 1)])

    // One entry for the block, not nine.
    expect(host.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
    expect(host.reader.canUndo()).toBe(false)
  })

  it('a fill stroke floods the contiguous plateau under the press and stops at the step', () => {
    const { host, dispatch } = live
    // A wall of raised cells down x = 4 bounds the flood: `fillCells` walks
    // cells of equal height, so the press at (2,2) reaches only its own side.
    for (let y = 0; y < 8; y++) raiseOnce(host, 4, y)
    dispatch('tools.set', { strokeShape: 'fill' })
    const doc = host.reader.doc
    const before = doc.terrain.height.slice()
    const height = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]

    host.input.pointerDown(pressAt(2, 2))
    host.input.pointerUp({ x: 20, y: 20 })

    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) expect(height(x, y)).toBe(before[cellIndex(doc.size, x, y)] + 1)
    expect(height(5, 5)).toBe(before[cellIndex(doc.size, 5, 5)])
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
  })

  it('the flatten verb levels a drag to the height sampled at the press', () => {
    const { host, dispatch } = live
    raiseOnce(host, 0, 0, 3)
    dispatch('tools.set', { sculptVerb: 'flatten', brush: { size: 1, shape: 'square' } })
    const doc = host.reader.doc
    const anchor = doc.terrain.height[cellIndex(doc.size, 0, 0)]

    host.input.pointerDown(pressAt(0, 0))
    for (const [x, y] of [[1, 0], [2, 0]] as const) {
      host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
      // Flattened to the press height, not to each cell's own.
      expect(doc.terrain.height[cellIndex(doc.size, x, y)]).toBe(anchor)
    }
    host.input.pointerUp({ x: 20, y: 0 })
    expect(host.reader.undoLabel()).toBe('Flatten')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height[cellIndex(doc.size, 1, 0)]).not.toBe(anchor)
  })

  it('the water verb pools at the pressed cell\'s height, and shift removes it', () => {
    const { host, dispatch } = live
    dispatch('tools.set', { sculptVerb: 'water' })
    const doc = host.reader.doc
    const level = doc.terrain.height[cellIndex(doc.size, 3, 3)]

    host.input.pointerDown(pressAt(3, 3))
    host.input.pointerUp({ x: 30, y: 30 })
    expect(doc.terrain.water[cellIndex(doc.size, 3, 3)]).toBe(level)
    expect(host.reader.undoLabel()).toBe('Carve water')

    const shift = { modifiers: { ...NO_MODIFIERS, shift: true } }
    host.input.pointerDown(pressAt(3, 3, shift))
    host.input.pointerUp({ x: 30, y: 30 })
    expect(doc.terrain.water[cellIndex(doc.size, 3, 3)]).toBeLessThan(0)
    expect(host.reader.undoLabel()).toBe('Remove water')

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.water[cellIndex(doc.size, 3, 3)]).toBe(level)
  })

  it('alt-click runs the eyedropper at the press cell, and a 6 px alt-drag orbits without it', () => {
    const { host, dispatch } = live
    dispatch('tools.set', { terrainMode: 'paint', paintVerb: 'tint' })
    apply(host, 'Tint', paintTint(host.reader.doc, [[2, 2]], 0xff0000))
    apply(host, 'Tint', paintTint(host.reader.doc, [[6, 6]], 0x00ff00))
    const alt = { modifiers: { ...NO_MODIFIERS, alt: true } }

    expect(host.input.pointerDown(pressAt(2, 2, alt))).toBe('pending')
    expect(host.input.pointerMove({ x: 21, y: 22, modifiers: alt.modifiers })).toBe('pending')
    host.input.pointerUp({ x: 21, y: 22 })
    expect(host.children.tools.getSnapshot().context.tint).toBe(0xff0000)
    // The eyedropper wrote a tool parameter, never the document.
    expect(host.reader.undoLabel()).toBe('Tint')

    expect(host.input.pointerDown(pressAt(6, 6, alt))).toBe('pending')
    expect(host.input.pointerMove({ x: 66, y: 60, modifiers: alt.modifiers })).toBe('orbit')
    host.input.pointerUp({ x: 66, y: 60 })
    expect(host.children.tools.getSnapshot().context.tint).toBe(0xff0000)
  })
})

describe('the feature\'s context key', () => {
  it('lands in the host\'s vocabulary and follows the tool parameters', () => {
    const { host, dispatch } = live
    expect(host.contextKeys()['terrain.verb']).toBe('raise')

    expect(dispatch('tools.set', { sculptVerb: 'ramp' })).toEqual({ ok: true })
    expect(host.contextKeys()['terrain.verb']).toBe('ramp')

    // The paint verb is "the verb" in paint mode: the key is the feature's
    // because what counts as a verb is the terrain tool's business.
    expect(dispatch('tools.set', { terrainMode: 'paint', paintVerb: 'tint' })).toEqual({ ok: true })
    expect(host.contextKeys()['terrain.verb']).toBe('tint')
  })

  it('is what the ramp panel\'s availability is expressed over', () => {
    const { host, dispatch } = live
    const ramp = panels.get('terrain.ramp')
    expect(ramp?.when).toBeDefined()
    expect(evaluate(ramp!.when!, host.contextKeys())).toMatchObject({ available: false, reason: expect.stringContaining('terrain.verb') as string })

    dispatch('tools.set', { sculptVerb: 'ramp' })
    expect(evaluate(ramp!.when!, host.contextKeys())).toEqual({ available: true })
  })
})

/**
 * #10: every declared command must have a test that dispatches it. Runs last
 * in the file, so `dispatched` is complete — and scoped to this feature's
 * owner, because the host's own commands have the same guard in
 * `editor-host`'s tests.
 */
describe('declared but untested', () => {
  it('has dispatched every command the feature declares', () => {
    const untested = commands
      .all()
      .filter((command) => commands.ownerOf(command.id) === TERRAIN)
      .map((command) => command.id)
      .filter((id) => !dispatched.has(id))
    expect(untested, `declared but never dispatched by a test: ${untested.join(', ')}`).toEqual([])
  })
})

/**
 * LAST IN THE FILE, and it has to be: `feature-terrain` declares at module
 * scope under a singleton owner, so revoking it revokes it for the whole
 * process — every test above would then be dispatching at commands that no
 * longer exist. Vitest isolates modules per file, so the blast radius stops at
 * this file, but the ORDER inside it is load-bearing rather than incidental.
 * The host is this block's own, built and stopped here, so nothing about the
 * disposal rides on the fixture the rest of the file shares.
 */
describe('disposing the feature', () => {
  it('takes its commands, its panels and its key with it, and stops its actor', () => {
    const { host, dispatch } = makeHost()
    const actor = host.child(TERRAIN)
    expect(actor?.getSnapshot().status).toBe('active')

    host.dispose(TERRAIN)

    expect(commands.get('terrain.raise')).toBeUndefined()
    expect(panels.get('terrain.brush')).toBeUndefined()
    expect(tools.get('terrain')).toBeUndefined()
    expect(dispatch('terrain.raise', { cells: [[2, 3]], delta: 1 })).toMatchObject({ ok: false, kind: 'unknown' })
    expect(actor?.getSnapshot().status).toBe('stopped')

    // The key is revoked with everything else: `contextKeys` no longer carries
    // it, and its owner is gone, so the host is not still deriving a value for
    // a vocabulary entry nobody can name.
    expect('terrain.verb' in host.contextKeys()).toBe(false)
    expect(host.toolContract('terrain')).toBeUndefined()
  })
})
