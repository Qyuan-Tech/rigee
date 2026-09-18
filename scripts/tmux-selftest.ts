/**
 * Integration self-test for the tmux control-mode client, run against a real tmux server.
 *
 *   pnpm tmux:selftest
 *
 * SAFETY: every tmux invocation in this file and in the code it exercises is pinned to a private
 * socket under /tmp/onestop-selftest. The user's default tmux server must never be listed,
 * attached to, or killed — a bare `tmux kill-server` during earlier development destroyed 14 live
 * sessions, so this is not a hypothetical concern.
 *
 * Runs under Node's native type stripping (Node >= 22.18). Every @shared import in the modules
 * under test is type-only, so nothing needs the bundler's path aliases at runtime.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TmuxClient } from '../src/main/tmux/client.ts'
import { parseLayout, panesInLayout, layoutChecksum, diffPanes } from '../src/main/tmux/layout.ts'
import { TmuxStreamParser } from '../src/main/tmux/parser.ts'

const DIR = '/tmp/onestop-selftest'
const SOCKET = join(DIR, 'selftest.sock')
const SESSION = 'onestop-selftest'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Pure unit checks — no tmux server involved
// ---------------------------------------------------------------------------

function unitTests(): void {
  console.log('\nparser')

  // The %exit regression: a 5-byte line sharing the "%e" prefix with "%extended-output " at the
  // very end of a chunk used to throw ERR_OUT_OF_RANGE on every clean shutdown.
  {
    const seen: string[] = []
    const p = new TmuxStreamParser(sinkInto(seen))
    p.push(Buffer.from('%output %0 hi\n%exit\n', 'latin1'))
    check('short %exit after %output does not throw', true)
    eq('%exit dispatched', seen.filter((s) => s.startsWith('notif:exit')).length, 1)
  }

  // %end spoofing from unescaped pane content inside a guard block.
  {
    const seen: string[] = []
    const p = new TmuxStreamParser(sinkInto(seen))
    p.push(
      Buffer.from(
        '%begin 1789633873 280 1\nAAA\n%end 1 2 3\nBBB\n%end 1789633873 280 1\n%output %0 after\n',
        'latin1'
      )
    )
    eq('spoofed %end did not close the block', seen.filter((s) => s === 'blockline:%end 1 2 3').length, 1)
    eq('body line after the spoof stayed in the block', seen.filter((s) => s === 'blockline:BBB').length, 1)
    eq('block closed exactly once', seen.filter((s) => s.startsWith('blockend:')).length, 1)
    eq('output after the block was dispatched', seen.filter((s) => s === 'out:%0:after').length, 1)
  }

  // Octal unescaping, and the fact that 0x7f and >=0x80 pass through raw.
  {
    const seen: string[] = []
    const p = new TmuxStreamParser(sinkInto(seen))
    // tmux escapes a literal backslash as \134, never as a doubled backslash. 0x7f and
    // e-acute (0xe9) must survive untouched: only bytes < 0x20 and 0x5c are escaped.
    p.push(Buffer.from('%output %1 a\\033b\\134c\x7f\xe9\n', 'latin1'))
    const frame = seen.find((s) => s.startsWith('outhex:%1:'))
    eq('octal + raw high bytes decode', frame, 'outhex:%1:611b625c637fe9')
  }

  // Arbitrary chunk boundaries must not change the result.
  {
    const wire = Buffer.from('%output %0 one\n%begin 1 2 1\nbody\n%end 1 2 1\n%exit\n', 'latin1')
    const whole: string[] = []
    new TmuxStreamParser(sinkInto(whole)).push(wire)
    let mismatches = 0
    for (let split = 1; split < wire.length; split++) {
      const piece: string[] = []
      const p = new TmuxStreamParser(sinkInto(piece))
      p.push(wire.subarray(0, split))
      p.push(wire.subarray(split))
      if (JSON.stringify(piece) !== JSON.stringify(whole)) mismatches++
    }
    eq('identical output at every split point', mismatches, 0)
  }

  console.log('\nlayout')
  {
    const body = '200x50,0,0{100x50,0,0[100x25,0,0,0,100x24,0,26,3],99x50,101,0[99x25,101,0,1,99x24,101,26,2]}'
    const full = `0b87,${body}`
    eq('checksum matches tmux', layoutChecksum(body), '0b87')
    const tree = parseLayout(full)
    eq('panes in layout order', panesInLayout(tree).join(','), '%0,%3,%1,%2')
    check('root is a horizontal split', tree.kind === 'split' && tree.direction === 'horizontal')

    const smaller = parseLayout(`${layoutChecksum('100x50,0,0,0')},100x50,0,0,0`)
    const d = diffPanes(tree, smaller)
    eq('diff finds removed panes', d.removed.sort().join(','), '%1,%2,%3')
    eq('diff finds no additions', d.added.length, 0)
  }
}

function sinkInto(out: string[]) {
  return {
    onOutput(pane: string, bytes: Uint8Array): void {
      out.push(`out:${pane}:${Buffer.from(bytes).toString('latin1')}`)
      out.push(`outhex:${pane}:${Buffer.from(bytes).toString('hex')}`)
    },
    onNotification(name: string, args: string): void { out.push(`notif:${name}:${args}`) },
    onBlockBegin(): void { out.push('blockbegin:') },
    onBlockLine(line: string): void { out.push(`blockline:${line}`) },
    onBlockEnd(ok: boolean): void { out.push(`blockend:${ok}`) },
    onAnomaly(reason: string): void { out.push(`anomaly:${reason}`) }
  }
}

// ---------------------------------------------------------------------------
// Live tmux
// ---------------------------------------------------------------------------

function killPrivateServer(): void {
  // ALWAYS -S. Never a bare kill-server.
  try {
    execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' })
  } catch { /* no server there, which is the normal case */ }
}

