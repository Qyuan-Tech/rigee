/**
 * Two-tier render scheduling, because pdf.js does not cap concurrency and we have to.
 *
 * pdf.js already slices a page's operator list at 15 ms and resumes on rAF, so ONE render is a
 * good citizen. Nothing stops six pages doing that at once, though, and six well-behaved slices
 * still add up to six times the frame budget — which is exactly what a fast scroll through a
 * thumbnail rail produces.
 *
 * So: at most `limit` renders in flight, and a low tier that only starts when the high tier is
 * completely idle. Thumbnails live in the low tier, so they can never delay the page the reader is
 * actually looking at, and a scroll that re-fills the high tier pauses them mid-rail.
 */
export type RenderJob = () => Promise<void>

export class RenderQueue {
  private active = 0
  private readonly high: RenderJob[] = []
  private readonly low: RenderJob[] = []

  constructor(private readonly limit = 2) {}

  run(job: RenderJob, low = false): void {
    ;(low ? this.low : this.high).push(job)
    this.pump()
  }

  /** Forget everything not yet started. In-flight jobs are cancelled by their own owners. */
  clear(): void {
    this.high.length = 0
    this.low.length = 0
  }

  private pump(): void {
    while (this.active < this.limit) {
      // The low tier waits for a completely quiet high tier, not merely a free slot: "lower
      // priority" that still gets a slot while a page is rendering is not lower priority.
      const job = this.high.shift() ?? (this.active === 0 ? this.low.shift() : undefined)
      if (!job) return
      this.active++
      void job()
        .catch(() => { /* every job reports its own failure; the queue only counts */ })
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
