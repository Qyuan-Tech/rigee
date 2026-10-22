import type { PluginPermission } from '@rigee/plugin-api/manifest'
import { t } from './l10n'

/**
 * What a permission says a plugin may do, in the language Rigee is in — what the install dialog and
 * the plugins view list.
 *
 * `PERMISSION_LABELS` in `@rigee/plugin-api` stays as it is: it is the English a plugin's author
 * reads, and part of a published package. The words are the same, so the two cannot be told apart
 * in English, and a permission added to the package fails to compile here until it is said too.
 */
export function permissionLabel(permission: PluginPermission): string {
  switch (permission) {
    case 'files:read':
      return t('Read files on this computer')
    case 'files:write':
      return t('Create and change files on this computer')
    case 'process:spawn':
      return t('Run other programs')
    case 'net':
      return t('Send and receive data over the network')
  }
}
