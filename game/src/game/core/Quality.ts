/**
 * Render-quality profile, decided once at page load (before the Phaser game is
 * created, because the canvas size depends on it).
 *
 * The game is an always-on office display that mostly shows a still picture, and
 * it runs on whatever laptops the team has — including 2-core i3 machines with
 * integrated graphics. Drawing every frame at a 2560×1440 buffer pinned those at
 * 60–100 % CPU (see docs/tech.md, "Производительность"). So:
 *  - the buffer follows the real on-screen size instead of a fixed 2× (extra
 *    pixels beyond the screen's are pure cost);
 *  - weak devices ("low" tier) get a smaller buffer cap and a lower frame rate;
 *  - PowerSaver drops the frame rate further while nothing is animating.
 *
 * Overrides for tuning/diagnosing on a specific machine, via the page URL:
 *   ?quality=low|high   force a tier
 *   ?scale=1.25         force the buffer scale (1 = 1280×720)
 *   ?fps=30             force the active frame rate
 *   ?idlefps=5          force the idle frame rate
 */

export type QualityTier = 'low' | 'high';

const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

function numberParam(name: string, min: number, max: number): number | null {
    const raw = params.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function detectTier(): QualityTier {
    const forced = params.get('quality');
    if (forced === 'low' || forced === 'high') return forced;
    // hardwareConcurrency counts logical processors: a dual-core i3 reports 4.
    const cores = navigator.hardwareConcurrency || 4;
    const memoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
    return cores <= 4 || memoryGb <= 4 ? 'low' : 'high';
}

/** Buffer pixels per logical pixel that would put one buffer pixel on each screen pixel. */
function wantedScale(): number {
    const dpr = window.devicePixelRatio || 1;
    // Scale.FIT: the 16:9 canvas is limited by whichever window side runs out first.
    const cssWidth = Math.min(window.innerWidth, (window.innerHeight * LOGICAL_WIDTH) / LOGICAL_HEIGHT);
    return (cssWidth * dpr) / LOGICAL_WIDTH;
}

function detectScale(tier: QualityTier): number {
    const forced = numberParam('scale', 0.5, 3);
    if (forced !== null) return forced;
    const cap = tier === 'low' ? 1.5 : 2;
    // Quarter steps keep the buffer an integer number of pixels (1280 × 0.25 = 320).
    return Math.min(cap, Math.max(1, Math.round(wantedScale() * 4) / 4));
}

const tier = detectTier();

export const QUALITY = {
    tier,
    /** Canvas buffer = logical size × this (also the camera zoom and the text resolution). */
    renderScale: detectScale(tier),
    /** Frame-rate ceiling while something is moving. */
    activeFps: numberParam('fps', 5, 240) ?? (tier === 'low' ? 30 : 60),
    /** Frame rate while the picture is still — nothing to see, so nothing to spend. */
    idleFps: numberParam('idlefps', 1, 60) ?? 10,
} as const;
