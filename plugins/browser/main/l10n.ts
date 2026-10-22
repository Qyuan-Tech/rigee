import { translator, type Locale, type Translator } from '@rigee/plugin-api/l10n'
import zhCN from '../locales/zh-CN'

/**
 * What this half says, in the language the shell is in when it says it: `ctx.shell.locale()`, asked
 * at that moment, since the user can switch while a page is open. Not `localize`, which comes from
 * the root `@rigee/plugin-api` and would pull React into main.
 */
export const translatorFor = (locale: Locale): Translator => translator({ 'zh-CN': zhCN }, locale)
