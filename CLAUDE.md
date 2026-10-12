# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Победи дракона" — the **Ulyanovsk branch** edition of `KonturProject/sales-vs-dragon` (the Moscow game "Отделы против дракона"). A Phaser 4 + Vite + TypeScript office-display game: six department heroes hit a five-headed dragon on a gold mountain whenever a payment lands in a private Google Sheet; each of the 5 equal daily plans crossed (20/40/60/80/100 % of the weekly plan) cuts off a head; at 100 % a victory banner appears; the branch lead cheers on every sale. A PIN-gated admin page manages everything. Live at https://konturproject.github.io/sales-vs-dragon-ulyanovsk/ (admin: `/admin.html`).

It was forked from the Moscow repo on 2026-10-11 and the **mechanics are intentionally identical**; what differs is listed in `docs/tech.md` ("Чем отличается от московской версии"): the six groups (`ВШ1 ВШ4 ВШ5 ВШ6 ВШ9 ВШ10`), 30 selectable heroes (7 serious 2D characters from the CC0 AutoSprite library, in colour variants), a darkened CC0 canyon background, a separate Apps Script backend + spreadsheet «победи дракона», and a **runtime hero chooser** in the admin page. The dragon and gold-mountain art come from the Moscow game. The two repos are independent: a fix made in one must be ported by hand to the other.

Full rationale for decisions is in `docs/tech.md`; the backend API is in `apps-script/README.md`.

## Commands

All commands run from `game/` (the Vite project; the repo root only wraps it).

```bash
npm run dev            # dev server on :8080, hot reload
npm run build          # production build to game/dist (multi-entry: index.html + admin.html)
npx tsc --noEmit -p tsconfig.json   # type-check
npm run test:backend   # runs the real apps-script/Code.gs against fake Google services (37 tests)
npm run mock-backend   # same Code.gs on http://localhost:8787/exec, admin PIN 1234, data in memory
npm run deploy         # build + publish dist/ to the gh-pages branch
python tools/build-scene.py                     # rebuild the background from assets-source/scene
python tools/build-characters.py <packs dir>    # rebuild the 30 hero sprites from the unzipped AutoSprite packs (see the docstring / characters.src.json)
```

Dev pages accept `?backend=http://localhost:8787/exec` to talk to the mock backend. There is no linter and no browser test suite: `tsc --noEmit` + `npm run test:backend` + looking at it in the browser (`window.__debug`, see below) is the verification routine.

## Architecture (same as the Moscow game unless noted)

**Two Vite entry points**: `index.html` (the Phaser game, `src/main.ts` → `src/game/`) and `admin.html` (plain-DOM admin, `src-admin/`). Config in `vite/config.{dev,prod}.mjs`.

**Data flow**: private Google Sheet → Apps Script Web App (`apps-script/Code.gs`, deployed by hand — the repo copy is a mirror) → `DataPollingService` polls every 15 s, diffs `byRop`, emits `MONEY_IN` / `PROGRESS_CHANGED` / `DRAGON_HEAD_LOST` / `DRAGON_DEFEATED` / `DATA_UPDATED` / `ADMIN_COMMAND` / **`ROSTER_CHANGED`** / **`LEADERS_CHANGED`** on the `EventBus`. `GameState` is the single source of truth; `GameState.headsRemaining = DAYS − floor(ratio × DAYS)`.

**Strikes one after another (new here)**: one poll can bring money for several departments (typically right after an import). The diff adds up the deltas per slot (one blow per hero, even if the group came under two spellings) and fires the `MONEY_IN`s **left to right, `HERO.HIT_STAGGER_MS` (1.2 s) apart** — the next hero sets off as the previous one's blow lands; the user explicitly asked that they never all strike at once. Head loss waits for the last blow (`hitsFinishAt` in `diffAndEmit`).

