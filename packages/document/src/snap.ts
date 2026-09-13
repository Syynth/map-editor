/**
 * Snapping, one convention for everything that moves (ruling of 2026-09-12,
 * "Select tool"): to the cell grid by default, to half cells, or not at all —
 * free positions are still rounded to a hundredth so a saved file stays
 * readable. A modifier held during a drag makes one drag free without
 * changing the setting.
 */

export type SnapMode = 'grid' | 'half' | 'free'

export function snapTo(value: number, snap: SnapMode): number {
  if (snap === 'free') return Math.round(value * 100) / 100
  const step = snap === 'grid' ? 1 : 0.5
  return Math.round(value / step) * step
}
