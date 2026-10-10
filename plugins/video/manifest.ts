import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * The video player.
 *
 * Two halves, but not for the image viewer's reason. Nothing is read in main: a film is far too
 * big to hand over whole, so main only decides a file may be played and asks the shell for a URL
 * that streams it (src/main/media.ts), and the <video> element reads from that what it is about to
 * play. The renderer half is a few kilobytes of chrome around Chromium's own player, fetched the
 * first time a video is opened.
 *
 * Only containers Chromium opens are claimed — each was played here before it went on the list.
 * AVI, WMV, FLV and MPEG-2 are not: a player that opened only to say it cannot would be worse than
 * leaving them to the text editor's honest refusal.
 */
export const manifest: PluginManifest = {
  id: 'video',
  version: '1.0.0',
  displayName: 'Video Player',
  description: 'Play videos — MP4, MOV, WebM, MKV and Ogg — streamed from disk, with seeking, speed and full screen.',
  permissions: ['files:read'],
  contributes: {
    editors: [
      {
        viewType: 'video.player',
        displayName: 'Video Player',
        icon: 'video',
        selector: { extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'] }
      }
    ]
  }
}
