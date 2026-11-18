# XD Lite

**EN.** A single-file, zero-dependency review viewer for coding agents: show the diff
in a browser, collect Task/Comment feedback from a human, hand it back to the agent.
One file (`xd-lite.js`), only Node ≥ 20 + git, macOS / Linux / Windows. No build,
no React, no npm dependencies.

```bash
npm install -g github:kudiiarov/xd-lite   # → "xd-lite" on your PATH
xd-lite ~/my-project --wait               # agent hook: blocks until review is sent
```

Full docs below (in Russian). Quick facts: `--wait` prints `REVIEW_FILE=<path>` and
exits 0 after the human clicks "Send review to agent"; `--fail-on-open` exits 2 while
open tasks remain (a PreToolUse hook can block `git push`); `--timeout MINUTES` stops
the wait. Comments are stored as `<repo>/.xd/threads/*.md` — plain markdown, readable
by humans, agents and MCP tools.

---

**RU.** Однофайловый лёгкий ревьюер для агентов: показать дифф, собрать замечания,
отдать их агенту. Часть проекта [XD](https://github.com/kudiiarov) — полноценной
версии с MCP-тулами и live-обновлениями; Lite — минимум для хуков «перед push».

```bash
xd-lite . --wait                       # хук: показать diff, собрать замечания
xd-lite . --vs origin/main --wait      # «что уйдёт в push»
xd-lite .                              # просто окно ревью (не блокируется)
```

## Как это работает (`--wait`)

1. Агент запускает `xd-lite . --wait` — открывается браузер, процесс блокируется.
2. Человек смотрит дифф (дерево файлов, Unified/Split, раскрытие контекста,
   подсветка) и оставляет замечания двух типов: **Task** (чекбокс: агент чинит
   и отмечает) и **Comment**.
3. Клик «Send review to agent» → процесс пишет review-маркдаун, печатает
   `REVIEW_FILE=<path>` и завершается с кодом 0 — агент продолжает работу.

Замечания хранятся в `<repo>/.xd/threads/*.md` — человекочитаемый маркдаун
(YAML frontmatter + тело), тот же формат, что и в полной версии XD: файлы можно
править руками, читать скриптами, скармливать MCP-тулам.

## Установка

**Глобально из GitHub** (на Windows npm создаёт `.cmd`-шим автоматически):

```bash
npm install -g github:kudiiarov/xd-lite
xd-lite --help
```

**Без установки — просто скопировать файл.** `xd-lite.js` самодостаточен:

```bash
curl -O https://raw.githubusercontent.com/kudiiarov/xd-lite/main/xd-lite.js
node xd-lite.js ~/my-project --wait
```

## Флаги и контракт

```
xd-lite [path] [--wait] [--fail-on-open] [--timeout MINUTES] [--out FILE]
        [--vs REF] [--source working|staged|head] [--port N] [--no-open] [--author NAME]
```

| Флаг | Зачем |
| --- | --- |
| `--wait` | блокирует процесс до клика «Send review to agent» |
| `--fail-on-open` | с `--wait`: открытые треды → **exit 2** и `REVIEW_FILE=` в stderr |
| `--timeout MINUTES` | с `--wait`: не висеть вечно, собрать текущее по истечении N минут |
| `--out FILE` | куда писать review-маркдаун (`<repo>/.xd/review-<ts>.md` по умолчанию) |
| `--vs REF` / `--source working\|staged\|head` | какой дифф показывать |
| `--no-open` | не открывать браузер (headless) — URL печатается в stdout |
| `--port N` | фиксировать порт (по умолчанию OS-assigned) |

Контракт: `REVIEW_FILE=<path>` в stdout; exit `0` — ревью собрано, exit `2` —
`--fail-on-open` и остались открытые задачи.

## Подключение к агенту (Claude Code и не только)

**Строчка в инструкции агенту** (AGENTS.md целевого репо):

```markdown
Перед `git push` запусти `xd-lite . --wait`, прочитай файл из строки
REVIEW_FILE= и отработай все открытые задачи, затем повтори push.
```

**Блокирующий хук на `git push`** (Claude Code, `~/.zcode/cli/config.json` или
настройки хуков вашего харнеса): человек отправляет ревью — если задачи остались,
push блокируется (exit 2), агент чинит и пушит снова:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["~/.zcode/hooks/xd-lite-push-guard.mjs"],
              "timeoutMs": 1200000
            }
          ]
        }
      ]
    }
  }
}
```

Пример скрипта-гарда — [`hooks/xd-lite-push-guard.mjs`](hooks/xd-lite-push-guard.mjs)
в этом репо (не пуш-команда → мгновенный exit 0; push → окно ревью; открытые
задачи → exit 2; `--no-verify` в команде — осознанный обход). Для PreToolUse-хуков
через `command`+shell используйте `--fail-on-open` напрямую.

## Windows

- Node ≥ 20 и Git for Windows (git в PATH).
- Браузер открывается через `rundll32 url.dll,FileProtocolHandler`.
- npm-глобал создаёт `xd-lite.cmd` — работает в cmd/PowerShell/Git Bash.
- Остановка фонового процесса: `taskkill /F /IM node.exe` (или точечно по PID).

## Формат замечаний

Каждое замечание — файл `<repo>/.xd/threads/<ulid>.md`:

```markdown
---
id: <ulid>
file: path/relative/to/repo
status: open            # open | resolved
category: request-changes   # request-changes (Task) | comment | question
author: 'human:me'
created_at: '2026-11-18T12:00:00.000Z'
anchor:
  ref: working
  blob_sha: <git blob sha>
  lines: [15, 16]
---
Текст замечания в markdown.
```

Агент чинит код и ставит `status: resolved` (галочка задачи) — или отвечает
блоком `--- / author: / at: / ---`. Больше возможностей (MCP-тулы, live-обновления,
несколько worktree) — в полной версии XD.

## Разработка

```bash
npm test            # node --test; на CI гоняется на ubuntu + macos + windows
```

Тесты спавнят реальный CLI и проверяют весь контракт: дифф, CRUD замечаний,
exit-коды хуков, формат файлов. Тесты кросс-формата с полным XD (`@xd/core`)
активируются автоматически, если пакет доступен (в монорепо XD).

## License

[MIT](LICENSE)
