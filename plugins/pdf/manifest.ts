import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * The PDF viewer.
 *
 * Two halves for one reason: the bytes can only be read in main, and they can only be rendered in
 * the renderer. The main half is a single bounded file read; everything else — pdf.js, the canvas
 * pipeline, the outline and thumbnails — is in the renderer half and is not fetched until someone
 * opens a .pdf.
 */
export const manifest: PluginManifest = {
  id: 'pdf',
  version: '1.0.0',
  displayName: 'PDF Viewer',
  description: 'Read PDFs: continuous scrolling, text selection and search, outline, thumbnails.',
  contributes: {
    editors: [
      {
        viewType: 'pdf.preview',
        displayName: 'PDF Viewer',
        icon: 'file',
        selector: { extensions: ['pdf'] }
      }
    ]
  }
}
