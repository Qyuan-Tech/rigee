/**
 * Speaking the user's language.
 *
 * Done gettext's way rather than with a table of keys: the English is written in the code, where
 * it is used, and is itself what a translation is looked up by. So the code reads as it always did,
 * English needs no table at all, and a string nobody has translated yet still says something — in
 * English — instead of a key's name. Every other language is one table, from each English string
 * exactly as the code says it to what it is in that language.
 *
 * Realm-free and React-free, so a main half can use it as well as a renderer half. Which language
 * the shell is in comes from `ctx.shell.locale()` in main, and from `locale()`, `useLocale()` or
 * `localize()` in the renderer.
 */

/** A language, as a BCP 47 tag: `en`, `zh-CN`. */
export type Locale = string

/** One language: each English string, exactly as the code has it, to what it is in that language. */
export type Messages = Readonly<Record<string, string>>

/** Every language but English, by locale. English is the code itself and has no table. */
export type Translations = Readonly<Record<Locale, Messages>>

/** What fills the `{name}`s in a message. */
export type MessageParams = Readonly<Record<string, string | number>>

/**
 * `template` with each `{name}` replaced by `params[name]`. A brace that names nothing in `params`
 * is left as it is, so a message that has a `{` in it for its own reasons is not mangled.
 */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole
  )
}

/** Saying things in one language. */
export interface Translator {
  readonly locale: Locale
  /** `t('Close {name}', { name })`: the message in this language, filled in. */
  t(source: string, params?: MessageParams): string
  /**
   * A message that depends on a count, in English's two forms: `one` for exactly one, `other` for
   * any other number. `{n}` is the count, in either. A table translates it once, under `other` —
   * which is all a language with one form needs, and the count is put in whichever it is.
   */
  tn(count: number, one: string, other: string, params?: MessageParams): string
}

/**
 * The table for `locale`, or the one for its language alone — `zh` for `zh-CN` — or none, which is
 * English. Only a table's own entries count: a string such as `constructor` must not find one on
 * the way up the prototype chain.
 */
export function messagesFor(translations: Translations, locale: Locale): Messages | null {
  if (Object.hasOwn(translations, locale)) return translations[locale]
  const language = locale.split('-')[0]
  return language !== locale && Object.hasOwn(translations, language) ? translations[language] : null
}

/** Say things in `locale`, from `translations`; whatever they do not have, in English. */
export function translator(translations: Translations, locale: Locale): Translator {
  const messages = messagesFor(translations, locale)
  const lookup = (source: string): string | undefined =>
    messages && Object.hasOwn(messages, source) ? messages[source] : undefined
  return {
    locale,
    t: (source, params) => formatMessage(lookup(source) ?? source, params),
    tn: (count, one, other, params) =>
      formatMessage(lookup(other) ?? (count === 1 ? one : other), { ...params, n: count })
  }
}
