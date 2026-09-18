/**
 * Incremental parser for the tmux control-mode (`tmux -C`) byte stream.
 *
 * Ported from the reference implementation that was validated against tmux 3.6a over a 22.5 MB
 * live firehose (0 anomalies) plus byte-at-a-time and every-split-point fuzzing.
 *
 * Three properties here are load-bearing and were each derived from a reproduced failure:
 *
 *  1. Prefix tests are bounded by the LINE END, never by the buffer length. `%exit` is 5 bytes
 *     and shares its `%e` prefix with `%extended-output ` (17 bytes); since `%exit` is emitted on
 *     every clean shutdown, an unguarded compare throws ERR_OUT_OF_RANGE on every normal
 *     teardown. Comparing against buf.length instead of the line end is also wrong: a short line
 *     could then prefix-match across the LF into the following line.
 *
 *  2. A guard block is closed ONLY by a line that is byte-identical to `%end `/`%error ` plus the
 *     exact `<time> <number> <flags>` triple captured from its own `%begin`. In-band command
 *     output is not escaped, so a pane whose screen contains the text `%end 1 2 3` will emit that
 *     line verbatim inside a `capture-pane` block. A loose `startsWith('%end ')` closes the block
 *     early and then feeds raw pane content — including escape sequences — into the notification
 *     dispatcher.
 *
 *  3. The decode buffer is bounded and signals overflow. Writing past a Buffer's end is a silent
 *     no-op in Node, which would corrupt pane data with no error anywhere.
 */

/** Hard cap on a single wire line; beyond this we resync at the next LF rather than buffer. */
const MAX_LINE = 1 << 20

/** Max decoded payload. Observed max is 2,730 raw bytes per %output line; 64 KiB is ample. */
const DECODE_CAP = 64 * 1024

const B_PCT = 0x25
const B_LF = 0x0a
const B_SP = 0x20
const B_BS = 0x5c
const B_COLON = 0x3a

const P_OUTPUT = Buffer.from('%output ', 'latin1')
const P_EXTOUT = Buffer.from('%extended-output ', 'latin1')
const P_BEGIN = Buffer.from('%begin ', 'latin1')
const TERM_END = Buffer.from('%end ', 'latin1')
const TERM_ERR = Buffer.from('%error ', 'latin1')
const N_PAUSE = Buffer.from('%pause ', 'latin1')
const N_CONT = Buffer.from('%continue ', 'latin1')

export interface TmuxParserSink {
  /**
   * Pane output. `bytes` is a BORROWED view into the parser's scratch buffer and is invalidated
   * by the next output line — copy it if you retain it.
   * `ageMs` is non-null only under `pause-after`, where it is free consumer-lag telemetry.
   */
  onOutput(paneId: string, bytes: Uint8Array, ageMs: number | null): void
  onNotification(name: string, args: string): void
  onBlockBegin(time: number, number: number, flags: number): void
  onBlockLine(line: string): void
  onBlockEnd(ok: boolean, time: number, number: number, flags: number): void
  onAnomaly(reason: string, sample: string): void
}

/** Decode tmux's octal escaping from buf[s,e) into `out`. Returns bytes written, or -1 if full. */
export function unescapeInto(buf: Buffer, s: number, e: number, out: Uint8Array): number {
  let o = 0
  const cap = out.length
  for (let i = s; i < e; i++) {
    if (o >= cap) return -1
    const c = buf[i]!
    if (c === B_BS && i + 3 < e) {
      const a = buf[i + 1]!
      const b = buf[i + 2]!
      const d = buf[i + 3]!
      if (isOctal(a) && isOctal(b) && isOctal(d)) {
        out[o++] = ((a - 0x30) << 6) | ((b - 0x30) << 3) | (d - 0x30)
        i += 3
        continue
      }
    }
    out[o++] = c
  }
  return o
}

function isOctal(c: number): boolean {
  return c >= 0x30 && c <= 0x37
}

interface OpenBlock {
  /** Everything after "%begin " on the opening line: "<time> <number> <flags>". */
  rest: string
  time: number
  number: number
  flags: number
}

export class TmuxStreamParser {
  private tail: Buffer | null = null
  private openBlock: OpenBlock | null = null
  /** True while discarding the remainder of an over-long line. */
  private overlong = false
  private readonly scratch = Buffer.allocUnsafe(DECODE_CAP)

  readonly stats = { lines: 0, output: 0, anomalies: 0, truncated: 0 }

  constructor(private readonly sink: TmuxParserSink) {}

  push(chunk: Buffer): void {
    let buf = chunk
    let start = 0
    if (this.tail !== null) {
      buf = Buffer.concat([this.tail, chunk])
      this.tail = null
    }
    for (;;) {
      const nl = buf.indexOf(B_LF, start)
      if (nl < 0) {
        const rem = buf.length - start
        if (rem > MAX_LINE) {
          this.overlong = true
          this.stats.truncated++
          this.sink.onAnomaly('line-too-long', buf.toString('latin1', start, start + 80))
          return
        }
        if (rem > 0) this.tail = Buffer.from(buf.subarray(start))
        return
      }
      if (this.overlong) {
        this.overlong = false
        start = nl + 1
        continue
      }
      this.line(buf, start, nl)
      start = nl + 1
    }
  }

