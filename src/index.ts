/**
 * A small, dependency-free video scrubber driven by page scroll.
 *
 * The module is safe to import during server rendering. A DOM is only required
 * when a scrubber is created.
 */

export type ElementReference<T extends Element> = T | string;

export interface VideoScrubberOptions {
  /** The scroll runway. Its height determines the amount of scroll travel. */
  root: ElementReference<HTMLElement>;
  /** Defaults to `[data-svs-video]`, then the first video inside `root`. */
  video?: ElementReference<HTMLVideoElement>;
  /** The sticky stage whose height is removed from the scroll runway. */
  sticky?: ElementReference<HTMLElement> | null;
  /** Receives `--svs-progress` in addition to `root`. */
  progress?: ElementReference<HTMLElement> | null;
  /** Set to false to construct a disabled instance. Defaults to true. */
  enabled?: boolean;
  /** Honor the user's reduced-motion preference. Defaults to true. */
  respectReducedMotion?: boolean;
  /** Defaults to `(prefers-reduced-motion: reduce)`. */
  reducedMotionQuery?: string;
  /** Used for seek precision and to avoid the video's terminal black frame. */
  frameRate?: number;
  /** How early the iOS media unlock observer starts watching. Defaults to `200px 0px`. */
  unlockRootMargin?: string;
  /** Reload a buffered, stalled URL-backed video once per controller. Defaults to true. */
  seekRecovery?: boolean;
  onProgress?: (progress: number, scrubber: VideoScrubber) => void;
  onReady?: (scrubber: VideoScrubber) => void;
  onError?: (error: Error, scrubber: VideoScrubber) => void;
}

export interface AutoInitVideoScrubbersOptions
  extends Omit<VideoScrubberOptions, "root" | "video" | "sticky" | "progress"> {
  /** Defaults to `[data-video-scrubber]`. */
  selector?: string;
  video?: ElementReference<HTMLVideoElement>;
  sticky?: ElementReference<HTMLElement> | null;
  progress?: ElementReference<HTMLElement> | null;
}

export interface VideoScrubber {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly sticky: HTMLElement | null;
  readonly progressElement: HTMLElement;
  readonly progress: number;
  readonly enabled: boolean;
  readonly destroyed: boolean;
  /** Schedule a geometry read on the next animation frame. */
  update(): void;
  /** Set progress directly, bypassing the geometry calculation. */
  setProgress(progress: number): void;
  /** Remove all listeners and observers. Safe to call more than once. */
  destroy(): void;
}

const ROOT_SELECTOR = "[data-video-scrubber]";
const VIDEO_SELECTOR = "[data-svs-video], video";
const STICKY_SELECTOR = "[data-svs-sticky]";
const PROGRESS_SELECTOR = "[data-svs-progress]";
const PROGRESS_PROPERTY = "--svs-progress";

const autoInitialized = new WeakMap<HTMLElement, VideoScrubber>();

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isHTMLElement(value: unknown): value is HTMLElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    (value as Node).nodeType === 1 &&
    "style" in value
  );
}

function isVideoElement(value: unknown): value is HTMLVideoElement {
  return isHTMLElement(value) && value.tagName.toLowerCase() === "video";
}

function resolveRoot(reference: ElementReference<HTMLElement>): HTMLElement {
  if (isHTMLElement(reference)) return reference;
  if (typeof document === "undefined") {
    throw new Error("createVideoScrubber() requires a browser DOM.");
  }

  const root = document.querySelector(reference);
  if (!isHTMLElement(root)) {
    throw new Error(`Video scrubber root not found: ${reference}`);
  }
  return root;
}

function findWithinRoot<T extends HTMLElement>(
  root: HTMLElement,
  reference: ElementReference<T>,
): T | null {
  if (isHTMLElement(reference)) return reference as T;
  if (root.matches(reference)) return root as T;
  return root.querySelector<T>(reference);
}

function resolveOptionalElement<T extends HTMLElement>(
  root: HTMLElement,
  reference: ElementReference<T> | null | undefined,
  defaultSelector: string,
  optionName: string,
): T | null {
  if (reference === null) return null;
  const isExplicit = reference !== undefined;
  const resolved = findWithinRoot<T>(root, reference ?? defaultSelector);
  if (!resolved && isExplicit) {
    throw new Error(`Video scrubber ${optionName} not found: ${String(reference)}`);
  }
  return resolved;
}

