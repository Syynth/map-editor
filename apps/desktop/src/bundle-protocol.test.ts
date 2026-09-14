import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleFileFor } from './bundle-protocol'

const root = join('/', 'bundles', '42')

describe('bundleFileFor', () => {
  it('maps the origin root to index.html', () => {
    expect(bundleFileFor(root, 'app://bundle/')).toBe(join(root, 'index.html'))
  })

  it('maps an asset path under the root', () => {
    expect(bundleFileFor(root, 'app://bundle/assets/index-abc.js')).toBe(join(root, 'assets', 'index-abc.js'))
  })

  it('ignores the query and fragment', () => {
    expect(bundleFileFor(root, 'app://bundle/index.html?x=1#top')).toBe(join(root, 'index.html'))
  })

  it('decodes percent-encoded names', () => {
    expect(bundleFileFor(root, 'app://bundle/a%20b.png')).toBe(join(root, 'a b.png'))
  })

  it('refuses another scheme or host', () => {
    expect(bundleFileFor(root, 'file:///etc/passwd')).toBeNull()
    expect(bundleFileFor(root, 'app://other/index.html')).toBeNull()
  })

  it('refuses to climb out of the root', () => {
    // `URL` collapses `..` segments — literal or `%2e%2e`, which the URL
    // standard treats as the same segment — before this sees them, so those
    // land back inside the root. An encoded slash is not a segment boundary to
    // the parser, so `..%2f` survives parsing and has to be caught here.
    expect(bundleFileFor(root, 'app://bundle/../../etc/passwd')).toBe(join(root, 'etc', 'passwd'))
    expect(bundleFileFor(root, 'app://bundle/%2e%2e/%2e%2e/etc/passwd')).toBe(join(root, 'etc', 'passwd'))
    expect(bundleFileFor(root, 'app://bundle/..%2f..%2fetc%2fpasswd')).toBeNull()
    expect(bundleFileFor(root, 'app://bundle/..%5c..%5cetc')).toBeNull()
  })

  it('serves a name that only starts with two dots', () => {
    expect(bundleFileFor(root, 'app://bundle/..hidden.js')).toBe(join(root, '..hidden.js'))
  })

  it('refuses a sibling directory that shares the root as a prefix', () => {
    expect(bundleFileFor(root, 'app://bundle/..%2f420/index.html')).toBeNull()
  })

  it('refuses malformed input', () => {
    expect(bundleFileFor(root, 'not a url')).toBeNull()
    expect(bundleFileFor(root, 'app://bundle/%E0%A4%A')).toBeNull()
    expect(bundleFileFor(root, 'app://bundle/index.html%00.png')).toBeNull()
  })
})
