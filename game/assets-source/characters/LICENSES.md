# Источник героев

Спрайты героев — бесплатная библиотека **AutoSprite** (https://www.autosprite.io/free-sprite-sheets), лицензия **CC0 1.0**
(в каждом архиве есть `LICENSE.txt`: «можно использовать для чего угодно, включая коммерческие игры, без указания авторства
и разрешений; можно изменять и распространять; просим только не перепродавать как отдельный стоковый пак»).

Используются семь персонажей: Knight, Hooded Blade, Twin-Dagger Rogue, Arcane Mage, Forest Druid, Alchemist, Ninja
(листы `*-idle`, `*-run`, у Hooded Blade ещё `*-attack`). Остальные герои в игре — их перекрашенные варианты.
Архивы: `https://pub-63ab27389d044634a73e89c1a0c6d4a6.r2.dev/free-library/sprite-sheets/<key>/<key>.zip`
(см. `tools/characters.src.json`). Сами листы (по 2–5 МБ) в репозитории не хранятся — только готовые кадры героев
в `game/public/assets/sprites/chars/`, которые генерирует `tools/build-characters.py`.

Фон — см. `../scene/LICENSES.md`.