function finiteDuration(video: HTMLVideoElement): number | null {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
}

function rectHeight(rect: DOMRect): number {
  return rect.height || Math.max(0, rect.bottom - rect.top);
}

function restoreAttribute(element: Element, name: string, previous: string | null): void {
  if (previous === null) element.removeAttribute(name);
  else element.setAttribute(name, previous);
}

function errorFromMedia(video: HTMLVideoElement): Error {
  const code = video.error?.code;
  return new Error(code ? `Video scrubber media error (code ${code}).` : "Video scrubber media error.");
}

export function createVideoScrubber(options: VideoScrubberOptions): VideoScrubber {
  if (!options?.root) {
    throw new TypeError("createVideoScrubber() requires a root element or selector.");
  }

  const root = resolveRoot(options.root);
  const ownerDocument = root.ownerDocument;
  const defaultView = ownerDocument.defaultView;
  if (!defaultView) throw new Error("Video scrubber root must belong to a browser document.");
  const view: Window = defaultView;

  const videoCandidate = resolveOptionalElement<HTMLVideoElement>(
    root,
    options.video,
    VIDEO_SELECTOR,
    "video",
  );
  if (!isVideoElement(videoCandidate)) {
    throw new Error("Video scrubber requires a <video> element inside its root.");
  }

  const video = videoCandidate;
  const sticky = resolveOptionalElement<HTMLElement>(
    root,
    options.sticky,
    STICKY_SELECTOR,
    "sticky element",
  );
  const progressElement =
    resolveOptionalElement<HTMLElement>(
      root,
      options.progress,
      PROGRESS_SELECTOR,
      "progress element",
    ) ?? root;

  const configuredFrameRate = options.frameRate ?? 30;
  if (!Number.isFinite(configuredFrameRate) || configuredFrameRate <= 0) {
    throw new TypeError("Video scrubber frameRate must be a positive number.");
  }

  const respectReducedMotion = options.respectReducedMotion !== false;
  const mediaQuery =
    respectReducedMotion && typeof view.matchMedia === "function"
      ? view.matchMedia(options.reducedMotionQuery ?? "(prefers-reduced-motion: reduce)")
      : null;

  const previousRootEnhanced = root.getAttribute("data-svs-enhanced");
  const previousRootState = root.getAttribute("data-svs-state");
  const previousRootProgress = root.style.getPropertyValue(PROGRESS_PROPERTY);
  const previousTargetProgress = progressElement.style.getPropertyValue(PROGRESS_PROPERTY);
  const previousMuted = video.muted;
  const previousMutedAttribute = video.getAttribute("muted");
  const previousPlaysInline = video.playsInline;
  const previousPlaysInlineAttribute = video.getAttribute("playsinline");
  const previousControls = video.controls;
  const previousControlsAttribute = video.getAttribute("controls");

  let currentProgress = 0;
  let destroyed = false;
  let runtimeEnabled = false;
  let readyCalled = false;
  let animationFrame: number | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  let unlockInFlight = false;
  let unlocked = false;
  let unlockGeneration = 0;
  let recoveryTimer: number | null = null;
  let recoveryUsed = false;

  const scheduleFrame =
    typeof view.requestAnimationFrame === "function"
      ? view.requestAnimationFrame.bind(view)
      : (callback: FrameRequestCallback) =>
          view.setTimeout(() => callback(view.performance.now()), 16);
  const cancelFrame =
    typeof view.cancelAnimationFrame === "function"
      ? view.cancelAnimationFrame.bind(view)
      : view.clearTimeout.bind(view);

  const controller: VideoScrubber = {
    root,
    video,
    sticky,
    progressElement,
    get progress() {
      return currentProgress;
    },
    get enabled() {
      return runtimeEnabled && !destroyed;
    },
    get destroyed() {
      return destroyed;
    },
    update: requestUpdate,
    setProgress,
    destroy,
  };

  function reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    options.onError?.(normalized, controller);
  }

  function markReady(): void {
    if (readyCalled || !finiteDuration(video) || destroyed) return;
    readyCalled = true;
    options.onReady?.(controller);
  }

  function writeProgress(progress: number): void {
    const serialized = String(progress);
    root.style.setProperty(PROGRESS_PROPERTY, serialized);
    if (progressElement !== root) {
      progressElement.style.setProperty(PROGRESS_PROPERTY, serialized);
    }
  }

  function seekToCurrentProgress(force = false): void {
    if (!runtimeEnabled || destroyed || ownerDocument.hidden) return;
    if (video.seeking) {
      watchSeek();
      return;
    }
    // Safari can expose metadata before its player can decode a seek. Progress
    // remains queued until loadeddata/canplay, without changing onReady's contract.
    if (video.readyState < 2) return;
    const duration = finiteDuration(video);
    if (!duration) return;

    const oneFrame = 1 / configuredFrameRate;
    const lastRenderableTime = Math.max(0, duration - Math.min(oneFrame, duration));
    const nextTime = lastRenderableTime * currentProgress;
    const halfFrame = oneFrame / 2;
    if (!force && Math.abs(video.currentTime - nextTime) < halfFrame) return;

    try {
      video.currentTime = nextTime;
      watchSeek();
    } catch (error) {
      reportError(error);
    }
  }

  function setProgress(value: number): void {
    if (destroyed) return;
    const nextProgress = clamp(Number.isFinite(value) ? value : 0);
    const changed = Math.abs(nextProgress - currentProgress) > 0.000001;
    currentProgress = nextProgress;
    writeProgress(nextProgress);
    seekToCurrentProgress();
    if (changed) options.onProgress?.(nextProgress, controller);
  }

  function stickyTopOffset(): number {
    if (!sticky) return 0;
    const computedTop = view.getComputedStyle(sticky).top;
    const parsedTop = Number.parseFloat(computedTop);
    return Number.isFinite(parsedTop) ? parsedTop : 0;
  }

  function isVideoVisible(): boolean {
    const rect = video.getBoundingClientRect();
    const viewportWidth = view.innerWidth || ownerDocument.documentElement.clientWidth;
    const viewportHeight = view.innerHeight || ownerDocument.documentElement.clientHeight;

    return (
      !ownerDocument.hidden &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
    );
  }

  function clearRecovery(): void {
    if (recoveryTimer !== null) view.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  function canRecoverSeek(): boolean {
    const source = video.currentSrc || video.src;
    return (
      runtimeEnabled &&
      !destroyed &&
      !recoveryUsed &&
      options.seekRecovery !== false &&
      !video.error &&
      video.seeking &&
      finiteDuration(video) !== null &&
      isVideoVisible() &&
      // Custom streams and MediaSource players own their source lifecycle.
      !video.srcObject &&
      !!source &&
      !source.startsWith("blob:")
    );
  }

  function watchSeek(): void {
    if (recoveryTimer !== null || !canRecoverSeek()) return;
    recoveryTimer = view.setTimeout(recoverSeek, 2500);
  }

  function recoverSeek(): void {
    recoveryTimer = null;
    if (!canRecoverSeek()) return;
    const time = video.currentTime;
    let buffered = false;
    for (let i = 0; i < video.buffered.length; i++) {
      if (time >= video.buffered.start(i) && time < video.buffered.end(i)) buffered = true;
    }
    // A pending network request is not evidence of a stalled decoder.
    if (!buffered) {
      watchSeek();
      return;
    }
    recoveryUsed = true;
    invalidateMediaUnlock();
    try {
      video.pause();
      video.load();
    } catch (error) {
      reportError(error);
    }
  }

  function calculateProgress(): number {
    const rootRect = root.getBoundingClientRect();
    const viewportHeight = view.innerHeight || ownerDocument.documentElement.clientHeight;
    const offset = stickyTopOffset();
    const stickyHeight = sticky
      ? rectHeight(sticky.getBoundingClientRect()) || Math.max(0, viewportHeight - offset)
      : viewportHeight;
    const scrollDistance = Math.max(0, rectHeight(rootRect) - stickyHeight);

    if (scrollDistance === 0) return rootRect.top <= offset ? 1 : 0;
    return clamp((offset - rootRect.top) / scrollDistance);
  }

  function runUpdate(): void {
    animationFrame = null;
    if (!runtimeEnabled || destroyed) return;
    setProgress(calculateProgress());
  }

  function requestUpdate(): void {
    if (!runtimeEnabled || destroyed || animationFrame !== null) return;
    animationFrame = scheduleFrame(runUpdate);
  }

  function handleViewportChange(): void {
    // Safari can reject or suspend muted playback while a video is off-screen. An observer with
    // a positive root margin may fire before the video is actually visible, so retry the unlock
    // as scrolling brings it into the viewport.
    void attemptMediaUnlock();
    requestUpdate();
  }

  function handleMetadata(): void {
    markReady();
    seekToCurrentProgress();
  }

  function handleData(): void {
    seekToCurrentProgress();
    void attemptMediaUnlock();
  }

  function handleSeeked(): void {
    clearRecovery();
    // A newer scroll position may have arrived while the decoder was seeking.
    seekToCurrentProgress();
  }

  function handleMediaError(): void {
    clearRecovery();
    reportError(errorFromMedia(video));
  }

  function handlePageResume(): void {
    if (ownerDocument.hidden) {
      clearRecovery();
      return;
    }
    handleViewportChange();
    watchSeek();
  }

  function invalidateMediaUnlock(): void {
    unlockGeneration++;
    if (unlockInFlight) video.pause();
    unlockInFlight = false;
  }

  function handleEmptied(): void {
    clearRecovery();
    invalidateMediaUnlock();
    unlocked = false;
    if (runtimeEnabled) {
      root.addEventListener("pointerdown", handlePointerRetry, { passive: true });
      if (!intersectionObserver) observeForUnlock();
    }
  }

  async function attemptMediaUnlock(): Promise<void> {
    if (destroyed || !runtimeEnabled || unlocked || unlockInFlight || !isVideoVisible()) return;
    unlockInFlight = true;
    const generation = unlockGeneration;
    try {
      const playResult = video.play();
      if (playResult) await playResult;
      // A reload, reduced-motion change or destroy may have handed playback back
      // to the consumer while play() was pending. Do not pause their new session.
      if (generation !== unlockGeneration || destroyed || !runtimeEnabled) return;
      video.pause();
      unlocked = true;
      root.removeEventListener("pointerdown", handlePointerRetry);
      intersectionObserver?.disconnect();
      intersectionObserver = null;
      // Safari can accept currentTime assignments before it is able to paint their frames. Force
      // the queued scroll position back through the media pipeline after playback is unlocked.
      seekToCurrentProgress(true);
    } catch {
      if (generation !== unlockGeneration || destroyed || !runtimeEnabled) return;
      // Autoplay can still be denied. Keep the pointer listener as a user-gesture retry.
      try {
        video.pause();
      } catch {
        // A media element may reject pause while its source is being replaced.
      }
    } finally {
      if (generation === unlockGeneration) unlockInFlight = false;
    }
  }

  function handlePointerRetry(): void {
    void attemptMediaUnlock();
  }

  function observeForUnlock(): void {
    const IntersectionObserverConstructor = (
      view as Window & { IntersectionObserver?: typeof IntersectionObserver }
    ).IntersectionObserver;

    if (!IntersectionObserverConstructor) return;
    intersectionObserver = new IntersectionObserverConstructor(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
        void attemptMediaUnlock();
      },
      { rootMargin: options.unlockRootMargin ?? "200px 0px" },
    );
    intersectionObserver.observe(root);
  }

  function startRuntime(): void {
    if (destroyed || runtimeEnabled || options.enabled === false || mediaQuery?.matches) return;
    runtimeEnabled = true;
    // Author an accessible baseline with native controls, then hide them only while scroll owns
    // the playhead. Reduced motion and destroy restore the consumer's original controls state.
    video.controls = false;
    video.removeAttribute("controls");
    root.setAttribute("data-svs-enhanced", "true");
    root.setAttribute("data-svs-state", "active");
    view.addEventListener("scroll", handleViewportChange, { passive: true });
    view.addEventListener("resize", handleViewportChange, { passive: true });
    root.addEventListener("pointerdown", handlePointerRetry, { passive: true });
    observeForUnlock();
    requestUpdate();
  }

  function stopRuntime(state: "disabled" | "reduced-motion"): void {
    clearRecovery();
    invalidateMediaUnlock();
    if (runtimeEnabled) {
      runtimeEnabled = false;
      view.removeEventListener("scroll", handleViewportChange);
      view.removeEventListener("resize", handleViewportChange);
      root.removeEventListener("pointerdown", handlePointerRetry);
      intersectionObserver?.disconnect();
      intersectionObserver = null;
      if (animationFrame !== null) {
        cancelFrame(animationFrame);
        animationFrame = null;
      }
    }
    root.setAttribute("data-svs-enhanced", "false");
    root.setAttribute("data-svs-state", state);
    video.controls = previousControls;
    restoreAttribute(video, "controls", previousControlsAttribute);
  }

  function handleMotionPreference(): void {
    if (destroyed) return;
    if (mediaQuery?.matches) stopRuntime("reduced-motion");
    else if (options.enabled === false) stopRuntime("disabled");
    else startRuntime();
  }

  function destroy(): void {
    if (destroyed) return;
    stopRuntime("disabled");
    destroyed = true;
    video.removeEventListener("loadedmetadata", handleMetadata);
    video.removeEventListener("durationchange", handleMetadata);
    video.removeEventListener("loadeddata", handleData);
    video.removeEventListener("canplay", handleData);
    video.removeEventListener("seeking", watchSeek);
    video.removeEventListener("seeked", handleSeeked);
    video.removeEventListener("emptied", handleEmptied);
    video.removeEventListener("error", handleMediaError);
    view.removeEventListener("pageshow", handlePageResume);
    ownerDocument.removeEventListener("visibilitychange", handlePageResume);
    if (mediaQuery) {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", handleMotionPreference);
      } else {
        mediaQuery.removeListener(handleMotionPreference);
      }
    }

    restoreAttribute(root, "data-svs-enhanced", previousRootEnhanced);
    restoreAttribute(root, "data-svs-state", previousRootState);
    if (previousRootProgress) root.style.setProperty(PROGRESS_PROPERTY, previousRootProgress);
    else root.style.removeProperty(PROGRESS_PROPERTY);
    if (progressElement !== root) {
      if (previousTargetProgress) {
        progressElement.style.setProperty(PROGRESS_PROPERTY, previousTargetProgress);
      } else {
        progressElement.style.removeProperty(PROGRESS_PROPERTY);
      }
    }
    video.muted = previousMuted;
    video.playsInline = previousPlaysInline;
    video.controls = previousControls;
    restoreAttribute(video, "muted", previousMutedAttribute);
    restoreAttribute(video, "playsinline", previousPlaysInlineAttribute);
    restoreAttribute(video, "controls", previousControlsAttribute);
    if (autoInitialized.get(root) === controller) autoInitialized.delete(root);
  }

  video.muted = true;
  video.playsInline = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  writeProgress(0);
  video.addEventListener("loadedmetadata", handleMetadata);
  video.addEventListener("durationchange", handleMetadata);
  video.addEventListener("loadeddata", handleData);
  video.addEventListener("canplay", handleData);
  video.addEventListener("seeking", watchSeek);
  video.addEventListener("seeked", handleSeeked);
  video.addEventListener("emptied", handleEmptied);
  video.addEventListener("error", handleMediaError);
  view.addEventListener("pageshow", handlePageResume);
  ownerDocument.addEventListener("visibilitychange", handlePageResume);
  if (mediaQuery) {
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleMotionPreference);
    } else {
      mediaQuery.addListener(handleMotionPreference);
    }
  }

  markReady();
  handleMotionPreference();
  return controller;
}

