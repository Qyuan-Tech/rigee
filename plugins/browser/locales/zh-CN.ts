import type { Messages } from '@rigee/plugin-api/l10n'

/**
 * The browser in Simplified Chinese: each English string its code says, to what it is in Chinese.
 * `pnpm l10n:check` holds it to the code.
 *
 * One table for both halves. Main says two things of its own — the sentence around a load that
 * failed, and who is asking for a sign-in when the challenge names nobody — and Chromium's error
 * name and the URL go into the first as they come.
 */
const messages: Messages = {
  // The tab: its toolbar, its first title, a load that failed
  'Back': '后退',
  'Forward': '前进',
  'Reload': '重新加载',
  'Stop': '停止',
  'DevTools': '开发者工具',
  'Search or enter address': '搜索或输入网址',
  'new tab': '新标签页',
  '{desc} ({code}) while loading {url}': '加载 {url} 时出错：{desc}（{code}）',

  // HTTP sign-in
  'This site requires a sign-in': '此网站要求登录',
  'The proxy requires a sign-in': '代理服务器要求登录',
  'the server': '服务器',
  'Username': '用户名',
  'Password': '密码',
  'Cancel': '取消',
  'Sign in': '登录',
  '{n} more requests waiting': '还有 {n} 个请求在等待'
}

export default messages
