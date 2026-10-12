import { QUALITY } from './Quality';

export const GAME = {
    /** Logical size — every coordinate in the code is in these units. */
    WIDTH: 1280,
    HEIGHT: 720,
    /**
     * The canvas buffer is RENDER_SCALE × the logical size (camera zoom, see
     * core/Render.ts) and text is rasterised at the same factor, so text lands on
     * buffer pixels 1:1 instead of being stretched from a 720p buffer by the
     * browser (that made HUD text blurry). Chosen per device at load: it follows the
     * real on-screen size, capped at 2 (1.5 on weak machines) — see core/Quality.ts.
     */
    RENDER_SCALE: QUALITY.renderScale,
} as const;

/** Weekly plan is split into this many equal daily plans; each one crossed costs the dragon a head. */
export const DAYS = 5;

/**
 * Dragon + gold mountain, on the sandy ground at the right of the canyon
 * background. Textures are built at 2x their on-screen size by
 * tools/build-sprites.py, so they render at scale 0.5. Static — no idle bob.
 */
export const DRAGON = {
    HEADS_MAX: DAYS,
    /**
     * The whole group (mountain + dragon) is drawn at SCALE × its original size and moved right, away from the
     * heroes — the original layout (MOUNT_X 945, BODY_X 967, BODY_BOTTOM_Y 412, HIT 823/292) scaled about the
     * mountain's foot and shifted. The textures are at 2× their on-screen size, so they are drawn at 0.5 × SCALE.
     */
    SCALE: 0.9,
    /** Mountain of gold (symbol of the plan) — bottom-center anchored. */
    MOUNT_X: 1010,
    MOUNT_BOTTOM_Y: 530,
    /** The dragon body sits on the mountain top — bottom-center anchored, faces left. */
    BODY_X: 1030,
    BODY_BOTTOM_Y: 424,
    /** Where hero lunges aim (the dragon's chest/front) and hit effects burst. */
    HIT_X: 900,
    HIT_Y: 316,
    /** Stagger between successive head-loss animations when one poll crosses several day plans. */
    HEAD_LOSS_STAGGER_MS: 1100,
    HEAD_LOSS_DURATION_MS: 900,
    /** Menacing growl: rear back, tremble, settle. From time to time on its own, more often while the team is idle. */
    GROWL_MS: 1900,
    GROWL_MIN_MS: 90_000,
    GROWL_MAX_MS: 180_000,
    GROWL_IDLE_MIN_MS: 40_000,
    GROWL_IDLE_MAX_MS: 80_000,
} as const;

/** Phases of HeroSprite.playHit: wind-up, dash to the dragon, recoil on contact, walk back. */
const HIT_PHASES = { WINDUP_MS: 160, RUN_MS: 330, RECOIL_MS: 140, RETURN_MS: 480 } as const;

export const HERO = {
    /**
     * Where each department hero stands (feet), in roster order left -> right.
     * Two staggered rows on the sandy canyon floor (it starts at y≈438 in the 1280×720 background, see tools/build-scene.py): even slots are the back row (higher
     * up, slightly smaller = perspective), odd slots the front row. Neighbours
     * are then never on the same row, so wide sprites don't stack on each other;
     * PenScene sorts depth by `y` so the front row draws over the back row.
     */
    SLOTS: [
        { x: 195, y: 508, scale: 0.70 },
        { x: 283, y: 578, scale: 0.77 },
        { x: 371, y: 508, scale: 0.70 },
        { x: 459, y: 578, scale: 0.77 },
        { x: 547, y: 508, scale: 0.70 },
        { x: 635, y: 578, scale: 0.77 },
    ],
    /** Hero textures are 1/0.75 times their on-screen size (see tools/build-characters.py). */
    TEXTURE_SCALE: 0.75,
    /** Height of a standing hero's texture, px — every character is built to it (tools/build-characters.py, TARGET_H). */
    TEXTURE_HEIGHT: 290,
    /**
     * When one poll brings money for several departments (an import of a whole export, say), the heroes strike one
     * after another, left to right, this far apart: the next one sets off as the previous one's blow has landed and
     * it turns back — never everybody at once.
     */
    HIT_STAGGER_MS: 1200,
    ...HIT_PHASES,
    /** From the sale event to the blow landing on the dragon — hit effects, sound and the dragon's reaction key off this. */
    IMPACT_MS: HIT_PHASES.WINDUP_MS + HIT_PHASES.RUN_MS,
    /** Whole playHit chain, event to the hero standing back at its slot. */
    HIT_DURATION_MS: HIT_PHASES.WINDUP_MS + HIT_PHASES.RUN_MS + HIT_PHASES.RECOIL_MS + HIT_PHASES.RETURN_MS,
    /**
     * The hero runs along its own row until its leading edge (weapon/fist) reaches
     * this x — the foot of the gold mountain under the dragon — and hits from there.
     * (Sending everyone down to one spot in front of the pile was tried and
     * rejected: the heroes looked like they were hitting the gold.)
     */
    STRIKE_FRONT_X: 875,
    /** How far the hero steps back in the wind-up, px. */
    WINDUP_BACK: 24,
    /** Branch lead stands apart from the department heroes, far left, ~12 % taller than a front-row hero (so it stands out, but not too much). */
    LEAD: { x: 100, y: 540, scale: 0.86 },
    /**
     * Nameplate «ВШ1 • Измайлова И.» of each department (objects/NamePlate.ts): over the head for the back row, under
     * the feet for the front row — so a plate never covers a neighbour of the other row. It stays at the slot while
     * the hero runs off to strike. GAP — px between the plate and the head / the feet.
     */
    PLATE_GAP: 5,
} as const;

