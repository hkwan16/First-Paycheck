import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, type Locator, type Page } from '@playwright/test';

/*
 * The alpha demo's recording helpers (capture-demo.spec.ts): a caption that
 * names each scene, an animated pointer that travels to each action, smooth
 * scrolling, and the conversion of Playwright's WebM to a small H.264 MP4.
 * The caption and the pointer are Playwright's screencast overlays: drawn
 * above the page with pointer events off, never part of the app's DOM.
 */

/** The recording's frame and window: 720p, the desktop width the product targets. */
export const DEMO_SIZE = { width: 1280, height: 720 };

/** Where the MP4 goes: the alpha document's folder, or E2E_DEMO_MP4 (a local run's scratch file). */
export const DEMO_MP4 = path.resolve(
  process.env.E2E_DEMO_MP4?.trim() ||
    path.join(__dirname, '..', '..', '..', 'docs', 'alpha', 'alpha-demo.mp4'),
);

/** Homebrew's ffmpeg by default; FFMPEG overrides it. */
const FFMPEG = process.env.FFMPEG?.trim() || '/opt/homebrew/bin/ffmpeg';

type Overlay = Awaited<ReturnType<Page['screencast']['showOverlay']>>;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function captionHtml(title: string, detail: string) {
  return `
    <div style="position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
      width: max-content; max-width: 1040px; box-sizing: border-box;
      padding: 12px 22px 13px; border-radius: 14px;
      background: rgba(17, 24, 39, 0.92); color: rgb(255, 255, 255);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      text-align: center;">
      <div style="font-size: 21px; font-weight: 650; line-height: 1.3;">${escapeHtml(title)}</div>
      <div style="margin-top: 3px; font-size: 15px; line-height: 1.4;
        color: rgba(255, 255, 255, 0.86);">${escapeHtml(detail)}</div>
    </div>`;
}

/** One person going through the product, at a pace a viewer can follow. */
export class Demo {
  private caption: Overlay | null = null;

  constructor(readonly page: Page) {}

  /** Show the animated pointer at every click, hover and fill (no action titles). */
  async start() {
    await this.page.screencast.showActions({
      cursor: 'pointer',
      duration: 650,
      style: { title: 'display: none' },
    });
  }

  /** Replace the caption: the scene's number and name, and one plain sentence. */
  async scene(title: string, detail: string) {
    await this.caption?.dispose();
    this.caption = await this.page.screencast.showOverlay(captionHtml(title, detail));
  }

  /** Let the viewer read what is on screen. */
  async hold(ms: number) {
    await this.page.waitForTimeout(ms);
  }

  /** Scroll `target` smoothly to the middle of the window (or its top), then let it settle. */
  async scrollTo(target: Locator, block: 'center' | 'start' = 'center', settle = 900) {
    await expect(target).toBeVisible({ timeout: 60_000 });
    await target.evaluate(
      (element, where) => element.scrollIntoView({ behavior: 'smooth', block: where }),
      block,
    );
    await this.page.waitForTimeout(settle);
  }

  /** Scroll back to the top of the page. */
  async scrollTop(settle = 700) {
    await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await this.page.waitForTimeout(settle);
  }

  async end() {
    await this.caption?.dispose();
    this.caption = null;
  }
}

const run = promisify(execFile);

/**
 * Convert the recording to H.264 in an MP4 that starts playing before it has
 * downloaded (faststart), at a CRF that keeps text sharp and the file small.
 * The first `startSeconds` (the first screen loading) are cut. Returns the
 * MP4's size in bytes.
 */
export async function toMp4(webm: string, mp4: string, startSeconds: number): Promise<number> {
  await run(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-i',
    webm,
    '-ss',
    startSeconds.toFixed(2),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '24',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  ]);
  return statSync(mp4).size;
}
