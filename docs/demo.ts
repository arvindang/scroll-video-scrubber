import { createVideoScrubber } from "../src/index";
import "./styles.css";

const root = document.querySelector<HTMLElement>("[data-video-scrubber]");
const video = root?.querySelector<HTMLVideoElement>("[data-svs-video]");
const percent = root?.querySelector<HTMLElement>("[data-progress-percent]");
const progressBar = root?.querySelector<HTMLElement>("[data-svs-progress]");
const beat = root?.querySelector<HTMLElement>("[data-demo-beat]");
const instruction = root?.querySelector<HTMLElement>("[data-demo-instruction]");

const beats = [
  "At first, the browser is simply paused.",
  "Scroll progress becomes a precise point in time.",
  "The decoder finds the nearest available frame.",
  "Reverse the scroll and the story reverses with you.",
] as const;

let activeBeat = -1;

function renderProgress(value: number): void {
  const normalized = Math.min(1, Math.max(0, value));
  const wholePercent = Math.round(normalized * 100);
  const nextBeat = Math.min(beats.length - 1, Math.floor(normalized * beats.length));

  if (percent) {
    percent.textContent = String(wholePercent).padStart(2, "0");
  }

  if (progressBar) {
    progressBar.setAttribute("aria-valuenow", String(wholePercent));
  }

  if (beat && nextBeat !== activeBeat) {
    beat.textContent = beats[nextBeat];
    activeBeat = nextBeat;
  }
}

if (root && video) {
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  const scrubber = createVideoScrubber({
    root,
    video,
    frameRate: 30,
    respectReducedMotion: true,
    onReady(scrubber) {
      window.requestAnimationFrame(() => {
        video.controls = !scrubber.enabled;
      });
    },
    onProgress(value) {
      renderProgress(value);
    },
    onError(error) {
      video.controls = true;
      if (instruction) {
        instruction.textContent = "The scroll demo could not load. Use the video controls instead.";
      }
      console.warn("Scroll Video Scrubber demo:", error);
    },
  });

  const syncFallbackControls = (): void => {
    video.controls = !scrubber.enabled;
    if (instruction) {
      instruction.textContent = scrubber.enabled
        ? "Scroll to move through time"
        : "Use the video controls to play";
    }
  };

  syncFallbackControls();
  motionQuery?.addEventListener("change", () => {
    window.requestAnimationFrame(syncFallbackControls);
  });
}

const copyButton = document.querySelector<HTMLButtonElement>("[data-copy-install]");
const copyLabel = copyButton?.querySelector<HTMLElement>("[data-copy-label]");

copyButton?.addEventListener("click", async () => {
  const command = "npm install github:arvindang/scroll-video-scrubber";

  try {
    await navigator.clipboard.writeText(command);
    if (copyLabel) copyLabel.textContent = "Copied";
  } catch {
    if (copyLabel) copyLabel.textContent = "Select to copy";
  }

  window.setTimeout(() => {
    if (copyLabel) copyLabel.textContent = "Copy";
  }, 1800);
});
