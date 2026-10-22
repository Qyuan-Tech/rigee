import { app } from 'electron'
import type { Messages } from '@rigee/plugin-api/l10n'
import { currentLocale, resolveLocale, setLocale, type AppLocale } from '@shared/l10n'
import zhCN from '@shared/locales/zh-CN'
import { appSettings } from './store'

/**
 * Main's language: the menu, the dialogs, and the reasons it gives when something fails.
 *
 * The same answer the renderer arrives at, from the same setting and the same list of the system's
 * languages, which main hands it with the platform info. The tables are imported outright here —
 * main's size costs nothing at startup — and fetched one at a time in the renderer.
 */

const TABLES: Record<Exclude<AppLocale, 'en'>, Messages> = { 'zh-CN': zhCN }

/**
 * The system's languages, most preferred first. English in a smoke run unless
 * `RIGEE_SMOKE_LANGUAGES` lists others: the modes find buttons and read dialogs by their English
 * words, and a developer whose Mac is in Chinese must not find every one of them failing.
 */
export function systemLanguages(): string[] {
  if (process.env.RIGEE_SMOKE) return process.env.RIGEE_SMOKE_LANGUAGES?.split(',') ?? ['en']
  return app.getPreferredSystemLanguages()
}

/** Speak the language Settings names, or the system's. True when that is a change. */
export function applyLocale(): boolean {
  const locale = resolveLocale(appSettings().language, systemLanguages())
  if (locale === currentLocale()) return false
  setLocale(locale, locale === 'en' ? undefined : TABLES[locale])
  return true
}
