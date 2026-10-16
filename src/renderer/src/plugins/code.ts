import type { CodeToken } from '@rigee/plugin-api'

/**
 * `tokenizeCode`, for plugins: the text editor's tokenizers, lent out.
 *
 * Monaco rather than a highlighter of the plugin's own, because a plugin from another repository
 * would otherwise have to ship one — megabytes for a Markdown preview to colour a code block, in a
 * second copy that knows a different set of languages by different names. The text editor ships
 * with the app, so Monaco always exists here and is very likely loaded already.
 *
 * Reached by a dynamic import, so the shell's entry gains nothing: Monaco is still loaded by
 * whichever comes first, the text editor or the first code block, and Rollup gives both the same
 * chunk — one Monaco, however many callers.
 */

type Monaco = typeof import('monaco-editor')

/** Name to Monaco language id, or null. Remembered: a document names the same language forty times. */
const resolved = new Map<string, string | null>()

export async function tokenizeCode(text: string, language: string): Promise<CodeToken[][] | null> {
  const { loadMonaco } = await import('@plugins/shared/monaco')
  const monaco = await loadMonaco()
  const id = languageId(monaco, language)
  if (!id) return null
  // Loads the language's tokenizer, and those of any languages embedded in it. `tokenize` waits
  // for neither: it would quietly answer in plain text instead.
  await monaco.editor.colorize(text, id, {})
  return monaco.editor
    .tokenize(text, id)
    .map((line) => line.map((token) => ({ offset: token.offset, type: token.type })))
}

/** By id, then alias, then extension — `typescript`, `TypeScript`, `ts` — as a fence would name it. */
function languageId(monaco: Monaco, name: string): string | null {
  const key = name.trim().toLowerCase()
  if (!key) return null
  if (resolved.has(key)) return resolved.get(key)!
  const languages = monaco.languages.getLanguages()
  const found =
    languages.find((l) => l.id.toLowerCase() === key) ??
    languages.find((l) => l.aliases?.some((a) => a.toLowerCase() === key)) ??
    languages.find((l) => l.extensions?.some((e) => e.toLowerCase() === `.${key}`))
  const id = found?.id ?? null
  resolved.set(key, id)
  return id
}
