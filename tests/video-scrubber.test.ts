import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoInitVideoScrubbers,
  createVideoScrubber,
  type VideoScrubber,
} from "../src/index";

type FrameCallback = (time: number) => void;

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = vi.fn(() => []);
  readonly root = null;
  readonly thresholds = [0];
  readonly rootMargin: string;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.rootMargin = options.rootMargin ?? "0px";
    IntersectionObserverMock.instances.push(this);
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      [
        {
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          target: document.querySelector("[data-video-scrubber]") as Element,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

function makeRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 1000,
    bottom: top + height,
    left: 0,
    width: 1000,
    height,
    toJSON: () => ({}),
  };
}

function setVideoState(
  video: HTMLVideoElement,
  initialDuration: number,
  options: { markSeekingOnSet?: boolean; readyState?: number } = {},
): {
  getCurrentTime: () => number;
  setDuration: (duration: number) => void;
  setSeeking: (seeking: boolean) => void;
  setReadyState: (readyState: number) => void;
  assignments: number[];
} {
  let duration = initialDuration;
  let currentTime = 0;
  let seeking = false;
  let readyState = options.readyState ?? 4;
  const assignments: number[] = [];

  Object.defineProperties(video, {
    duration: { configurable: true, get: () => duration },
    readyState: { configurable: true, get: () => readyState },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        assignments.push(value);
        if (options.markSeekingOnSet) seeking = true;
      },
    },
    seeking: { configurable: true, get: () => seeking },
  });

  return {
    getCurrentTime: () => currentTime,
    setDuration: (value) => {
      duration = value;
    },
    setSeeking: (value) => {
      seeking = value;
    },
    setReadyState: (value) => {
      readyState = value;
    },
    assignments,
  };
}