**Baseline gotcha**: the first poll after page load is a baseline — it puts the dragon straight into the right state without animation; `PenScene.create()` also calls `onProgressChanged` once with an empty state, which must not consume the baseline (see the comment there). Heads only decrease through `DRAGON_HEAD_LOST` and only increase through `PROGRESS_CHANGED`. Delayed events (head loss, victory) must re-check `GameState` before showing anything.

**Slots vs characters (new here)**: the stage has seven *slots* — `slot_1…slot_6` (the departments, left to right = `HERO.SLOTS` = the order of `config/ropMapping.json` `labels`) and `lead`. Everything that identifies a hero in events, the leaderboard, idle mood and the backend is the **slot id**, never the character. Which character looks out of a slot is a runtime choice (`systems/RosterConfig.ts`): the admin page's «Герои» tab sends `setRoster` to the backend, the backend stores it in Script Properties and hands it out in the public GET (`roster`), the poller calls `RosterConfig.applySelection` and, for slots that changed, emits `ROSTER_CHANGED`; `PenScene` then loads the missing textures (`systems/CharacterLoader.ts` — only characters on stage are ever in memory) and calls `HeroSprite.setCharacter` / `LeadSprite.setCharacter` (a small pop; waits out a strike in progress). The last choice is cached in `localStorage` (`roster-selection`) so a reload shows the right heroes before the first poll answers; `config/heroRoster.json` holds the defaults.

**Group names**: the sheet's ROP drop-down holds the short codes. `systems/Groups.ts` (plain TS, no Phaser — shared by the game and the admin page) maps a name to a slot: exact, look-alike letters folded, or any name containing `ВШ<число>` (full CRM names such as `АП_НП_ОУ_Москва_ВШ5_ГБ_УД`); `RosterConfig.heroSlugForRop` delegates to it.

