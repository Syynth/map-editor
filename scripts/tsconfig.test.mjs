import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression for the #73 follow-up review: `skipLibCheck: false` here (unlike
// every other tsconfig in the repo — see this file's own comment) put all of
// node_modules's `.d.ts` files under strict checking just to catch a broken
// import in one ambient-globals file, on the mistaken premise that
// `skipLibCheck` was the only way to do that. The actual fix is the ambient
// globals living in a non-declaration `.ts` module (`global.ts`, always
// checked regardless of `skipLibCheck`) rather than a `.d.ts` one — this test
// pins both halves so neither regresses independently: `skipLibCheck` drifting
// back to `false`, or `global.ts` drifting back to a `.d.ts` extension that
// would need it.
const dir = join(import.meta.dirname)
const config = readFileSync(join(dir, 'tsconfig.json'), 'utf8')

describe('scripts/tsconfig.json', () => {
  it('keeps skipLibCheck true, matching every other tsconfig in the repo', () => {
    expect(config).toMatch(/"skipLibCheck":\s*true/)
  })

  it('includes the ambient globals as global.ts, not global.d.ts', () => {
    expect(config).toMatch(/"include":\s*\[[^\]]*"global\.ts"[^\]]*\]/)
    expect(config).not.toMatch(/global\.d\.ts/)
  })

  it('has global.ts on disk and no leftover global.d.ts', () => {
    expect(existsSync(join(dir, 'global.ts'))).toBe(true)
    expect(existsSync(join(dir, 'global.d.ts'))).toBe(false)
  })
})