  /** `s` inclusive, `e` exclusive and pointing AT the LF. */
  private line(buf: Buffer, s: number, e: number): void {
    this.stats.lines++

    // An open guard block swallows everything until its exact terminator.
    if (this.openBlock !== null) {
      const block = this.openBlock
      if (this.isTerminator(buf, s, e, TERM_END, block.rest)) return this.closeBlock(true)
      if (this.isTerminator(buf, s, e, TERM_ERR, block.rest)) return this.closeBlock(false)
      // %output cannot appear inside a block, but %message / %pause / %continue can. Forward the
      // flow-control ones immediately — waiting for %end would defeat the point of backpressure.
      if (buf[s] === B_PCT && (this.hasPrefix(buf, s, e, N_PAUSE) || this.hasPrefix(buf, s, e, N_CONT))) {
        return this.notification(buf, s, e)
      }
      this.sink.onBlockLine(buf.toString('utf8', s, e))
      return
    }

    // Outside a block, every legal line starts with '%'. Anything else is stray job output
    // (run-shell and friends print unframed) and must never reach the dispatcher.
    if (buf[s] !== B_PCT) {
      this.stats.anomalies++
      this.sink.onAnomaly('unframed-line', buf.toString('latin1', s, Math.min(e, s + 120)))
      return
    }

    if (this.hasPrefix(buf, s, e, P_OUTPUT)) return this.output(buf, s + P_OUTPUT.length, e, false)
    if (this.hasPrefix(buf, s, e, P_EXTOUT)) return this.output(buf, s + P_EXTOUT.length, e, true)

    if (this.hasPrefix(buf, s, e, P_BEGIN)) {
      const rest = buf.toString('latin1', s + P_BEGIN.length, e)
      const f = rest.split(' ')
      this.openBlock = { rest, time: Number(f[0]), number: Number(f[1]), flags: Number(f[2]) }
      this.sink.onBlockBegin(this.openBlock.time, this.openBlock.number, this.openBlock.flags)
      return
    }

    // A stray %end/%error with no block open is just a notification, not a terminator.
    this.notification(buf, s, e)
  }

  private isTerminator(buf: Buffer, s: number, e: number, keyword: Buffer, rest: string): boolean {
    if (e - s !== keyword.length + rest.length) return false // exact length, no slop
    if (buf.compare(keyword, 0, keyword.length, s, s + keyword.length) !== 0) return false
    return buf.toString('latin1', s + keyword.length, e) === rest
  }

  /** Length-guarded prefix test, bounded by the line end. */
  private hasPrefix(buf: Buffer, s: number, e: number, prefix: Buffer): boolean {
    if (e - s < prefix.length) return false
    return buf.compare(prefix, 0, prefix.length, s, s + prefix.length) === 0
  }

  private closeBlock(ok: boolean): void {
    const b = this.openBlock!
    this.openBlock = null
    this.sink.onBlockEnd(ok, b.time, b.number, b.flags)
  }

  private notification(buf: Buffer, s: number, e: number): void {
    let i = s + 1
    while (i < e && buf[i] !== B_SP) i++
    const name = buf.toString('latin1', s + 1, i)
    const args = i < e ? buf.toString('utf8', i + 1, e) : ''
    this.sink.onNotification(name, args)
  }

  private output(buf: Buffer, i: number, e: number, extended: boolean): void {
    // `i` points at "%<id>".
    let sp = -1
    for (let k = i; k < e; k++) {
      if (buf[k] === B_SP) { sp = k; break }
    }
    if (sp < 0) {
      this.stats.anomalies++
      this.sink.onAnomaly('output-no-pane', '')
      return
    }
    const pane = buf.toString('latin1', i, sp)

    let p = sp + 1
    let age: number | null = null
    if (extended) {
      // Fields are "<age> [reserved...] : ". Scan for a token that is exactly ":" rather than
      // searching for " : ", because the payload itself may contain that sequence.
      let tokStart = p
      let first = true
      for (;;) {
        let k = tokStart
        while (k < e && buf[k] !== B_SP) k++
        if (k >= e) {
          this.stats.anomalies++
          this.sink.onAnomaly('extout-no-colon', '')
          return
        }
        if (k - tokStart === 1 && buf[tokStart] === B_COLON) { p = k + 1; break }
        if (first) { age = Number(buf.toString('latin1', tokStart, k)); first = false }
        tokStart = k + 1
      }
    }

    const n = unescapeInto(buf, p, e, this.scratch)
    if (n < 0) {
      this.stats.anomalies++
      this.sink.onAnomaly('decode-overflow', pane)
      return
    }
    this.stats.output++
    this.sink.onOutput(pane, this.scratch.subarray(0, n), age)
  }
}
