import { localize } from '@rigee/plugin-api'
import zhCN from '../locales/zh-CN'

/** The text editor's words in the shell's language: see `localize` in @rigee/plugin-api. */
export const { t, tn, useT } = localize({ 'zh-CN': zhCN })
