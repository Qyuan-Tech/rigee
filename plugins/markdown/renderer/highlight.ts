import { loadMonaco } from '@plugins/shared/monaco'

type Monaco = Awaited<ReturnType<typeof loadMonaco>>
type Token = ReturnType<Monaco['editor']['tokenize']>[number][number]

/**
 * Colour for fenced code blocks, from the tokenizers the text editor already has.
 *
 * Monaco rather than a highlighter of our own: it knows every language the editor does, by the same
 * names, and it is very likely loaded already. It is still asked only once a document has a block
 * that names a language, so a plain note never costs its four megabytes.
 *
 * `tokenize`, NOT `colorize`, builds what goes on the page. `colorize` writes every space as a
 * no-break space and expands tabs, so code copied out of the preview and pasted into a terminal
 * would not be the code that was written. Here each token is a span around the exact text, and
 * the colours are this file's stylesheet's — the editor theme's, by value.
 */

/** Past these a block stays plain: tokenising runs on the UI thread, a line at a time. */
const MAX_BLOCK_CHARS = 100_000
const MAX_DOCUMENT_CHARS = 400_000

/** Fence names Monaco knows by no id, alias or extension of its own. */
const FENCE_NAMES: Record<string, string> = {
  zsh: 'shell',
  console: 'shell',
  'shell-session': 'shell',
  terminal: 'shell',
  jsonc: 'json',
  json5: 'json',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  docker: 'dockerfile'
}

/** Fence name to Monaco language, or null. Remembered: a document says `ts` forty times. */
const resolved = new Map<string, string | null>()

/**
 * Colour every block under `root` that names a language Monaco has. Stops as soon as `live` says
 * the document it was asked about has been replaced.
 */
export async function highlight(root: ParentNode, live: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')]
  if (blocks.length === 0) return
  const monaco = await loadMonaco()
  let budget = MAX_DOCUMENT_CHARS
  for (const code of blocks) {
    if (!live()) return
    const language = languageOf(monaco, code)
    const text = code.textContent ?? ''
    if (!language || text.length > MAX_BLOCK_CHARS || (budget -= text.length) < 0) continue
    // Loads the language's tokenizer, and those of any languages embedded in it. `tokenize` waits
    // for neither: it would quietly answer in plain text instead.
    await monaco.editor.colorize(text, language, {})
    if (!live() || !code.isConnected) return
    code.replaceChildren(paint(text, monaco.editor.tokenize(text, language)))
  }
}

function languageOf(monaco: Monaco, code: HTMLElement): string | null {
  const name = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1]?.toLowerCase()
  if (!name) return null
  if (resolved.has(name)) return resolved.get(name)!
  const languages = monaco.languages.getLanguages()
  const found =
    languages.find((l) => l.id.toLowerCase() === name) ??
    languages.find((l) => l.aliases?.some((a) => a.toLowerCase() === name)) ??
    languages.find((l) => l.extensions?.some((e) => e.toLowerCase() === `.${name}`))
  const id = found?.id ?? FENCE_NAMES[name] ?? null
  resolved.set(name, id)
  return id
}

/** The block's own text, cut at the token boundaries. Lines come back joined exactly as they were. */
function paint(text: string, lines: Token[][]): DocumentFragment {
  const out = document.createDocumentFragment()
  text.split('\n').forEach((line, i) => {
    if (i > 0) out.append('\n')
    const tokens = lines[i] ?? []
    const start = tokens[0]?.offset ?? line.length
    if (start > 0) out.append(line.slice(0, start))
    tokens.forEach((token, t) => {
      const piece = line.slice(token.offset, tokens[t + 1]?.offset ?? line.length)
      if (!piece) return
      const kind = tokenClass(token.type)
      if (!kind) {
        out.append(piece)
        return
      }
      const span = document.createElement('span')
      span.className = kind
      span.textContent = piece
      out.append(span)
    })
  })
  return out
}

/**
 * A Monarch token type — `keyword.ts`, `string.escape.js`, `attribute.value.html` — to the class
 * that colours it. The kind is the first segment; the language is the last and does not matter.
 */
function tokenClass(type: string): string | null {
  const [kind, sub] = type.split('.')
  switch (kind) {
    case 'comment':
      return 'tok-comment'
    case 'string':
      return sub === 'escape' ? 'tok-escape' : 'tok-string'
    case 'regexp':
      return 'tok-regexp'
    case 'keyword':
    case 'annotation':
      return 'tok-keyword'
    case 'number':
    case 'constant':
      return 'tok-number'
    case 'type':
      return 'tok-type'
    case 'tag':
    case 'metatag':
      return 'tok-tag'
    case 'attribute':
      return sub === 'value' ? 'tok-string' : 'tok-attribute'
    case 'key':
      return 'tok-attribute'
    case 'variable':
    case 'predefined':
      return 'tok-variable'
    case 'delimiter':
    case 'operator':
      return 'tok-punctuation'
    case 'invalid':
      return 'tok-invalid'
    case 'emphasis':
      return 'tok-emphasis'
    case 'strong':
      return 'tok-strong'
    default:
      return null
  }
}
