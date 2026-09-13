/**
 * Per-frame timings for `scripts/perf.mjs`.
 *
 * The viewport's loop marks the end of each phase; this records how long each
 * one took, frame by frame, into one preallocated array — so turning the
 * profile on allocates nothing per frame, which matters when the same run is
 * measuring allocations. Past `capacity` frames it stops recording rather
 * than growing. Off (no instance) it costs the loop one null check per mark.
 *
 * GPU time comes from WebGL timer queries (`GpuTimer`), which report a frame
 * or two late: the GPU column is a distribution over the window, not aligned
 * frame for frame with the CPU phases. `gl.finish()` is no substitute — in
 * Chrome it returns once the command buffer is flushed, long before Metal is
 * done, which is how a Retina frame the GPU could not finish measured 0.6 ms.
 */

/** The loop's phases, in the order it runs them. */
export const FRAME_PHASES = ['camera', 'meshing', 'objects', 'overlays', 'render', 'report'] as const
export type FramePhase = (typeof FRAME_PHASES)[number]

export interface FrameProfileReport {
  readonly frames: number
  /** Milliseconds per frame, per phase, in frame order. */
  readonly phases: Readonly<Record<FramePhase, number[]>>
  /** The whole loop body per frame, in milliseconds. */
  readonly total: number[]
  /** Picks the pointer asked for while recording, and what they cost together. */
  readonly picks: { readonly count: number; readonly ms: number }
  /** GPU milliseconds per rendered frame, as the timer queries reported them; empty when the driver offers no timer queries. */
  readonly gpu: number[]
  readonly gpuTimed: boolean
}

const WIDTH = FRAME_PHASES.length + 1

export class FrameProfile {
  private readonly data: Float64Array
  private frames = 0
  private start = 0
  private last = 0
  private phase = 0
  private picks = 0
  private pickMs = 0
  private readonly gpuData: Float64Array
  private gpuCount = 0

  constructor(
    private readonly capacity: number,
    readonly gpuTimed: boolean,
  ) {
    this.data = new Float64Array(capacity * WIDTH)
    this.gpuData = new Float64Array(capacity)
  }

  begin(): void {
    this.start = performance.now()
    this.last = this.start
    this.phase = 0
  }

  /** The phase just finished. */
  mark(): void {
    const now = performance.now()
    if (this.frames < this.capacity && this.phase < FRAME_PHASES.length) this.data[this.frames * WIDTH + this.phase] = now - this.last
    this.phase += 1
    this.last = now
  }

  end(): void {
    if (this.frames >= this.capacity) return
    this.data[this.frames * WIDTH + FRAME_PHASES.length] = performance.now() - this.start
    this.frames += 1
  }

  pick(ms: number): void {
    this.picks += 1
    this.pickMs += ms
  }

  /** One frame's GPU time, whenever its query came back. */
  gpu(ms: number): void {
    if (this.gpuCount < this.capacity) this.gpuData[this.gpuCount++] = ms
  }

  report(): FrameProfileReport {
    const column = (index: number): number[] => {
      const out = new Array<number>(this.frames)
      for (let frame = 0; frame < this.frames; frame++) out[frame] = this.data[frame * WIDTH + index]
      return out
    }
    const phases = Object.fromEntries(FRAME_PHASES.map((name, index) => [name, column(index)])) as Record<FramePhase, number[]>
    return {
      frames: this.frames,
      phases,
      total: column(FRAME_PHASES.length),
      picks: { count: this.picks, ms: this.pickMs },
      gpu: Array.from(this.gpuData.subarray(0, this.gpuCount)),
      gpuTimed: this.gpuTimed,
    }
  }
}

/**
 * GPU time for a span of GL work, by `EXT_disjoint_timer_query_webgl2`.
 * Queries are pooled, so timing every frame allocates nothing once the pool
 * has grown to the few frames the GPU runs behind. A disjoint event (a power
 * state change, a lost context) invalidates what was pending, and those
 * results are dropped rather than recorded wrong.
 */
export class GpuTimer {
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  private readonly free: WebGLQuery[] = []
  private readonly pending: WebGLQuery[] = []
  private active: WebGLQuery | null = null

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  }

  get available(): boolean {
    return this.ext !== null
  }

  begin(): void {
    if (!this.ext || this.active) return
    const query = this.free.pop() ?? this.gl.createQuery()
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
    this.active = query
  }

  end(): void {
    if (!this.ext || !this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push(this.active)
    this.active = null
  }

  /** Hand each finished query's time to `record`, in milliseconds, oldest first. */
  poll(record: (ms: number) => void): void {
    if (!this.ext) return
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    while (this.pending.length > 0) {
      const query = this.pending[0]
      if (!(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) as boolean)) break
      this.pending.shift()
      if (!disjoint) record((this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number) / 1e6)
      this.free.push(query)
    }
  }

  dispose(): void {
    for (const query of [...this.free, ...this.pending]) this.gl.deleteQuery(query)
    if (this.active) this.gl.deleteQuery(this.active)
    this.free.length = 0
    this.pending.length = 0
    this.active = null
  }
}
