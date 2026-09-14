# Scroll Video Scrubber

A small, dependency-free TypeScript utility that turns vertical scroll progress into precise video seeking. CSS supplies the runway and sticky stage; JavaScript maps that geometry to `video.currentTime`.

[View the live guide and demo](https://arv.in/scroll-video-scrubber/)

## What it does

- Scrubs forward and backward with native page scroll.
- Coalesces work with `requestAnimationFrame` and avoids flooding the video decoder with seeks.
- Defers the iOS/Safari media unlock until the story is near the viewport.
- Waits for frame data before seeking and can recover a buffered seek that stalls.
- Supports element references or selectors, lifecycle callbacks, and manual progress control.
- Respects `prefers-reduced-motion` by default and restores the video’s original native controls for the fallback.
- Ships as framework-agnostic ESM with TypeScript types and a small optional stylesheet.

## Install

The package is not currently published to npm. Install it directly from GitHub:

```sh
npm install github:arvindang/scroll-video-scrubber
```

Then import the utility and its optional baseline styles:

```ts
import { createVideoScrubber } from "@arvindang/scroll-video-scrubber";
import "@arvindang/scroll-video-scrubber/styles.css";
```

## Quick start

Give the outer element enough height to create a scroll runway. Keep the visual stage sticky inside it.

```html
<section class="video-story" data-video-scrubber>
  <div class="video-story__stage" data-svs-sticky>
    <video
      data-svs-video
      src="/video/product-tour.mp4"
      preload="auto"
      muted
      playsinline
      controls
    ></video>

    <div class="video-story__progress" data-svs-progress></div>
  </div>
</section>
```

```css
.video-story {
  height: 400vh;
}

.video-story__stage {
  position: sticky;
  top: 0;
  height: 100svh;
}

.video-story__progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 4px;
  transform: scaleX(var(--svs-progress, 0));
  transform-origin: left;
  background: currentColor;
}
```

```ts
const scrubber = createVideoScrubber({
  root: "[data-video-scrubber]",
  onProgress(progress) {
    console.log(`Scrubbed ${Math.round(progress * 100)}%`);
  },
});

// Call this when a component is unmounted or replaced.
scrubber.destroy();
```

The `video`, `sticky`, and `progress` options may be elements or selectors. When omitted, the utility discovers `[data-svs-video]`, `[data-svs-sticky]`, and `[data-svs-progress]` inside `root`.

## CSS versus JavaScript

The two layers have deliberately separate jobs:

1. **CSS owns the experience’s shape.** It creates a tall runway, pins the stage with `position: sticky`, sizes the video, and renders progress or narrative overlays.
2. **JavaScript owns media time.** It measures how far the runway has moved through its sticky range, clamps that value to `0–1`, and seeks the paused video to the matching timestamp.
3. **The browser owns the frame.** The decoder displays the nearest decodable frame. Video encoding therefore has as much impact on the feel as the JavaScript.

There is no scroll-jacking and no animation framework. Native scrolling stays in charge.

## API

### `createVideoScrubber(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `root` | `Element \| string` | required | Outer scroll runway. |
| `video` | `HTMLVideoElement \| string` | discovered | Video to seek. |
| `sticky` | `Element \| string` | discovered / viewport | Sticky stage used to calculate the active viewport. |
| `progress` | `HTMLElement \| string` | discovered | Receives the `--svs-progress` CSS custom property. |
| `enabled` | `boolean` | `true` | Enables scroll-driven seeking. |
| `respectReducedMotion` | `boolean` | `true` | Disables scroll seeking for users who request reduced motion. |
| `reducedMotionQuery` | `string` | `(prefers-reduced-motion: reduce)` | Media query used for the reduced-motion preference. |
| `frameRate` | `number` | `30` | Used to avoid seeks smaller than a useful frame interval. |
| `unlockRootMargin` | `string` | `200px 0px` | How early the Safari/iOS media unlock observer starts watching. Playback waits for actual visibility. |
| `seekRecovery` | `boolean` | `true` | Reloads a visible URL-backed video at most once if a buffered seek stays pending for 2.5 seconds. Set to `false` when your player manages recovery. |
| `onReady` | `(controller) => void` | — | Runs after usable video metadata is available. |
| `onProgress` | `(progress, controller) => void` | — | Runs when effective progress changes. |
| `onError` | `(error, controller) => void` | — | Receives recoverable setup or media errors. |

The returned controller exposes:

```ts
scrubber.progress;          // current 0–1 progress (readonly)
scrubber.enabled;           // current enabled state (readonly)
scrubber.destroyed;         // lifecycle state (readonly)
scrubber.update();          // remeasure after layout changes
scrubber.setProgress(0.5);  // seek manually
scrubber.destroy();         // remove listeners and observers
```

Lifecycle notifications are callbacks rather than global DOM events. This keeps multiple scrubbers isolated and makes teardown predictable.

### Auto-initialize from HTML

For static pages, initialize every matching runway at once:

```ts
import { autoInitVideoScrubbers } from "@arvindang/scroll-video-scrubber";

const scrubbers = autoInitVideoScrubbers();
// Later: scrubbers.forEach((scrubber) => scrubber.destroy());
```

Each `[data-video-scrubber]` root can override discovery and behavior with `data-svs-video-selector`, `data-svs-sticky-selector`, `data-svs-progress-selector`, `data-svs-frame-rate`, `data-svs-disabled`, and `data-svs-ignore-reduced-motion`. The runtime writes `data-svs-enhanced`, `data-svs-state`, and `--svs-progress` for styling.

## Framework usage

Create the controller after the markup is mounted and destroy it during cleanup. For example, in React:

```tsx
import { useEffect, useRef } from "react";
import { createVideoScrubber } from "@arvindang/scroll-video-scrubber";
import "@arvindang/scroll-video-scrubber/styles.css";

export function VideoStory() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    const scrubber = createVideoScrubber({ root: rootRef.current });
    return () => scrubber.destroy();
  }, []);

  return (
    <section ref={rootRef} className="video-story" data-video-scrubber>
      <div className="video-story__stage" data-svs-sticky>
        <video data-svs-video src="/video/story.mp4" muted playsInline controls />
      </div>
    </section>
  );
}
```

The same lifecycle rule applies to Vue, Svelte, Astro, and client-side routers.

## Video preparation matters

Scroll scrubbing asks a decoder to seek repeatedly, which is different from ordinary playback. Export a web-optimized MP4 (H.264) and, when useful, a WebM alternative. Use a **short GOP** so keyframes occur frequently—roughly every 0.25–0.5 seconds is a practical starting point. Long GOPs can make the browser jump, stall, or show an earlier frame while it decodes forward.

Example FFmpeg command for a 30 fps H.264 source with a keyframe every 15 frames:

```sh
ffmpeg -i input.mov \
  -an -c:v libx264 -pix_fmt yuv420p \
  -r 30 -g 15 -keyint_min 15 -sc_threshold 0 \
  -movflags +faststart output.mp4
```

Also keep the asset reasonably small, include `muted` and `playsinline`, serve correct MIME types, and ensure the host supports byte-range requests.

## Accessibility and reduced motion

- The default reduced-motion behavior disables automatic scroll seeking. Keep native controls in the fallback markup, or expose equivalent controls when `scrubber.enabled` is `false`.
- Do not place essential instructions only inside video frames. Mirror the story in nearby text.
- Add captions when the source includes speech or meaningful audio.
- Keep overlays readable at high zoom and maintain sufficient contrast.
- If you deliberately set `respectReducedMotion: false`, provide another visible way to pause or bypass the effect.

## Browser notes

- Metadata provides duration, but a frame must also be available (`readyState >= HAVE_CURRENT_DATA`) before seeking begins. `loadeddata` and `canplay` apply the latest queued progress without requiring another scroll event. `onReady` still reports usable metadata; it does not guarantee that a frame has decoded.
- Mobile Safari may require a muted play/pause cycle before programmatic seeking works reliably; the library performs that unlock near the viewport.
- A visible video that remains in `seeking` for 2.5 seconds can be reloaded once per controller, preserving the latest progress. Recovery waits when the requested time is not buffered, skips background/offscreen videos, and is canceled on reduced motion or destruction. `srcObject` and `blob:` sources are never automatically reloaded; use `seekRecovery: false` for other sources managed by an external player.
- Returning to a tab or restoring a page remeasures scroll geometry and resynchronizes the video. A pending media unlock cannot pause consumer playback after the controller is stopped or destroyed.
- Browser decoders differ. Test the actual encoded asset on Safari/iOS, Chrome/Android, and Firefox—not only the desktop browser used during development.
- Cross-origin video hosts must allow the media request and support byte ranges. Hosting the asset with the site is usually the most dependable production setup.

## Development

```sh
npm install
npm run dev
npm test
npm run build
```

The guide lives in `docs/` and is built with Vite for GitHub Pages.

The readiness and stalled-seek regression tests simulate media event timing;
they do not replace testing a cold load, restored scroll position, and reverse
scrolling with the actual video in desktop Safari.

## License

[MIT](LICENSE) © 2026 Arvin Dang
