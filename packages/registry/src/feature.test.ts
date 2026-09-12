import { afterEach, describe, expect, it } from 'vitest'

import {
  commands,
  defineContextKey,
  defineFeature,
  dispose,
  onFeatureChange,
  panels,
  provideFeature,
  parsePredicate,
  type FeatureModule,
  type HotHandle,
} from './index'

/**
 * The feature half of the registry, without an actor, a host or Vite — the
 * same "enumerable before anything is running" claim the other registries
 * make. `create` is never called here: what it returns needs deps only a host
 * can supply, and nothing in this file is a host.
 *
 * The hot handle is a stub that records what Vite would have been told, so a
 * re-import can be driven by calling the disposer and then re-running what a
 * feature module does at import. #21 §4 established the ordering this
 * simulates — Vite awaits the changed module's disposer, THEN imports the new
 * module — by reading `vite/dist/client/client.mjs`; the point of the stub is
 * that the registry's half of that protocol is testable without it.
 */
function fakeHot(): HotHandle & { accepted: boolean; fire(): void } {
  let disposer: (() => void) | null = null
  return {
    accepted: false,
    accept() {
      this.accepted = true
    },
    dispose(callback) {
      disposer = callback
    },
    fire() {
      disposer?.()
    },
  }
}

/** What a feature module does at import, minus the module. */
function importFeature(id: string, hot: HotHandle, mark: string): FeatureModule<string> {
  const owner = defineFeature(id, hot)
  commands.declare(owner, { id: 'test.feature.go', title: 'Go' })
  panels.declare(owner, { id: 'test.feature.panel', title: 'Panel', component: mark })
  defineContextKey(owner, 'test.feature.ready', false)
  return provideFeature({ owner, create: mark })
}

const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases) release()
  releases.length = 0
})

function watch(): { installed: Array<FeatureModule<string>>; uninstalled: string[] } {
  const log = { installed: [] as Array<FeatureModule<string>>, uninstalled: [] as string[] }
  releases.push(
    onFeatureChange<string>({
      install: (module) => void log.installed.push(module),
      uninstall: (owner) => void log.uninstalled.push(owner),
    }),
  )
  return log
}

describe('defineFeature', () => {
  it('accepts the hot update on the feature module itself', () => {
    const hot = fakeHot()
    defineFeature('test:feature:accepts', hot)
    expect(hot.accepted).toBe(true)
    dispose('test:feature:accepts')
  })

  it('needs no hot handle: a production build has none', () => {
    expect(defineFeature('test:feature:cold')).toBe('test:feature:cold')
    dispose('test:feature:cold')
  })
})

describe('a hot re-import', () => {
  it('revokes the declarations and the keys the previous incarnation minted', () => {
    const hot = fakeHot()
    importFeature('test:feature:revoke', hot, 'first')
    expect(commands.get('test.feature.go')).toBeDefined()

    hot.fire()

    expect(commands.get('test.feature.go')).toBeUndefined()
    expect(panels.get('test.feature.panel')).toBeUndefined()
    expect(() => parsePredicate({ op: 'is', key: 'test.feature.ready', value: true })).toThrow(/unknown context key/)
  })

  it('re-mints under the same owner without throwing, and the host sees the new module', () => {
    const hot = fakeHot()
    const log = watch()
    const first = importFeature('test:feature:remint', hot, 'first')
    expect(log.installed).toEqual([first])

    // What Vite does, in its order: the changed module's disposer runs and is
    // awaited, and only then is the new module imported.
    hot.fire()
    expect(log.uninstalled).toEqual(['test:feature:remint'])

    const second = importFeature('test:feature:remint', hot, 'second')

    expect(log.installed).toEqual([first, second])
    expect(panels.get('test.feature.panel')?.component).toBe('second')
    dispose('test:feature:remint')
  })

  it('revokes before it tells the host, so nothing reaches a half-disposed feature', () => {
    const hot = fakeHot()
    const seen: Array<boolean> = []
    releases.push(
      onFeatureChange({
        install: () => undefined,
        // #21 §5: doing this the obvious way round — drain the actor, then
        // revoke — leaves the command dispatchable for the whole drain.
        uninstall: () => void seen.push(commands.get('test.feature.go') !== undefined),
      }),
    )
    importFeature('test:feature:order', hot, 'first')

    hot.fire()

    expect(seen).toEqual([false])
  })
})

describe('onFeatureChange', () => {
  it('stops telling a host that released its hook', () => {
    const hot = fakeHot()
    const log = watch()
    const release = releases.pop()
    release?.()

    importFeature('test:feature:released', hot, 'first')
    hot.fire()

    expect(log.installed).toEqual([])
    expect(log.uninstalled).toEqual([])
  })
})
