/**
 * Checks for installing plugins from GitHub: the convention, the version order, and above all the
 * tarball reader.
 *
 *   pnpm plugins:selftest
 *
 * The reader is the part that matters most and is easiest to get subtly wrong, because every
 * archive it sees was made by somebody else. So most of what follows is hostile archives, built
 * byte by byte — a link out of the directory, a `..`, an absolute path, a Windows separator, a
 * gzip bomb — each of which must be refused AND must leave nothing outside the directory it was
 * unpacked into. Then a real `npm pack` of the example plugin, because a reader that only ever
 * read archives this file wrote would prove only that it agrees with itself.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  compareVersions,
  isOwnerName,
  marketPluginOf,
  pluginIdOfRepo,
  versionOfTag
} from '../src/main/plugins/convention.ts'
import {
  DEFAULT_TIMING,
  fetchDue,
  parseCatalogFile,
  serializeCatalog
} from '../src/main/plugins/catalogFile.ts'
import { inspectPlugin, type DiscoveryRules } from '../src/main/plugins/disk.ts'
import { ageText, matchesPluginQuery } from '../src/shared/pluginCatalog.ts'
import { unpackTarball } from '../src/main/plugins/tarball.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'rigee-plugins-')))

console.log('\nversions')
{
  const order = [
    '0.0.1-alpha.5',
    '0.0.1-alpha.6',
    '0.0.1-alpha.10',
    '0.0.1-beta',
    '0.0.1-beta.2',
    '0.0.1',
    '0.1.0',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.10.0'
  ]
  for (let i = 0; i + 1 < order.length; i++) {
    eq(`${order[i]} < ${order[i + 1]}`, compareVersions(order[i]!, order[i + 1]!), -1)
    eq(`${order[i + 1]} > ${order[i]}`, compareVersions(order[i + 1]!, order[i]!), 1)
  }
  eq('equal versions compare equal', compareVersions('0.0.1-alpha.6', '0.0.1-alpha.6'), 0)
  let threw = false
  try { compareVersions('latest', '1.0.0') } catch { threw = true }
  check('a non-version throws rather than being ordered', threw)
  eq('v1.2.0 names 1.2.0', versionOfTag('v1.2.0'), '1.2.0')
  eq('v0.0.1-alpha.6 names a pre-release', versionOfTag('v0.0.1-alpha.6'), '0.0.1-alpha.6')
  eq('a tag without v is refused', versionOfTag('1.2.0'), null)
  eq('a two-part tag is refused', versionOfTag('v1.2'), null)
  eq('a leading zero is refused', versionOfTag('v01.2.0'), null)
}

console.log('\nnames')
{
  eq('rigee-plugin-pdf is pdf', pluginIdOfRepo('rigee-plugin-pdf'), 'pdf')
  eq('rigee-plugin-git-graph is git-graph', pluginIdOfRepo('rigee-plugin-git-graph'), 'git-graph')
  eq('no prefix, no plugin', pluginIdOfRepo('pdf-viewer'), null)
  eq('upper case is not an id', pluginIdOfRepo('rigee-plugin-PDF'), null)
  eq('an empty id is not one', pluginIdOfRepo('rigee-plugin-'), null)
  eq('a leading hyphen is not one', pluginIdOfRepo('rigee-plugin--x'), null)
  eq('a dot is not one', pluginIdOfRepo('rigee-plugin-a.b'), null)
  check('Qyuan-Tech is an owner', isOwnerName('Qyuan-Tech'))
  check('a trailing hyphen is not', !isOwnerName('abc-'))
  check('a double hyphen is not', !isOwnerName('a--b'))
  check('40 characters is too many', !isOwnerName('a'.repeat(40)))
}

console.log('\nsearch results')
{
  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'rigee-plugin-pdf',
    owner: { login: 'Qyuan-Tech' },
    description: 'PDF viewer for Rigee',
    stargazers_count: 7,
    pushed_at: '2026-10-15T00:00:00Z',
    license: { spdx_id: 'MIT' },
    topics: ['rigee-plugin'],
    archived: false,
    fork: false,
    private: false,
    ...over
  })
  const good = marketPluginOf(item())
  eq('a conforming repository is a plugin', good?.id, 'pdf')
  eq('its page is built from owner and name, not taken from the response', good?.url, 'https://github.com/Qyuan-Tech/rigee-plugin-pdf')
  eq('Rigee\'s own organisation is marked', good?.official, true)
  eq('in any case', marketPluginOf(item({ owner: { login: 'qyuan-tech' } }))?.official, true)
  eq('a look-alike is not', marketPluginOf(item({ owner: { login: 'Qyuan-Tecch' } }))?.official, false)
  eq('the wrong name is dropped', marketPluginOf(item({ name: 'pdf-for-rigee' })), null)
  eq('a missing topic is dropped', marketPluginOf(item({ topics: ['rigee'] })), null)
  eq('an archived repository is dropped', marketPluginOf(item({ archived: true })), null)
  eq('a fork is dropped', marketPluginOf(item({ fork: true })), null)
  eq('a malformed owner is dropped', marketPluginOf(item({ owner: { login: '../x' } })), null)
  eq('NOASSERTION is no licence', marketPluginOf(item({ license: { spdx_id: 'NOASSERTION' } }))?.license, null)
  eq('garbage is dropped', marketPluginOf('rigee-plugin-pdf'), null)
  eq('topics are kept', marketPluginOf(item({ topics: ['rigee-plugin', 'pdf', 'viewer'] }))?.topics.join(), 'rigee-plugin,pdf,viewer')
  eq('but only plain short words', marketPluginOf(item({ topics: ['rigee-plugin', 'Not A Topic', 'x'.repeat(80), 7] }))?.topics.join(), 'rigee-plugin')
}

console.log('\nthe plugin catalog, kept on disk')
{
  const plugin = (repo: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: repo,
    owner: { login: 'Qyuan-Tech' },
    description: `${repo} for Rigee`,
    stargazers_count: 2,
    pushed_at: '2026-10-15T00:00:00Z',
    license: { spdx_id: 'MIT' },
    topics: ['rigee-plugin', 'viewer'],
    archived: false,
    fork: false,
    private: false,
    ...over
  })
  const pdf = marketPluginOf(plugin('rigee-plugin-pdf'))!
  const video = marketPluginOf(plugin('rigee-plugin-video', { owner: { login: 'someone' }, description: 'Plays MP4 and WebM' }))!

  const back = parseCatalogFile(serializeCatalog(1_000, [pdf, video]))
  eq('what is written reads back', back?.plugins.map((p) => p.id).join(), 'pdf,video')
  eq('with its date', back?.fetchedAt, 1_000)
  eq('and every field', JSON.stringify(back?.plugins[1]), JSON.stringify(video))

  eq('another version is no list', parseCatalogFile(JSON.stringify({ version: 2, fetchedAt: 1, plugins: [] })), null)
  eq('nor is a file with no date', parseCatalogFile(JSON.stringify({ version: 1, plugins: [] })), null)
  eq('nor one that is not JSON', parseCatalogFile('{ half a file'), null)
  eq('nor JSON that is not an object', parseCatalogFile('null'), null)

  // Edited by hand, or by something worse: every entry goes back through the search result's check.
  const tampered = parseCatalogFile(JSON.stringify({
    version: 1,
    fetchedAt: 5,
    plugins: [
      { ...pdf, url: 'https://evil.example/rigee-plugin-pdf', official: false },
      { ...video, repo: 'not-a-plugin' },
      { ...video, owner: '../escape' },
      { ...video, topics: ['viewer'] },
      { ...video, id: 'pdf' },
      { ...pdf },
      'rigee-plugin-scm',
      null
    ]
  }))
  eq('a tampered file keeps only real plugins, once each', tampered?.plugins.map((p) => `${p.owner}/${p.id}`).join(), 'Qyuan-Tech/pdf,someone/video')
  eq('its page is rebuilt, not believed', tampered?.plugins[0]?.url, 'https://github.com/Qyuan-Tech/rigee-plugin-pdf')
  eq('and "Rigee\'s own" is worked out again', tampered?.plugins[0]?.official, true)
  eq('the id comes from the repository, whatever the entry says', tampered?.plugins[1]?.id, 'video')
}

console.log('\nwhen the catalog is fetched')
{
  const t = DEFAULT_TIMING
  const hour = 60 * 60_000
  const now = 100 * hour
  eq('a list never fetched is fetched', fetchDue({ fetchedAt: null, failedAt: null }, now, t), true)
  eq('a fresh one is not', fetchDue({ fetchedAt: now - hour, failedAt: null }, now, t), false)
  eq('six hours old, it is', fetchDue({ fetchedAt: now - 6 * hour, failedAt: null }, now, t), true)
  eq('but not straight after a failure', fetchDue({ fetchedAt: now - 7 * hour, failedAt: now - 60_000 }, now, t), false)
  eq('nor a list never fetched, offline', fetchDue({ fetchedAt: null, failedAt: now - 60_000 }, now, t), false)
  eq('half an hour after the failure it tries again', fetchDue({ fetchedAt: now - 7 * hour, failedAt: now - t.retryAfter }, now, t), true)
  eq('a list from the future is stale — the clock was put back', fetchDue({ fetchedAt: now + 2 * hour, failedAt: null }, now, t), true)
  eq('and so is a failure from the future, which rests nothing', fetchDue({ fetchedAt: null, failedAt: now + hour }, now, t), true)
  check('the clock looks more often than the list goes stale', t.checkEvery < t.staleAfter)
}

console.log('\nfiltering the catalog')
{
  const p = marketPluginOf({
    name: 'rigee-plugin-markdown',
    owner: { login: 'Qyuan-Tech' },
    description: 'A live Markdown preview',
    topics: ['rigee-plugin', 'preview'],
    archived: false,
    fork: false,
    private: false
  })!
  eq('no words matches', matchesPluginQuery(p, '   '), true)
  eq('the id matches', matchesPluginQuery(p, 'markdown'), true)
  eq('in any case', matchesPluginQuery(p, 'MarkDown'), true)
  eq('the owner matches', matchesPluginQuery(p, 'qyuan'), true)
  eq('the description matches', matchesPluginQuery(p, 'live'), true)
  eq('a topic matches', matchesPluginQuery(p, 'preview'), true)
  eq('every word has to', matchesPluginQuery(p, 'markdown live'), true)
  eq('so one that is not there fails it', matchesPluginQuery(p, 'markdown pdf'), false)

  const now = 10 * 24 * 60 * 60_000
  eq('a moment ago is just now', ageText(now - 10_000, now), 'just now')
  eq('one minute', ageText(now - 60_000, now), '1 minute ago')
  eq('minutes', ageText(now - 25 * 60_000, now), '25 minutes ago')
  eq('hours', ageText(now - 5 * 60 * 60_000, now), '5 hours ago')
  eq('days', ageText(now - 3 * 24 * 60 * 60_000, now), '3 days ago')
  eq('the future is just now, not negative', ageText(now + 60_000, now), 'just now')
}

// ---------------------------------------------------------------------------
// Archives, built a byte at a time
// ---------------------------------------------------------------------------

function header(name: string, size: number, type: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 'latin1')
  h.write('0000000\0', 108, 'latin1')
  h.write('0000000\0', 116, 'latin1')
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  h.write('00000000000\0', 136, 'latin1')
  h.fill(0x20, 148, 156)
  h.write(type, 156, 'latin1')
  if (linkname) h.write(linkname, 157, 100, 'utf8')
  h.write('ustar\0', 257, 'latin1')
  h.write('00', 263, 'latin1')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return h
}

function entry(name: string, data: string | Buffer = '', type = '0', linkname = ''): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data) : data
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header(name, body.length, type, linkname), body, pad])
}

/** A pax extended header carrying `path`, as node-tar writes for a long name. */
function paxPath(path: string): Buffer {
  const tail = ` path=${path}\n`
  let length = tail.length
  while (`${length}${tail}`.length !== length) length = `${length}${tail}`.length
  return entry('PaxHeader/x', `${length}${tail}`, 'x')
}