**Nameplates (new here)**: every department has a plate «ВШ1 • Измайлова И.» (`objects/NamePlate.ts`, dark wood + thin gold frame + cream serif, no coat of arms — the branch's reference style): over the head for the back row, under the feet for the front row (so a plate never covers a neighbour of the other row), depth 1000; it stays at the slot while the hero runs off to strike. The leaderboard rows read the same text. The leaders' names are edited in the admin page («Герои» tab, a field per group; a pasted full name is shortened to «Фамилия И.» by `Groups.shortPersonName`) → `setRoster {leaders}` → Script Properties `LEADERS` → public GET `leaders` → `RosterConfig.applyLeaders` (cached in `localStorage` `roster-leaders`) → `LEADERS_CHANGED` → `PenScene.onLeadersChanged` / `Leaderboard.refreshLabels`. Defaults: `ropMapping.json` `leaders` — surname + initial only, the repo and the site are public.

**Payment import (new here)**: admin tab «Импорт» reads the CRM export «Детальные данные по оплаченным счетам» (.xlsx) **in the browser** (`src-admin/paymentsFile.ts`, SheetJS 0.20.3 from cdn.sheetjs.com, loaded lazily as its own chunk): the header row is found by name («Дата оплаты», «Группа», «Сумма», «№ счета») in the first 20 rows, the «Сумма заказа» line is the file's total (shown as a check), items of one invoice are added up into one payment, groups that are not ours are only reported. Only date / amount / group code / invoice number go to the backend — clients, INNs, products never leave the page. `importSales` **replaces every sale dated within the file's period** (first..last date of payment; hand-typed rows too) — the user chose "the file is the truth for its period" so re-importing never double-counts and cancellations disappear; a dry run first shows "now → after" per group, with warnings when a group would lose money. The sheet is rewritten with one `setValues` (kept + imported rows sorted by date, leftovers blanked; no row deletion), only the Date/Amount/ROP/Invoice cells change.

**Characters**: `config/characters.json` (id, Russian name, swatch colour, number of strike frames) is generated by `tools/build-characters.py` from `tools/characters.src.json` (7 base characters + colour variants made by turning the hue; skin tones can be protected). Textures are `char_<id>` (standing) and `char_<id>_hit1..N` (strike frames: four frames of the run cycle, or the real attack animation for Hooded Blade, then the blow frame — for run cycles the frame whose weapon reaches furthest forward). All frames of a hero are aligned on the feet and scaled together so swapping a frame never makes the hero jump; textures are drawn at `HERO.TEXTURE_SCALE` (0.75). `HeroSprite.playHit` shows the frames in order during the dash and the blow frame on arrival. **Living stand**: every hero also has `char_<id>_idle`, a spritesheet grid of 12 equal cells (the breathing loop, metadata `idle` in `characters.json`). Only ONE of the seven (six heroes, then the lead) breathes at a time: `systems/LiveStand.ts` gives each a turn of `IDLE_ANIM.TURN_MS` (40 s; ≈5 min per round) and passes it on, skipping a figure that is busy or asleep; its frames are stepped every `IDLE_ANIM.FRAME_MS` (100 ms) — only while it stands at ease (a strike, a fall or a doze shows the static standing frame). While someone breathes `PowerSaver` draws at the ambient rate (20 fps) via the `LIVE_STAND` event; the user asked for this because an all-at-once loop looked choppy at the 10 fps idle rate and loaded the laptops. The lead runs a few steps toward the heroes and back on every sale (`LeadSprite.playCheer`, run-cycle frames) and runs on the spot while the week is won. Don't hand-edit `public/assets/sprites/chars/` — rebuild.

**Render scale / text**: logical 1280×720, canvas buffer `GAME.RENDER_SCALE`× (per device, `core/Quality.ts`); every scene calls `fitCameraToGame(this)` first; every `add.text` needs `resolution: GAME.RENDER_SCALE`. All coordinates are logical.

**Performance**: the game runs on weak office laptops as an always-on display (`core/PowerSaver.ts`: active / ambient 20 fps / idle 10 fps). Don't add endless tweens or per-poll tweens for unchanged values; any new always-running animation costs battery. The breathing loop is a timer-driven frame swap of a single figure; while it runs the frame rate is the ambient 20 fps (the `LIVE_STAND` event), never more. URL overrides: `?quality=low|high`, `?scale=1.25`, `?fps=30`, `?idlefps=5`.

**Idle mood** (`systems/IdleMood.ts`): after an hour of game time without a sale a hero falls over or dozes, the dragon growls from time to time; any real sale wakes everyone. `?idle=<minutes>` shrinks the hour for demos.

**Admin + backend**: see `apps-script/README.md`. Animations are *commands* (stored in Script Properties, never in the sheet); `addSale` writes only the Date/Amount/ROP cells of the first free row; `importSales` replaces a period (above); the hero choice and the leaders' names live in Script Properties; wrong PINs lock the API for 10 minutes after 5 tries; polling copes with Apps Script's slow tail (30 s timeout, hedged second request after 6 s, "offline" only after 2 failed polls).

**Debug hooks** (`window.__debug`, dev builds only): `hit(slot, delta)`, `setRatio(0..1)`, `injectStatus(status)`, `poller.stop()` (call first when testing by hand), `power()`, `mood()`, `growl()`, `command(type, args)`, `roster({slot_1: 'ninja'})` (what a poll does when the admin picked other heroes; no argument = current choice).

## Backend / secrets

The admin PIN lives only in the Apps Script project's Script Properties (salted hash after the first change in the admin page) — never in this repo, docs, memory files or chat logs. The spreadsheet id lives only in Script Properties too (`SPREADSHEET_ID`, written by `setupSpreadsheet()`). The Web App URL in `game/public/config.json` is public by design: its GET serves only aggregates, animation commands, the hero choice and the leaders' short names (shown on the public stage anyway) — raw rows come only through PIN-gated `listSales`. Never commit a real CRM export: it holds clients' names and INNs (test with a synthetic file of the same layout).
**`config.json` must point at the Ulyanovsk backend** — leaving the Moscow URL there would show Moscow's numbers.