/**
 * Enhance every `[data-video-scrubber]` root in a document.
 *
 * Per-root data options:
 * - `data-svs-video-selector`
 * - `data-svs-sticky-selector`
 * - `data-svs-progress-selector`
 * - `data-svs-frame-rate`
 * - `data-svs-disabled`
 * - `data-svs-ignore-reduced-motion`
 */
export function autoInitVideoScrubbers(
  options: AutoInitVideoScrubbersOptions = {},
): VideoScrubber[] {
  if (typeof document === "undefined") return [];
  const selector = options.selector ?? ROOT_SELECTOR;
  const roots = Array.from(document.querySelectorAll<HTMLElement>(selector));

  return roots.map((root) => {
    const existing = autoInitialized.get(root);
    if (existing && !existing.destroyed) return existing;

    const frameRateAttribute = Number.parseFloat(root.dataset.svsFrameRate ?? "");
    const dataOptions: VideoScrubberOptions = {
      root,
      video: root.dataset.svsVideoSelector || undefined,
      sticky: root.dataset.svsStickySelector || undefined,
      progress: root.dataset.svsProgressSelector || undefined,
      frameRate: Number.isFinite(frameRateAttribute) ? frameRateAttribute : undefined,
      enabled: !root.hasAttribute("data-svs-disabled"),
      respectReducedMotion: !root.hasAttribute("data-svs-ignore-reduced-motion"),
    };

    const scrubber = createVideoScrubber({ ...dataOptions, ...options, root });
    autoInitialized.set(root, scrubber);
    return scrubber;
  });
}