/**
 * Boredom when no sale comes in (measured across the whole team, not per department, so no
 * single department is singled out): after FIRST_MS one random hero falls over or dozes off,
 * then one more per STEP_MS, at most MAX_DOWN. Any sale wakes everybody. `?idle=<minutes>` in the
 * page URL shrinks FIRST_MS/STEP_MS to that many minutes — to show the effect without waiting an hour.
 */
const IDLE_MINUTES_OVERRIDE = Number(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('idle'));
const IDLE_STEP_MS = IDLE_MINUTES_OVERRIDE > 0 ? IDLE_MINUTES_OVERRIDE * 60_000 : 60 * 60_000;

export const IDLE = {
    FIRST_MS: IDLE_STEP_MS,
    STEP_MS: IDLE_STEP_MS,
    MAX_DOWN: 4,
    /** How often the idle time is evaluated (game time, so it does not run while the tab is hidden). */
    CHECK_MS: Math.min(30_000, IDLE_STEP_MS / 4),
    /** Chance per check, once a hero is due to drop, that it happens now — so it does not happen to the second. */
    DROP_CHANCE: 0.4,
    /** Share of the drops that are a full fall (the rest doze off on their feet). */
    FALL_SHARE: 0.5,
    /** At most this many heroes lie on the floor at once — the rows are tight, more of them would pile onto each other. The rest doze standing. */
    MAX_LYING: 2,
    WAKE_STAGGER_MS: 140,
    /** A sleeper lets out a floating "Z" this often (the only movement while asleep — keeps the display in low-frame-rate idle). */
    SNORE_MIN_MS: 25_000,
    SNORE_MAX_MS: 40_000,
} as const;

/**
 * The standing heroes breathe — one at a time, so the picture is never quite still but the weak office laptops
 * only animate a single figure: each of the seven (six heroes, then the branch lead) gets TURN_MS, then passes
 * the baton to the next (~5 minutes for the whole round). While someone breathes the game draws at the
 * "ambient" frame rate (core/PowerSaver.ts) so the loop looks smooth; the loop is a frame swap, one step per FRAME_MS.
 */
export const IDLE_ANIM = {
    FRAME_MS: 100,
    TURN_MS: 40_000,
    /** The branch lead dashes this far toward the heroes when it cheers a sale, and comes back. */
    LEAD_DASH_PX: 55,
    LEAD_DASH_MS: 300,
} as const;

export const HUD = {
    BAR_X: 32,
    BAR_Y: 22,
    BAR_WIDTH: GAME.WIDTH - 64,
    BAR_HEIGHT: 30,
} as const;

export const FX = {
    /** Comic onomatopoeia text only pops up for sales at/above this size — keeps
     * frequent small sales from making the screen "chatter" with text every hit. */
    COMIC_TEXT_MIN_DELTA: 50000,
} as const;

export const POLL = {
    INTERVAL_MS: 15000,
    /**
     * Longer than the poll interval on purpose: Apps Script answers in ~3 s typically, but roughly one
     * request in ten takes 10–30 s (measured 2026-09-21). Giving up at 15 s turned each of those into a
     * failed poll; DataPollingService never runs two polls at once, so a slow one just delays the next.
     */
    TIMEOUT_MS: 30000,
    /**
     * If the status request has not answered after this long — a cold Apps Script instance can take 10–40 s,
     * which left the screen at zeros for a minute after opening the page — a second identical request is
     * started and whichever answers first wins. (A request that fails outright is retried at once.) At most
     * MAX_ATTEMPTS per poll, so the extra load only exists while the backend is being slow.
     */
    HEDGE_AFTER_MS: 6000,
    MAX_ATTEMPTS: 2,
    /** One failed poll in a row is normal noise and is not shown; from this many the HUD says "offline". */
    OFFLINE_AFTER_FAILURES: 2,
    MAX_CONSECUTIVE_FAILURES: 5,
    /** A command older than this when the display first sees it (it was offline) is not worth playing any more. */
    COMMAND_MAX_AGE_MS: 120_000,
    /** Gap between several commands that arrive in one poll, so they read one after another. */
    COMMAND_STAGGER_MS: 700,
} as const;

/**
 * Places on the stage, not characters: six department slots (left to right, matching HERO.SLOTS and the order in
 * config/ropMapping.json) and the branch lead. Which character stands in a slot is a runtime choice made in the
 * admin page (systems/RosterConfig.ts).
 */
export const HERO_SLUGS = [
    'slot_1',
    'slot_2',
    'slot_3',
    'slot_4',
    'slot_5',
    'slot_6',
    'lead',
] as const;

export type HeroSlug = typeof HERO_SLUGS[number];