function renderScrubber(): {
  root: HTMLElement;
  sticky: HTMLElement;
  video: HTMLVideoElement;
  progress: HTMLElement;
} {
  document.body.innerHTML = `
    <section data-video-scrubber>
      <div data-svs-sticky style="top: 0px">
        <video data-svs-video controls></video>
        <div data-svs-progress></div>
      </div>
    </section>
  `;

  const query = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Test fixture is missing ${selector}`);
    return element;
  };

  return {
    root: query<HTMLElement>("[data-video-scrubber]"),
    sticky: query<HTMLElement>("[data-svs-sticky]"),
    video: query<HTMLVideoElement>("video"),
    progress: query<HTMLElement>("[data-svs-progress]"),
  };
}

describe("createVideoScrubber", () => {
  let frames: Map<number, FrameCallback>;
  let nextFrame: number;
  let mediaQueryMatches: boolean;
  let mediaQueryListeners: Set<() => void>;
  let play: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;
  let activeScrubbers: VideoScrubber[];

  function flushFrames(): void {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(16);
  }

  function changeReducedMotion(matches: boolean): void {
    mediaQueryMatches = matches;
    for (const listener of mediaQueryListeners) listener();
  }

  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    mediaQueryMatches = false;
    mediaQueryListeners = new Set();
    activeScrubbers = [];
    IntersectionObserverMock.instances = [];

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn((callback: FrameCallback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn((id: number) => frames.delete(id)),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        get matches() {
          return mediaQueryMatches;
        },
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => mediaQueryListeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          mediaQueryListeners.delete(listener),
        addListener: (listener: () => void) => mediaQueryListeners.add(listener),
        removeListener: (listener: () => void) => mediaQueryListeners.delete(listener),
        dispatchEvent: () => true,
      })),
    });
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: IntersectionObserverMock,
    });

    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  });

  afterEach(() => {
    for (const scrubber of activeScrubbers) scrubber.destroy();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function track(scrubber: VideoScrubber): VideoScrubber {
    activeScrubbers.push(scrubber);
    return scrubber;
  }

  function stalledVideo(seekRecovery = true) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, video } = renderScrubber();
    video.src = "/film.mp4";
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue(makeRect(100, 500));
    const media = setVideoState(video, 10, { markSeekingOnSet: true });
    const buffered = { length: 1, start: () => 0, end: () => 10 };
    Object.defineProperty(video, "buffered", { configurable: true, value: buffered });
    const load = vi.spyOn(video, "load").mockImplementation(() => {
      media.setSeeking(false);
      media.setReadyState(0);
      video.dispatchEvent(new Event("emptied"));
    });
    const scrubber = track(createVideoScrubber({ root, seekRecovery }));
    scrubber.setProgress(0.25);
    video.dispatchEvent(new Event("seeking"));
    return { root, video, media, buffered, load, scrubber };
  }

  it("maps sticky runway geometry to 0-1 progress in both scroll directions", () => {
    const { root, sticky, video, progress } = renderScrubber();
    const media = setVideoState(video, 10);
    let rootTop = 1000;
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => makeRect(rootTop, 4000));
    vi.spyOn(sticky, "getBoundingClientRect").mockImplementation(() => makeRect(0, 1000));
    const onProgress = vi.fn();
    const scrubber = track(createVideoScrubber({ root, onProgress }));

    // The initial update and multiple scroll events share one animation frame.
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);

    rootTop = -1500;
    flushFrames();
    expect(scrubber.progress).toBeCloseTo(0.5);
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.5);
    expect(root.style.getPropertyValue("--svs-progress")).toBe("0.5");
    expect(progress.style.getPropertyValue("--svs-progress")).toBe("0.5");
    expect(onProgress).toHaveBeenLastCalledWith(0.5, scrubber);

    rootTop = -750;
    window.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(scrubber.progress).toBeCloseTo(0.25);
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.25);
  });

  it("resolves selector or element references and clamps direct progress", () => {
    const { sticky, video, progress } = renderScrubber();
    const media = setVideoState(video, 6);
    const scrubber = track(
      createVideoScrubber({
        root: "[data-video-scrubber]",
        video,
        sticky: "[data-svs-sticky]",
        progress,
      }),
    );

    expect(scrubber.video).toBe(video);
    expect(scrubber.sticky).toBe(sticky);
    expect(scrubber.progressElement).toBe(progress);
    scrubber.setProgress(2);
    expect(scrubber.progress).toBe(1);
    expect(media.getCurrentTime()).toBeCloseTo(6 - 1 / 30);
    scrubber.setProgress(-10);
    expect(scrubber.progress).toBe(0);
    expect(media.getCurrentTime()).toBe(0);
  });

  it("queues the newest target while a video seek is in flight", () => {
    const { root, video } = renderScrubber();
    const media = setVideoState(video, 10, { markSeekingOnSet: true });
    const scrubber = track(createVideoScrubber({ root }));

    scrubber.setProgress(0.25);
    expect(media.assignments).toHaveLength(1);
    scrubber.setProgress(0.75);
    expect(media.assignments).toHaveLength(1);

    media.setSeeking(false);
    video.dispatchEvent(new Event("seeked"));
    expect(media.assignments).toHaveLength(2);
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.75);
  });

  it("resynchronizes after metadata and duration changes", () => {
    const { root, video } = renderScrubber();
    const media = setVideoState(video, Number.NaN);
    const onReady = vi.fn();
    const scrubber = track(createVideoScrubber({ root, onReady }));
    scrubber.setProgress(0.5);
    expect(media.assignments).toHaveLength(0);

    media.setDuration(12);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith(scrubber);
    expect(media.getCurrentTime()).toBeCloseTo((12 - 1 / 30) * 0.5);

    media.setDuration(8);
    video.dispatchEvent(new Event("durationchange"));
    expect(onReady).toHaveBeenCalledOnce();
    expect(media.getCurrentTime()).toBeCloseTo((8 - 1 / 30) * 0.5);
  });

  it("waits for frame data while preserving metadata callbacks and the latest target", () => {
    const { root, video } = renderScrubber();
    const media = setVideoState(video, 10, { readyState: 1 });
    const onReady = vi.fn();
    const scrubber = track(createVideoScrubber({ root, onReady }));

    scrubber.setProgress(0.25);
    video.dispatchEvent(new Event("loadedmetadata"));
    scrubber.setProgress(0.75);
    expect(onReady).toHaveBeenCalledOnce();
    expect(media.assignments).toHaveLength(0);
    expect(scrubber.progress).toBe(0.75);

    media.setReadyState(2);
    video.dispatchEvent(new Event("loadeddata"));
    expect(media.assignments).toHaveLength(1);
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.75);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("retries an unavailable frame on canplay without another scroll event", () => {
    const { root, video } = renderScrubber();
    const media = setVideoState(video, 10, { readyState: 1 });
    const scrubber = track(createVideoScrubber({ root }));
    scrubber.setProgress(0.5);
    expect(media.assignments).toHaveLength(0);
    media.setReadyState(4);
    video.dispatchEvent(new Event("canplay"));
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.5);
  });

  it("reloads a buffered stalled seek once and preserves the latest manual target", () => {
    const { video, media, load, scrubber } = stalledVideo();
    vi.advanceTimersByTime(1000);
    scrubber.setProgress(0.75);
    vi.advanceTimersByTime(1499);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledOnce();
    expect(scrubber.destroyed).toBe(false);
    expect(scrubber.progress).toBe(0.75);

    video.dispatchEvent(new Event("loadedmetadata"));
    expect(media.assignments).toHaveLength(1);
    media.setReadyState(4);
    video.dispatchEvent(new Event("loadeddata"));
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.75);
    vi.advanceTimersByTime(10000);
    expect(load).toHaveBeenCalledOnce();
  });

  it("waits for network data and recovers only when the pending time is buffered", () => {
    const { buffered, load } = stalledVideo();
    buffered.length = 0;
    vi.advanceTimersByTime(7500);
    expect(load).not.toHaveBeenCalled();
    buffered.length = 1;
    vi.advanceTimersByTime(2500);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not reload a seek that completed normally", () => {
    const { video, media, load } = stalledVideo();
    vi.advanceTimersByTime(1000);
    media.setSeeking(false);
    video.dispatchEvent(new Event("seeked"));
    vi.advanceTimersByTime(5000);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["destroy", "reduced motion", "media error"])("cancels recovery on %s", (reason) => {
    const { video, load, scrubber } = stalledVideo();
    vi.advanceTimersByTime(1000);
    if (reason === "destroy") scrubber.destroy();
    else if (reason === "reduced motion") changeReducedMotion(true);
    else {
      Object.defineProperty(video, "error", { configurable: true, value: { code: 3 } });
      video.dispatchEvent(new Event("error"));
    }
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    flushFrames();
    vi.advanceTimersByTime(5000);
    expect(load).not.toHaveBeenCalled();
  });

  it("defers recovery while hidden or offscreen and retries when the video returns", () => {
    const { video, load } = stalledVideo();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5000);
    expect(load).not.toHaveBeenCalled();

    vi.mocked(video.getBoundingClientRect).mockReturnValue(makeRect(1200, 500));
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    flushFrames();
    vi.advanceTimersByTime(5000);
    expect(load).not.toHaveBeenCalled();

    vi.mocked(video.getBoundingClientRect).mockReturnValue(makeRect(100, 500));
    window.dispatchEvent(new Event("scroll"));
    flushFrames();
    vi.advanceTimersByTime(2500);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "blob", "srcObject"])("leaves %s media recovery to its consumer", (source) => {
    const { video, load } = stalledVideo(source !== "disabled");
    if (source === "blob") video.src = "blob:https://example.com/stream";
    if (source === "srcObject") Object.defineProperty(video, "srcObject", { value: {} });
    vi.advanceTimersByTime(5000);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["pageshow", "visibilitychange"])("remeasures restored scroll geometry on %s", (event) => {
    const { root, sticky, video } = renderScrubber();
    const media = setVideoState(video, 10);
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(makeRect(-1500, 4000));
    vi.spyOn(sticky, "getBoundingClientRect").mockReturnValue(makeRect(0, 1000));
    const scrubber = track(createVideoScrubber({ root }));
    flushFrames();
    expect(scrubber.progress).toBe(0.5);
    vi.mocked(root.getBoundingClientRect).mockReturnValue(makeRect(-2250, 4000));
    (event === "pageshow" ? window : document).dispatchEvent(new Event(event));
    flushFrames();
    expect(scrubber.progress).toBe(0.75);
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.75);
  });

  it.each(["destroy", "reduced motion"])("ignores a pending play resolution after %s", async (reason) => {
    const { root, video } = renderScrubber();
    const media = setVideoState(video, 10);
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue(makeRect(100, 500));
    let finishPlay = () => {};
    play.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPlay = resolve; }));
    const scrubber = track(createVideoScrubber({ root }));
    IntersectionObserverMock.instances[0].trigger(true);
    if (reason === "destroy") scrubber.destroy();
    else changeReducedMotion(true);
    pause.mockClear();
    finishPlay();
    await Promise.resolve();
    await Promise.resolve();
    expect(pause).not.toHaveBeenCalled();
    expect(media.assignments).toHaveLength(0);
    expect(video.controls).toBe(true);
  });

  it("ignores the old play promise after recovery starts a new media load", async () => {
    const { video, media, load, scrubber } = stalledVideo();
    let finishOldPlay = () => {};
    let finishNewPlay = () => {};
    play.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOldPlay = resolve; }));
    play.mockImplementationOnce(() => new Promise<void>((resolve) => { finishNewPlay = resolve; }));
    IntersectionObserverMock.instances[0].trigger(true);
    vi.advanceTimersByTime(2500);
    expect(load).toHaveBeenCalledOnce();

    scrubber.setProgress(0.75);
    media.setReadyState(4);
    video.dispatchEvent(new Event("loadeddata"));
    expect(play).toHaveBeenCalledTimes(2);
    pause.mockClear();
    finishOldPlay();
    await Promise.resolve();
    await Promise.resolve();
    expect(pause).not.toHaveBeenCalled();
    finishNewPlay();
    await Promise.resolve();
    await Promise.resolve();
    expect(pause).toHaveBeenCalledOnce();
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.75);
  });

  it("stays disabled for reduced motion and responds to preference changes", () => {
    mediaQueryMatches = true;
    const { root, video } = renderScrubber();
    const media = setVideoState(video, 10);
    const scrubber = track(createVideoScrubber({ root }));

    expect(scrubber.enabled).toBe(false);
    expect(root.dataset.svsState).toBe("reduced-motion");
    expect(video.controls).toBe(true);
    expect(frames.size).toBe(0);
    scrubber.setProgress(0.5);
    expect(media.assignments).toHaveLength(0);

    changeReducedMotion(false);
    expect(scrubber.enabled).toBe(true);
    expect(root.dataset.svsState).toBe("active");
    expect(video.controls).toBe(false);
    expect(frames.size).toBe(1);

    changeReducedMotion(true);
    expect(scrubber.enabled).toBe(false);
    expect(video.controls).toBe(true);
    expect(frames.size).toBe(0);
  });

  it("unlocks near the viewport and retries a denied play on pointer input", async () => {
    const { root, video } = renderScrubber();
    const media = setVideoState(video, 10);
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue(makeRect(100, 500));
    play.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const scrubber = track(createVideoScrubber({ root, unlockRootMargin: "400px" }));
    const observer = IntersectionObserverMock.instances[0];
    scrubber.setProgress(0.5);
    expect(media.assignments).toHaveLength(1);

    expect(observer.rootMargin).toBe("400px");
    expect(observer.observe).toHaveBeenCalledWith(root);
    observer.trigger(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();

    root.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalled();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(media.assignments).toHaveLength(2);
    expect(media.getCurrentTime()).toBeCloseTo((10 - 1 / 30) * 0.5);
    expect(scrubber.enabled).toBe(true);
  });

  it("waits for actual visibility after an early unlock-margin intersection", async () => {
    const { root, video } = renderScrubber();
    setVideoState(video, 10);
    let videoTop = 1100;
    vi.spyOn(video, "getBoundingClientRect").mockImplementation(() => makeRect(videoTop, 500));
    const scrubber = track(createVideoScrubber({ root }));
    const observer = IntersectionObserverMock.instances[0];

    observer.trigger(true);
    await Promise.resolve();
    expect(play).not.toHaveBeenCalled();
    expect(observer.disconnect).not.toHaveBeenCalled();

    videoTop = 100;
    window.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(scrubber.enabled).toBe(true);
  });

  it("cleans up once and restores DOM state on destroy", () => {
    const { root, video, progress } = renderScrubber();
    setVideoState(video, 10);
    root.setAttribute("data-svs-state", "original");
    root.style.setProperty("--svs-progress", "0.2");
    progress.style.setProperty("--svs-progress", "0.3");
    const scrubber = track(createVideoScrubber({ root }));
    scrubber.setProgress(0.8);

    scrubber.destroy();
    scrubber.destroy();
    expect(scrubber.destroyed).toBe(true);
    expect(scrubber.enabled).toBe(false);
    expect(root.dataset.svsState).toBe("original");
    expect(root.hasAttribute("data-svs-enhanced")).toBe(false);
    expect(root.style.getPropertyValue("--svs-progress")).toBe("0.2");
    expect(progress.style.getPropertyValue("--svs-progress")).toBe("0.3");
    expect(video.muted).toBe(false);
    expect(video.hasAttribute("playsinline")).toBe(false);
    expect(video.controls).toBe(true);

    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
  });

  it("auto-initializes data roots once and applies data attributes", () => {
    const { root, video } = renderScrubber();
    root.dataset.svsFrameRate = "24";
    const media = setVideoState(video, 5);

    const first = autoInitVideoScrubbers();
    const second = autoInitVideoScrubbers();
    activeScrubbers.push(...first);
    expect(first).toHaveLength(1);
    expect(second[0]).toBe(first[0]);

    first[0].setProgress(1);
    expect(media.getCurrentTime()).toBeCloseTo(5 - 1 / 24);
  });
});
