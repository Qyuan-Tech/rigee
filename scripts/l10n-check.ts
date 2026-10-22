/**
 * Every string Rigee and its plugins say, held to the tables that translate them.
 *
 *   pnpm l10n:check
 *
 * Reads each source file with TypeScript's own parser, collects what is said through the
 * translating functions — `t('…')`, `tn(n, '…', '…')` and `tx('…', …)` — and holds each table to
 * it. The shell's words are checked against `src/shared/locales/<locale>.ts`, a bundled plugin's
 * against `plugins/<id>/locales/<locale>.ts`, and a manifest's own words — its name, description,
 * titles and labels — against its `l10n`. It fails on:
 *
 *   - a string said in the code that a table does not translate: it would be shown in English;
 *   - an entry the code no longer says: tables are kept by reading them, and a dead entry is how a
 *     thing ends up translated two ways;
 *   - a translation that drops or invents a `{placeholder}`: the value would go missing, or
 *     `{name}` would be shown as it is;
 *   - a call whose words are not written out where it is made — `t(label)`. Nothing could check
 *     it, and the table would be the only place to find out what it says.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { PLUGIN_MANIFESTS } from '@plugins/index'
import type { PluginManifest } from '@rigee/plugin-api/manifest'

const ROOT = process.cwd()
/** Every language but English, which is the code. */
const LOCALES = ['zh-CN']

/** Where the words are said, and the tables that translate them, by domain. */
interface Domain {
  name: string
  /** Each string said, and where — the first place it is. */
  said: Map<string, string>
}

const problems: string[] = []
const domains = new Map<string, Domain>()

function domainOf(file: string): string | null {
  const rel = relative(ROOT, file).split(sep).join('/')
  if (rel.startsWith('src/')) return 'shell'
  const plugin = /^plugins\/([^/]+)\//.exec(rel)
  return plugin ? `plugins/${plugin[1]}` : null
}

function tableFile(domain: string, locale: string): string {
  return domain === 'shell' ? join(ROOT, 'src/shared/locales', `${locale}.ts`) : join(ROOT, domain, 'locales', `${locale}.ts`)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (name === 'node_modules' || name === 'locales') continue
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** The text of a string literal, or null when the expression is anything else. */
function literal(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function collect(file: string): void {
  const domainName = domainOf(file)
  if (!domainName) return
  const text = readFileSync(file, 'utf8')
  // A file that says nothing translated is not parsed: most of the code base.
  if (!/\b(t|tn|tx)\(/.test(text)) return
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const domain = domains.get(domainName) ?? { name: domainName, said: new Map() }
  domains.set(domainName, domain)

  const where = (node: ts.Node): string => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart())
    return `${relative(ROOT, file)}:${line + 1}`
  }
  const say = (words: string, node: ts.Node): void => {
    if (!domain.said.has(words)) domain.said.set(words, where(node))
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text
      if (fn === 't' || fn === 'tx') {
        const words = literal(node.arguments[0])
        if (words === null) problems.push(`${where(node)}: ${fn}() of something that is not written out — ${node.arguments[0]?.getText(source) ?? 'nothing'}`)
        else say(words, node)
      } else if (fn === 'tn') {
        const one = literal(node.arguments[1])
        const other = literal(node.arguments[2])
        if (one === null || other === null) problems.push(`${where(node)}: tn() of forms that are not written out`)
        else {
          if (!other.includes('{n}') && !one.includes('{n}')) problems.push(`${where(node)}: tn() whose forms never say {n}: "${other}"`)
          say(other, node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** A table: each entry of the object literal in the file, English to translation. */
function readTable(file: string): Map<string, string> | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const table = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isStringLiteral(node.name) || ts.isIdentifier(node.name) ? node.name.text : null
      const value = literal(node.initializer)
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      if (key === null || value === null) problems.push(`${relative(ROOT, file)}:${line + 1}: an entry that is not a string written out`)
      else if (table.has(key)) problems.push(`${relative(ROOT, file)}:${line + 1}: "${key}" is translated twice`)
      else table.set(key, value)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return table
}

const placeholders = (s: string): string => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join(' ')

/** Hold one table to what is said. */
function check(label: string, said: Map<string, string>, table: Map<string, string> | null, tableName: string): void {
  if (!table) {
    if (said.size > 0) problems.push(`${label}: ${said.size} strings said and no ${tableName}`)
    return
  }
  for (const [words, at] of said) {
    const translated = table.get(words)
    if (translated === undefined) problems.push(`${at}: not in ${tableName}: "${words}"`)
    else if (placeholders(translated) !== placeholders(words)) {
      problems.push(`${tableName}: "${words}" has ${placeholders(words) || 'no placeholders'}, its translation ${placeholders(translated) || 'none'}`)
    } else if (translated.trim() === '') problems.push(`${tableName}: "${words}" is translated as nothing`)
  }
  for (const words of table.keys()) {
    if (!said.has(words)) problems.push(`${tableName}: "${words}" is not said anywhere any more`)
  }
}

// --- the code --------------------------------------------------------------

for (const dir of ['src', 'plugins']) for (const file of walk(join(ROOT, dir))) collect(file)

for (const domain of [...domains.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  for (const locale of LOCALES) {
    const file = tableFile(domain.name, locale)
    check(domain.name, domain.said, readTable(file), relative(ROOT, file))
  }
}

// --- the manifests ---------------------------------------------------------

/** Every string a manifest shows, which its `l10n` translates. */
function manifestWords(m: PluginManifest): Map<string, string> {
  const words = new Map<string, string>()
  const add = (s: string | undefined, what: string): void => { if (s && !words.has(s)) words.set(s, `${m.id} manifest, ${what}`) }
  add(m.displayName, 'displayName')
  add(m.description, 'description')
  for (const v of m.contributes?.views ?? []) add(v.title, `views ${v.id}`)
  for (const tab of m.contributes?.tabs ?? []) {
    add(tab.displayName, `tabs ${tab.viewType}`)
    add(tab.creatable?.label, `tabs ${tab.viewType} creatable`)
  }
  for (const e of m.contributes?.editors ?? []) {
    add(e.displayName, `editors ${e.viewType}`)
    add(e.onRequest?.label, `editors ${e.viewType} onRequest`)
    add(e.onRequest?.tabPrefix, `editors ${e.viewType} tabPrefix`)
  }
  return words
}

for (const m of PLUGIN_MANIFESTS) {
  for (const locale of LOCALES) {
    const own = m.l10n?.[locale]
    check(`${m.id} manifest`, manifestWords(m), own ? new Map(Object.entries(own)) : null, `plugins/${m.id}/manifest.ts l10n['${locale}']`)
  }
}

let said = 0
for (const d of domains.values()) said += d.said.size
for (const p of problems) console.log(` FAIL  ${p}`)
console.log(`\n${said} strings in ${domains.size} places, ${LOCALES.length} language${LOCALES.length === 1 ? '' : 's'}: ${problems.length === 0 ? 'every one translated' : `${problems.length} problems`}`)
process.exit(problems.length === 0 ? 0 : 1)
