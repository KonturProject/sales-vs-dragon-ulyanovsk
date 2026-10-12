import characterList from '../config/characters.json';
import defaultRoster from '../config/heroRoster.json';
import { HeroSlug, HERO_SLUGS } from '../core/Constants';
import { GROUP_SLOTS, groupCode, plateText, sanitiseLeaders, slotForGroup } from './Groups';

/** One of the selectable characters (config/characters.json, built by tools/build-characters.py). */
export interface CharacterDef {
    id: string;
    /** Russian display name — what the admin page shows. */
    name: string;
    /** Swatch / hit-flash colour. */
    color: string;
    /** Number of strike frames `char_<id>_hit1..N` (the run cycle first, the blow last). */
    hits: number;
    /** The breathing loop: `char_<id>_idle` is a strip of `frames` equal cells of `width` × `height` px. */
    idle?: { frames: number; width: number; height: number };
}

/** What a slot (a department, or the branch lead) needs to draw: the standing texture, the strike frames, the colour. */
export interface HeroDef {
    slug: HeroSlug;
    characterId: string;
    sprite: string;
    color: string;
    lead: boolean;
    hits: number;
    idle?: { frames: number; width: number; height: number };
}

export type Selection = Record<string, string>;

export const LEAD_SLOT: HeroSlug = 'lead';
const FIGHTER_SLOTS = HERO_SLUGS.filter(s => s !== LEAD_SLOT);

const characters = characterList.characters as CharacterDef[];

const STORAGE_KEY = 'roster-selection';
const LEADERS_STORAGE_KEY = 'roster-leaders';

function isKnownCharacter(id: unknown): id is string {
    return typeof id === 'string' && characters.some(c => c.id === id);
}

/** Keep only well-formed choices: known slots with known characters; anything else falls back to the default. */
function sanitise(raw: unknown): Selection {
    const out: Selection = { ...(defaultRoster.selection as Selection) };
    if (raw && typeof raw === 'object') {
        for (const slot of HERO_SLUGS) {
            const id = (raw as Record<string, unknown>)[slot];
            if (isKnownCharacter(id)) out[slot] = id;
        }
    }
    return out;
}

/** What this display last received from the backend (so a reload shows it at once, before the first poll). */
function readStored<T>(key: string, clean: (raw: unknown) => T): T | null {
    try {
        const text = localStorage.getItem(key);
        return text ? clean(JSON.parse(text)) : null;
    } catch {
        return null;
    }
}

function store(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage may be unavailable (private window) — the choice then just lives until reload */ }
}

let selection: Selection = readStored(STORAGE_KEY, sanitise) ?? sanitise(null);
let leaders: Record<string, string> = readStored(LEADERS_STORAGE_KEY, sanitiseLeaders) ?? sanitiseLeaders(null);

function def(slot: HeroSlug): HeroDef {
    const ch = characters.find(c => c.id === selection[slot]) ?? characters[0];
    return { slug: slot, characterId: ch.id, sprite: `char_${ch.id}`, color: ch.color, lead: slot === LEAD_SLOT, hits: ch.hits, idle: ch.idle };
}

export const RosterConfig = {
    /** Every selectable character (the admin page's list). */
    characters,

    /** Department slots, left to right, then the lead — the current look of each. */
    get heroes(): HeroDef[] {
        return HERO_SLUGS.map(def);
    },

    get fighters(): HeroDef[] {
        return FIGHTER_SLOTS.map(def);
    },

    get lead(): HeroDef {
        return def(LEAD_SLOT);
    },

    /** The slot of a department, from the name as written in the sheet; null if it is not one of ours. */
    heroSlugForRop(ropName: string): HeroSlug | null {
        return slotForGroup(ropName) as HeroSlug | null;
    },

    /** The short code of a department («ВШ5»). */
    ropNameForSlug(slug: HeroSlug): string | undefined {
        return groupCode(slug);
    },

    /** The nameplate (and leaderboard) text of a department: «ВШ1 • Измайлова И.». */
    plateText(slug: HeroSlug): string {
        return plateText(slug, leaders);
    },

    /** Applies the group leaders' names coming from the backend. Returns the slots whose name changed. */
    applyLeaders(raw: unknown): HeroSlug[] {
        const next = sanitiseLeaders(raw);
        const changed = GROUP_SLOTS.filter(s => next[s] !== leaders[s]) as HeroSlug[];
        leaders = next;
        if (changed.length > 0) store(LEADERS_STORAGE_KEY, next);
        return changed;
    },

    heroDef(slug: HeroSlug): HeroDef | undefined {
        return (HERO_SLUGS as readonly string[]).includes(slug) ? def(slug) : undefined;
    },

    characterDef(id: string): CharacterDef | undefined {
        return characters.find(c => c.id === id);
    },

    /** The current choice, slot -> character id (what the backend stores). */
    get selection(): Selection {
        return { ...selection };
    },

    /**
     * Applies a choice coming from the backend. Returns the slots whose character changed (empty = nothing to do).
     * Bad values are ignored per slot, so a corrupt entry can never blank the stage.
     */
    applySelection(raw: unknown): HeroSlug[] {
        const next = sanitise(raw);
        const changed = HERO_SLUGS.filter(s => next[s] !== selection[s]);
        selection = next;
        store(STORAGE_KEY, next);
        return changed;
    },
};
