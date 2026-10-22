import { translator, type Translator } from '@rigee/plugin-api/l10n'
import zhCN from '../locales/zh-CN'

/** What this half says, in the language the shell is in when it says it. */
export const translatorFor = (locale: string): Translator => translator({ 'zh-CN': zhCN }, locale)
