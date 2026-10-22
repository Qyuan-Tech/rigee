/**
 * The shell's own words, in the language the user chose.
 *
 * gettext's way (see `@rigee/plugin-api/l10n`): the English is in the code and is the key, so
 * `t('Close tab')` says "Close tab" until a table says otherwise. The tables are in `locales/`, one
 * per language but English, and are checked against every `t()` in the code by `pnpm l10n:check`.
 *
 * One language at a time per process, set at boot and whenever Settings changes it — main and the
 * renderer each set their own, from the same setting and the same system languages, so the two
 * agree. Module state rather than a context passed around because most of what speaks is not a
 * component: a menu built in a click handler, a reason thrown from main, a tooltip worked out in a
 * plain function.
 *
 * NO TABLE IS IMPORTED HERE, and none may be. This module is in the renderer's entry chunk, which
 * `pnpm perf:check` holds to a budget; a table is fetched when its language is chosen (i18n.ts in
 * the renderer) and imported outright only in main, where size costs nothing at startup.
 */

import {
  translator,
  type Locale,
  type MessageParams,
  type Messages,
  type Translations,
  type Translator
} from '@rigee/plugin-api/l10n'

/** The languages Rigee speaks, as Settings lists them. English first: it is the code itself. */
export const LOCALES = ['en', 'zh-CN'] as const
export type AppLocale = (typeof LOCALES)[number]

/**
 * Each language in its own words, which is how Settings names it — someone who has switched to a
 * language they cannot read can still find their own in the list.
 */
export const LOCALE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  'zh-CN': '简体中文'
}

export const isAppLocale = (value: unknown): value is AppLocale => LOCALES.includes(value as AppLocale)

let current: Translator = translator({}, 'en')
const listeners = new Set<() => void>()

/** Speak `locale` from now on, from `messages` — its table, or none for English. */
export function setLocale(locale: AppLocale, messages?: Messages): void {
  if (current.locale === locale && !messages) return
  current = translator(messages ? { [locale]: messages } : {}, locale)
  for (const listener of listeners) listener()
}

export const currentLocale = (): AppLocale => current.locale as AppLocale

/** Called after every change of language. Returns the way to stop. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** `source` in the language Rigee is in, with each `{name}` filled from `params`. */
export function t(source: string, params?: MessageParams): string {
  return current.t(source, params)
}

/**
 * A message that depends on a count, in English's two forms — `tn(n, '1 folder', '{n} folders')`.
 * `{n}` is the count. A table holds it once, under `other`.
 */
export function tn(count: number, one: string, other: string, params?: MessageParams): string {
  return current.tn(count, one, other, params)
}

/**
 * What a plugin's manifest says, in the language Rigee is in: the manifest's own translation of
 * `words` from its `l10n`, or the words as they are. For its name, its description, the titles and
 * labels of its contributions — never for anything the shell says itself.
 */
export function manifestText(manifest: { l10n?: Translations }, words: string): string {
  return translator(manifest.l10n ?? {}, current.locale).t(words)
}

/**
 * Which language to speak: the one chosen in Settings, or else the first of the system's preferred
 * languages that Rigee speaks — the way macOS picks a language for an app — or English.
 *
 * Simplified Chinese is `zh-Hans` on macOS, `zh-CN` on Windows and `zh_CN.UTF-8` on Linux, and
 * plain `zh` is taken to be it. Traditional Chinese is not: someone who reads it is better left to
 * the next language in their list than handed the other script.
 */
export function resolveLocale(chosen: unknown, preferred: readonly string[]): AppLocale {
  if (isAppLocale(chosen)) return chosen
  for (const tag of preferred) {
    const [language, ...rest] = tag.split(/[.@]/)[0]!.toLowerCase().split(/[-_]/)
    if (language === 'en') return 'en'
    if (language !== 'zh') continue
    // The script says, where there is one; otherwise the places that write Traditional.
    if (rest.includes('hans')) return 'zh-CN'
    if (rest.includes('hant') || rest.some((part) => ['tw', 'hk', 'mo'].includes(part))) continue
    return 'zh-CN'
  }
  return 'en'
}

export type { Locale, MessageParams }
