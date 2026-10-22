import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react'
import {
  currentLocale,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
  t as translate,
  tn,
  type AppLocale
} from '@shared/l10n'
import type { Messages } from '@rigee/plugin-api/l10n'
import { useApp } from './store'

/**
 * The window's language: fetched, spoken, and redrawn in.
 *
 * Each table is a chunk of its own, fetched only when its language is chosen — English has none,
 * and none is in the entry chunk. The whole window is drawn again when the language changes,
 * because `App` subscribes with `useLocale()` and nothing in the shell is memoized: every component
 * asks `t()` again on the way down. A `useMemo` that makes words must list `useLocale()` among its
 * dependencies, or it keeps saying them in the language it began in.
 *
 * Plugins hear of it through `@rigee/plugin-api` — `locale()`, `useLocale()` and `localize()` —
 * which shellHost.tsx connects here.
 */

export { t, tn, currentLocale, onLocaleChange }

const TABLES: Record<Exclude<AppLocale, 'en'>, () => Promise<{ default: Messages }>> = {
  'zh-CN': () => import('@shared/locales/zh-CN')
}

/** The language asked for last: a table that arrives after another was asked for is not spoken. */
let wanted: AppLocale = 'en'
/** The system's languages, most preferred first, as main reported them at boot. */
let system: readonly string[] = []

/** What an unset language follows: for Settings to say which language "the system's" is. */
export const systemLanguages = (): readonly string[] => system

async function speak(locale: AppLocale): Promise<void> {
  wanted = locale
  try {
    const messages = locale === 'en' ? undefined : (await TABLES[locale]()).default
    if (wanted !== locale) return
    setLocale(locale, messages)
    // Which script a character is drawn in: the same code point is a different glyph in Chinese
    // and in Japanese, and Chromium picks the font by the document's language.
    document.documentElement.lang = locale
  } catch (err) {
    // A table that will not load leaves the window in the language it was in, which is readable.
    console.error(`[l10n] could not load ${locale}`, err)
  }
}

/**
 * Speak the language Settings names — or the first of `languages`, the system's, that Rigee
 * speaks — and follow the setting from now on. The promise is the first language spoken: boot
 * waits for it, so that nothing is drawn in English first and then again.
 */
export function speakFromSettings(languages: readonly string[]): Promise<void> {
  system = languages
  useApp.subscribe(
    (s) => s.settings.language,
    (language) => void speak(resolveLocale(language, languages))
  )
  return speak(resolveLocale(useApp.getState().settings.language, languages))
}

/** The language now. A component that calls it is drawn again when the language changes. */
export function useLocale(): AppLocale {
  return useSyncExternalStore(onLocaleChange, currentLocale)
}

/**
 * `t`, for a sentence with an element in it: each `{name}` becomes `params[name]`, which may be
 * one — `tx('Start a terminal with {key}', { key: <span className="kbd">⌘T</span> })`. Where the
 * element goes is the translation's to say, which is the point.
 */
export function tx(source: string, params: Record<string, ReactNode>): ReactNode[] {
  // Not `t(source)`: `pnpm l10n:check` reads every t() for the words it says, and these are the
  // caller's, checked where tx() is called.
  return translate(source)
    .split(/\{(\w+)\}/)
    .map((part, i) =>
      i % 2 === 0 ? part : Object.hasOwn(params, part) ? createElement(Fragment, { key: i }, params[part]) : `{${part}}`
    )
}
