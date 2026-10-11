import characterList from '../config/characters.json';
import defaultRoster from '../config/heroRoster.json';
import ropMapping from '../config/ropMapping.json';
import { HeroSlug, HERO_SLUGS } from '../core/Constants';

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
const mapping = ropMapping.mapping as Record<string, HeroSlug>;
const labels = ropMapping.labels as Record<string, string>;

const STORAGE_KEY = 'roster-selection';

/** Cyrillic and look-alike Latin letters are all written in sheets by hand — fold them so «ВШ5» matches however it was typed. */
const LOOKALIKE: Record<string, string> = { B: 'В', b: 'в', W: 'Ш' };
function normalise(name: string): string {
    return name.trim().replace(/\s+/g, ' ').replace(/[BbW]/g, c => LOOKALIKE[c]).toUpperCase();
}
const normalisedMapping = new Map<string, HeroSlug>();
const slotByNumber = new Map<string, HeroSlug>();
for (const [name, slot] of Object.entries(mapping)) {
    normalisedMapping.set(normalise(name), slot);
    if (/^ВШ\d+$/.test(normalise(name))) slotByNumber.set(normalise(name).slice(2), slot);
}

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

function readSaved(): Selection | null {
    try {
        const text = localStorage.getItem(STORAGE_KEY);
        return text ? sanitise(JSON.parse(text)) : null;
    } catch {
        return null;
    }
}

let selection: Selection = readSaved() ?? sanitise(null);

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
        const exact = mapping[ropName];
        if (exact) return exact;
        const folded = normalise(ropName);
        const hit = normalisedMapping.get(folded);
        if (hit) return hit;
        // A full CRM name («АП_НП_ОУ_Ульяновск_ВШ6_ГБ») is recognised by its «ВШ<число>» part.
        const m = /(?:^|[^А-ЯЁ0-9])ВШ(\d+)(?![0-9])/.exec(folded);
        return m ? slotByNumber.get(m[1]) ?? null : null;
    },

    /** The short code shown on the leaderboard («ВШ5»). */
    ropNameForSlug(slug: HeroSlug): string | undefined {
        return labels[slug];
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
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch { /* storage may be unavailable (private window) — the choice then just lives until reload */ }
        return changed;
    },
};
