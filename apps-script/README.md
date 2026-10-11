# Бэкенд на Google Apps Script («Победи дракона», Ульяновск)

Standalone-проект (не привязан к таблице через Extensions-меню). Таблицу «победи дракона» создаёт сам скрипт, её id хранится в Script Properties — в исходнике его нет.

## Первый запуск

1. [script.google.com/home](https://script.google.com/home) → **Новый проект** (рекомендуемое имя «Победи дракона backend»), вставить `Code.gs` целиком.
2. В выпадающем списке функций выбрать **`setupSpreadsheet`** → **Выполнить** (Google один раз попросит доступ). Функция создаёт таблицу «победи дракона» в Диске владельца: лист `Sales` (`Date | Amount | ROP`, у `ROP` — выпадающий список из шести групп) и лист `Settings` (`WeeklyPlan`, `TotalMeters`); id пишет в Script Properties. Повторный запуск ничего не делает.
3. **Параметры проекта (⚙) → Свойства скрипта → Добавить свойство** `ADMIN_PIN` = ваш PIN (цифры). После первой смены PIN из админки (вкладка «PIN-код») открытое свойство удаляется, остаётся только солёный хеш.
4. **Начать развертывание → Новое развертывание → Веб-приложение**: Выполнять от имени **меня**, доступ — **все**. Скопировать URL вида `https://script.google.com/macros/s/XXXX/exec` в `game/public/config.json` (`appsScriptUrl`, `"useMock": false`).
5. Любая правка `Code.gs` → **Управление развертываниями → ✏️ → Версия: Новая версия → Развернуть** (URL не меняется). Прежняя версия остаётся в списке — откат тем же диалогом.
6. Плана ещё нет (`WeeklyPlan = 0`): задайте его в админке, вкладка «План».

Проверка: открыть `/exec` в браузере — JSON без окна входа Google (поля `byRop`, `commands`, `roster`, `serverNow`).

## API

Один URL. `GET` — публичный, только агрегаты (итоги недели, разбивка по группам), свежие «команды анимаций» и выбор героев. `POST` (тело JSON, отправляется как `text/plain` — без CORS-preflight) — все действия требуют PIN в теле (не в URL):

| `action` | Параметры | Что делает |
|---|---|---|
| `login` | `pin` | проверяет PIN |
| `setPlan` | `pin, plan` | недельный план |
| `listSales` | `pin, limit?` (до 200) | последние непустые строки «Sales» (новые сверху) + итоги недели + план |
| `addSale` | `pin, rop, amount, date?, requestId?` | пишет оплату в первую свободную строку после последней продажи (только ячейки Date/Amount/ROP). Реальная оплата — герои на экранах ударят |
| `changePin` | `pin, newPin` | меняет PIN (4–12 цифр), хранится хешем `salt$sha256` |
| `command` | `pin, type, args?, requestId?` | анимация на экранах: `hit {rop, amount}`, `fall {hero: random\|slot_1…slot_6, mode}`, `wake`, `growl`, `confetti`, `celebrate`. В таблицу не пишется |
| `setRoster` | `pin, roster` | кто стоит в слотах (`slot_1…slot_6`, `lead`): `{slot_1: 'viking', lead: 'businesswoman'}`; меняются только присланные слоты. В таблицу не пишется |

Ответ — `{ok: true, …}` или `{ok: false, error}`: `invalid_pin`, `locked` (+`retryAfterSec`), `bad_request` (+`field`), `server_error` (+`detail`). После 5 неверных PIN за 10 минут API блокируется на 10 минут.

## Проверка без деплоя

```bash
cd game
npm run test:backend      # 27 тестов: PIN, блокировка, addSale, listSales, changePin, команды, выбор героев
npm run mock-backend      # тот же Code.gs на http://localhost:8787/exec (PIN 1234, данные в памяти)
```

Dev-сборка игры и админки направляется на мок параметром `?backend=http://localhost:8787/exec`.
