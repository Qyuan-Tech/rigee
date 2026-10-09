import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * The image viewer.
 *
 * Two halves, for the PDF viewer's reason: the bytes can only be read in main, and only the
 * renderer can draw them. Chromium decodes every format claimed here by itself, so the renderer
 * half is a few kilobytes of chrome around an <img>, fetched the first time an image is opened.
 *
 * SVG is deliberately NOT claimed. It is source people edit, and the shell has no "open with" yet
 * to get from a picture back to the text — VS Code makes the same call, and opens .svg as text
 * unless asked otherwise. TIFF and HEIC are not claimed because Chromium cannot draw them, and a
 * viewer that opened only to say so would be worse than the text editor's honest refusal.
 */
export const manifest: PluginManifest = {
  id: 'image',
  version: '1.0.0',
  displayName: 'Image Viewer',
  description: 'View images — PNG, JPEG, GIF, WebP, AVIF, BMP and ICO — with zoom and pan.',
  contributes: {
    editors: [
      {
        viewType: 'image.preview',
        displayName: 'Image Viewer',
        icon: 'image',
        selector: {
          extensions: ['png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur']
        }
      }
    ]
  }
}