const archive = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
const LIMITS = { maxFiles: 50, maxBytes: 1024 * 1024 }

let n = 0
async function unpackInto(gz: Buffer, limits = LIMITS): Promise<{ dir: string; error: string | null }> {
  const dir = join(base, `case-${++n}`, 'plugin')
  mkdirSync(dir, { recursive: true })
  try {
    await unpackTarball(gz, dir, limits)
    return { dir, error: null }
  } catch (err) {
    return { dir, error: err instanceof Error ? err.message : String(err) }
  }
}

async function refused(label: string, gz: Buffer, limits = LIMITS): Promise<void> {
  const { dir, error } = await unpackInto(gz, limits)
  check(`refused: ${label}`, error !== null, 'it unpacked')
  // Nothing may have landed beside the directory it was unpacked into.
  const outside = readdirSync(join(dir, '..')).filter((f) => f !== 'plugin')
  check(`  and nothing escaped (${error ?? ''})`, outside.length === 0, outside.join(', '))
}

console.log('\narchives that are fine')
{
  const long = `package/dist/${'deeply/'.repeat(14)}nested.js`
  const { dir, error } = await unpackInto(
    archive(
      entry('package/package.json', '{"name":"x"}'),
      entry('package/dist/', '', '5'),
      entry('package/dist/main.js', 'export default 1\n'),
      paxPath(long),
      entry('package/dist/truncated-in-the-ustar-name.js', 'long\n'),
      entry('./package/README.md', '# hi\n')
    )
  )
  eq('unpacks without complaint', error, null)
  eq('a file arrives with its bytes', existsSync(join(dir, 'dist/main.js')) && readFileSync(join(dir, 'dist/main.js'), 'utf8'), 'export default 1\n')
  check('a pax long name is the name used', existsSync(join(dir, long.slice('package/'.length))))
  check('the ustar name it overrides is not', !existsSync(join(dir, 'dist/truncated-in-the-ustar-name.js')))
  check('a leading ./ means the same thing', existsSync(join(dir, 'README.md')))
  check('package/ is stripped', !existsSync(join(dir, 'package')))
}