async function liveTests(): Promise<void> {
  console.log('\nlive tmux (private socket)')
  mkdirSync(DIR, { recursive: true })
  killPrivateServer()

  const client = new TmuxClient({
    sessionName: SESSION,
    cwd: DIR,
    socketPath: SOCKET,
    // Pristine config. Without this the test server loads the developer's own ~/.tmux.conf,
    // which means TPM plugins, arbitrary key bindings, and — if they run tmux-continuum with
    // @continuum-restore on — an attempt to restore their real sessions into this throwaway
    // server. The test would then be measuring their setup rather than our client.
    configFile: '/dev/null',
    cols: 100,
    rows: 30
  })

  const output: Buffer[] = []
  client.on('output', (_pane, data) => { output.push(Buffer.from(data)) })
  const anomalies: string[] = []
  client.on('anomaly', (reason, sample) => { anomalies.push(`${reason}:${sample.slice(0, 60)}`) })

  try {
    await client.start()
    check('attached and inventoried', true)

    const state = await new Promise<{ windows: number; panes: number }>((resolve) => {
      client.once('state', (windows, panes) => resolve({ windows: windows.length, panes: panes.length }))
      void client.refreshState()
    })
    check('one window, one pane on a fresh session', state.windows === 1 && state.panes === 1,
      `windows=${state.windows} panes=${state.panes}`)

    const paneId = (await client.command(`list-panes -F "#{pane_id}"`))[0]!.trim()
    check('pane id has the % sigil', paneId.startsWith('%'), paneId)

    // Round-trip: write a marker and read it back out of the pane's output stream.
    output.length = 0
    await client.write(paneId, new TextEncoder().encode('echo ONESTOP-RT-$((6*7))\r'))
    await sleep(900)
    const seen = Buffer.concat(output).toString('utf8')
    check('send-keys round trip', seen.includes('ONESTOP-RT-42'), JSON.stringify(seen.slice(-120)))

    // Large writes must take the load-buffer/paste-buffer path, and must be byte-exact.
    //
    // The payload is piped into `cat`, not typed at the shell prompt. Pasting a command into zsh
    // would exercise its line editor and bracketed-paste widget — someone else's code — and tell
    // us nothing about our transport. `cat` takes bytes straight off the pty.
    //
    // 64/65 straddles SEND_KEYS_MAX_BYTES, so this covers both paths and the boundary between
    // them. An end marker catches truncation, which a length check alone would miss if the
    // payload were merely echoed back.
    for (const n of [64, 65, 1024, 4096]) {
      const target = join(DIR, `paste-${n}.txt`)
      // A newline every 100 bytes. Not decoration: in canonical mode the line discipline buffers
      // at most MAX_CANON bytes (1024 on macOS) before a line terminator, so a single 4 KiB line
      // simply cannot be delivered to a cooked-mode reader. Real pasted text has newlines too.
      //
      // This doubles as the regression test for passing -r to paste-buffer: without it tmux
      // rewrites every LF to CR and the byte comparison below fails.
      const expected =
        Array.from({ length: n - 9 }, (_, i) => (i % 100 === 99 ? '\n' : 'A')).join('') + 'ENDMARKER'

      await client.write(paneId, new TextEncoder().encode(`cat > ${target}\r`))
      await sleep(400)
      await client.write(paneId, new TextEncoder().encode(expected))
      await sleep(400)
      // Ctrl-D twice, and it must be twice. In canonical mode VEOF only flushes the current
      // line buffer; it signals end-of-file solely on an empty line. One Ctrl-D after a payload
      // with no trailing newline therefore hands the bytes to cat but leaves it running, and the
      // next iteration's shell command gets typed into that live cat instead of into the shell.
      await client.write(paneId, new TextEncoder().encode('\x04'))
      await sleep(150)
      await client.write(paneId, new TextEncoder().encode('\x04'))
      await sleep(400)

      let got = ''
      try { got = readFileSync(target, 'latin1') } catch { /* never created */ }
      const path = n <= 64 ? 'send-keys' : 'paste-buffer'
      check(`${path} delivers ${n} bytes byte-exact`, got === expected,
        `got ${got.length} bytes, tail ${JSON.stringify(got.slice(-9))}`)
    }

    // Splitting must be visible through %layout-change -> refreshState.
    const second = await client.splitPane(paneId, 'vertical')
    check('split produced a new pane', second.startsWith('%') && second !== paneId, second)
    const after = await new Promise<number>((resolve) => {
      client.once('state', (_w, panes) => resolve(panes.length))
      void client.refreshState()
    })
    eq('two panes after the split', after, 2)

    const layout = client.getLayout([...(await client.command('list-windows -F "#{window_id}"'))][0]!.trim())
    check('layout parsed for the window', layout !== null && panesInLayout(layout).length === 2,
      layout ? panesInLayout(layout).join(',') : 'null')

    await client.killPane(second)
    await sleep(300)

    const capture = await client.capturePane(paneId, 100)
    check('capture-pane returned the scrollback', capture.includes('ONESTOP-RT-42'))

    eq('no protocol anomalies', anomalies.length, 0)
    if (anomalies.length) console.log('    ', anomalies.slice(0, 5))
  } finally {
    client.dispose()
    await sleep(300)
    killPrivateServer()
    rmSync(DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  unitTests()
  try {
    await liveTests()
  } catch (err) {
    failures++
    console.log('  FAIL live tests threw —', err instanceof Error ? err.message : err)
  }
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
