# Отрисовка персонажей из 3D-пакета в 2D-кадры

Игровые спрайты персонажей (`game/public/assets/sprites/chars/`) — это снимки сбоку (в три четверти) анимированных
моделей **Quaternius «Ultimate Animated Character Pack»** (CC0, https://opengameart.org/content/animated-characters-pack).
Сами модели в репозитории не хранятся (48 МБ) — их достаточно скачать заново, если нужно перерисовать.

1. Скачать и распаковать пакет; папка с `FBX/` внутри — это `QUATERNIUS_DIR`.
2. `npm i three@0.170.0` в этой папке.
3. `QUATERNIUS_DIR=<папка> RENDER_OUT=<куда класть PNG> node server.mjs`, открыть http://localhost:8090 в браузере.
4. В консоли страницы выполнить содержимое `batch.js` (рисует стойку + 3 кадра удара каждого из 30 героев, 1024×1024).
5. `python tools/build-characters.py <RENDER_OUT>` — обрезает, выравнивает по ногам, приводит к одному росту и пишет
   спрайты и `src/game/config/characters.json`.

Состав и русские названия — `characters.src.json`.