console.log('\narchives that are not')
await refused('a symbolic link', archive(entry('package/evil', '', '2', '/etc')))
await refused('a hard link', archive(entry('package/evil', '', '1', '/etc/passwd')))
await refused('a FIFO', archive(entry('package/pipe', '', '6')))
await refused('.. out of the directory', archive(entry('package/../evil', 'x')))
await refused('.. deeper in', archive(entry('package/dist/../../evil', 'x')))
await refused('an absolute path', archive(entry('/tmp/evil', 'x')))
await refused('a Windows separator', archive(entry('package/..\\evil', 'x')))
await refused('a drive letter', archive(entry('package/C:evil', 'x')))
await refused('a path outside package/', archive(entry('other/evil', 'x')))
await refused('a pax path that walks out', archive(paxPath('package/../../evil'), entry('package/ok', 'x')))
await refused('the same file twice', archive(entry('package/a.js', '1'), entry('package/a.js', '2')))
await refused('the same file twice, differing in case', archive(entry('package/A.js', '1'), entry('package/a.js', '2')))
await refused('too many files', archive(...Array.from({ length: 6 }, (_, i) => entry(`package/f${i}`, 'x'))), { maxFiles: 5, maxBytes: 1024 })
await refused('too many bytes', archive(entry('package/big', Buffer.alloc(4096))), { maxFiles: 5, maxBytes: 1024 })
await refused('a gzip bomb', gzipSync(Buffer.alloc(64 * 1024 * 1024)), { maxFiles: 5, maxBytes: 1024 })
await refused('not gzip at all', Buffer.from('this is not an archive'))
{
  const bad = entry('package/x.js', 'x')
  bad[0] = 'q'.charCodeAt(0) // the checksum no longer matches the header
  await refused('a corrupt header', archive(bad))
}
{
  const whole = entry('package/x.js', Buffer.alloc(2048, 0x61))
  await refused('a truncated archive', gzipSync(whole.subarray(0, 1024)))
}

