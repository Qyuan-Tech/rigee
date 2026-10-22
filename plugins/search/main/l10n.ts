import { translator, type Locale, type Translator } from '@rigee/plugin-api/l10n'
import zhCN from '../locales/zh-CN'

/**
 * What this half says, in the language the shell is in when it says it. The worker says things
 * too, and has no shell to ask: it is told the language with each search.
 */
export const translatorFor = (locale: Locale): Translator => translator({ 'zh-CN': zhCN }, locale)
