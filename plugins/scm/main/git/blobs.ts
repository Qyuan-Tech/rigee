import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { gitSpawn, resolveGitBinary } from './exec'

/**
 * One long-lived `git cat-file --batch` per repository.
 *
 * Measured on a large repo, 100 blobs: `git show <rev>:<path>` spawned per file takes 69 ms each;
 * the same reads through one persistent batch process take 0.77 ms each, and 0.41 ms once the
 * process is warm. Feeding Monaco's diff editor needs two blobs per file, so the difference is
 * the whole interaction budget.
 *
 * Wire protocol (git cat-file --batch):
 *   request   "<rev>:<path>\n"
 *   response  "<oid> SP <type> SP <size> LF" <size bytes> LF
 *   missing   "<request> SP missing LF"
 *
 * The payload is binary and may contain LF, so the reader is a two-state machine over bytes:
 * scan for the header's LF, then count exactly <size>+1 bytes. Splitting on newlines corrupts
 * any file that is not plain text.
 */

interface Pending {
  resolve: (value: Buffer | null) => void
  reject: (err: Error) => void
}

export class BlobReader {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf: Buffer = Buffer.alloc(0)
  private readonly queue: Pending[] = []
  /** null while awaiting a header; otherwise how many payload bytes are still to come. */
  private awaiting: number | null = null
  private disposed = false

  constructor(private readonly repoRoot: string) {}

  private async ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && !this.proc.killed) return this.proc
    const bin = await resolveGitBinary()
    const proc = gitSpawn(this.repoRoot, ['cat-file', '--batch'], bin)
    this.proc = proc
    this.buf = Buffer.alloc(0)
    this.awaiting = null

    proc.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    proc.on('exit', () => {
      this.proc = null
      // Anything still queued can never be answered by a dead process.
      for (const p of this.queue.splice(0)) p.reject(new Error('git cat-file exited'))
    })
    proc.on('error', (err) => {
      this.proc = null
      for (const p of this.queue.splice(0)) p.reject(err)
    })
    return proc
  }

  /**
   * Read a blob BY OBJECT ID.
   *
   * Only object ids are accepted, and that restriction is the whole point. A long-lived
   * `cat-file --batch` caches the index it read at startup, so a revision-relative spec goes
   * stale the moment anything stages a change — including the user typing `git add` in one of
   * this app's own terminals. Reproduced: after `git add`, the same process kept returning the
   * pre-add blob and oid for `:0:a.txt`, while a fresh process returned the new content.
   *
   * Object ids are immutable, so they are always safe to serve from a warm process. Callers
   * resolve specs to ids first (see GitService.diff).
   */
  async read(spec: string): Promise<Buffer | null> {
    if (this.disposed) throw new Error('BlobReader disposed')
    if (!/^[0-9a-f]{40}$/.test(spec) && !/^[0-9a-f]{64}$/.test(spec)) {
      throw new Error(`BlobReader.read expects an object id, got ${JSON.stringify(spec.slice(0, 40))}`)
    }
    const proc = await this.ensure()
    return new Promise<Buffer | null>((resolve, reject) => {
      this.queue.push({ resolve, reject })
      proc.stdin.write(`${spec}\n`)
    })
  }

  private consume(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])

    for (;;) {
      if (this.awaiting === null) {
        const nl = this.buf.indexOf(0x0a)
        if (nl < 0) return
        const header = this.buf.toString('latin1', 0, nl)
        this.buf = this.buf.subarray(nl + 1)

        if (header.endsWith(' missing')) {
          this.queue.shift()?.resolve(null)
          continue
        }
        const size = Number(header.slice(header.lastIndexOf(' ') + 1))
        if (!Number.isFinite(size)) {
          this.queue.shift()?.reject(new Error(`unparsable cat-file header: ${header.slice(0, 80)}`))
          continue
        }
        this.awaiting = size + 1 // payload plus the trailing LF
      }

      if (this.buf.length < this.awaiting) return
      const payload = this.buf.subarray(0, this.awaiting - 1)
      this.buf = this.buf.subarray(this.awaiting)
      this.awaiting = null
      this.queue.shift()?.resolve(Buffer.from(payload))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.queue.splice(0)) p.reject(new Error('BlobReader disposed'))
    this.proc?.stdin.end()
    this.proc?.kill()
    this.proc = null
  }
}

/**
 * git's own heuristic: a NUL byte anywhere in the first 8000 bytes means binary. Matching it
 * keeps the panel's idea of "binary" the same as the one behind `Binary files differ`.
 */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}