const RULES: DiscoveryRules = { reserved: new Set(['shell', 'scm']), appVersion: '0.0.1-alpha.6' }

console.log('\nthe example plugin, as npm packs it')
{
  let npm = true
  try { execFileSync('npm', ['--version'], { stdio: 'ignore' }) } catch { npm = false }
  let tgz: Buffer | null = null
  if (!npm) {
    console.log('  skip npm is not on PATH here')
  } else {
    // From the repository root, which is where pnpm runs scripts: this file runs from a bundle in
    // node_modules/.tmp, so its own location says nothing about where the example is.
    const out = join(base, 'npm')
    mkdirSync(out)
    try {
      execFileSync('npm', ['pack', join(process.cwd(), 'examples', 'hello-plugin'), '--pack-destination', out], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      tgz = readFileSync(join(out, readdirSync(out).find((f) => f.endsWith('.tgz'))!))
    } catch (err) {
      check('npm packs the example', false, err instanceof Error ? err.message : String(err))
    }
  }
  if (tgz) {
    const dir = join(base, 'npm-unpacked', 'hello')
    mkdirSync(dir, { recursive: true })
    let error: string | null = null
    try { await unpackTarball(tgz, dir, LIMITS) } catch (err) { error = err instanceof Error ? err.message : String(err) }
    eq('npm pack output unpacks', error, null)
    const inspected = inspectPlugin(dir, RULES)
    check('and is a plugin discovery accepts', !('reason' in inspected), 'reason' in inspected ? inspected.reason : '')
    eq('named by its manifest', 'reason' in inspected ? null : inspected.id, 'hello')
  }
}

console.log('\nwhat discovery adds')
{
  const plant = async (id: string, rigee: Record<string, unknown>): Promise<string> => {
    const dir = join(base, 'rules', `${++n}`, id)
    mkdirSync(dir, { recursive: true })
    const manifest = {
      id,
      version: '1.0.0',
      displayName: 'X',
      apiVersion: 1,
      renderer: 'renderer.js',
      ...rigee
    }
    await unpackTarball(
      archive(entry('package/package.json', JSON.stringify({ name: `rigee-plugin-${id}`, rigee: manifest })), entry('package/renderer.js', 'export default {}')),
      dir,
      LIMITS
    )
    return dir
  }
  const reason = (r: ReturnType<typeof inspectPlugin>): string => ('reason' in r ? r.reason : 'accepted')
  check('a reserved id is refused', /ships with Rigee/.test(reason(inspectPlugin(await plant('scm', {}), RULES))))
  check('the shell\'s own id is refused', /ships with Rigee/.test(reason(inspectPlugin(await plant('shell', {}), RULES))))
  check('a newer minAppVersion is refused', /needs Rigee 0\.0\.1-alpha\.7/.test(reason(inspectPlugin(await plant('newer', { minAppVersion: '0.0.1-alpha.7' }), RULES))))
  eq('this version exactly is fine', reason(inspectPlugin(await plant('same', { minAppVersion: '0.0.1-alpha.6' }), RULES)), 'accepted')
  eq('an older one is fine', reason(inspectPlugin(await plant('older', { minAppVersion: '0.0.1-alpha.2' }), RULES)), 'accepted')
  check('a minAppVersion that is not a version is refused', /must be a version/.test(reason(inspectPlugin(await plant('junk', { minAppVersion: 'soon' }), RULES))))
}

rmSync(base, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
