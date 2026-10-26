# jqc

> jq for JSONC/JSON5 configs · сохраняет комментарии там, где jq их теряет

**jqc** — консольная утилита для работы с JSON, JSONC и JSON5-файлами.
Сохраняет комментарии и форматирование при редактировании и использует
настоящий `jq` для запросов — не самодельный язык, а то, что вы уже знаете.

Репозиторий: <https://github.com/iampelixm/jqc>

## Философия

- **Запросы → `jq`**. `jqc '.scripts.build'` просто зовёт настоящий `jq`,
  передавая ему нормализованный вход (комментарии и trailing-commas
  маскируются, а не вырезаются, чтобы номера строк не съезжали).
- **Правки → своя CST**. `jqc set .compilerOptions.target ES2023 file -w`
  меняет одно значение, не трогая комментарии, порядок ключей и отступы.
- **Автоопределение формата**. JSON, JSONC, JSON5, NDJSON — один и тот же
  инструмент.

## Установка

```bash
# из клонированного репозитория
npm install -g .

# или глобальная ссылка (для разработки)
npm link

# зависимости: jq (для режима запросов)
brew install jq   # macOS
```

## Использование

### Запросы (любой jq-код)

```bash
jqc '.scripts.build' tsconfig.jsonc
jqc -r '.compilerOptions.paths[$key][0]' --arg key '@app/*' tsconfig.jsonc
jqc -s -c '[.scripts]' tsconfig.jsonc
# всё, что умеет jq, просачивается насквозь
```

### Редактирование с сохранением комментариев

```bash
# изменить значение
jqc set .compilerOptions.target ES2023 tsconfig.jsonc -w

# добавить новое поле
jqc set .compilerOptions.paths '"@ui/*"' '["src/ui/*"]' tsconfig.jsonc -w

# удалить поле
jqc del .exclude tsconfig.jsonc -w

# прочитать с raw-выводом
jqc get .name --raw config.jsonc
```

### Другие команды

```bash
jqc validate config.jsonc          # проверка синтаксиса
jqc fmt config.jsonc -w             # переформатировать
jqc fmt --check config.jsonc        # exit 1 если не отформатирован
jqc fmt --keep-lines config.jsonc   # только выровнять отступы

jqc convert config.json --to json5   # конвертация
jqc convert config.json --to ndjson

jqc merge base.jsonc overlay.json  # глубокое слияние, комментарии из base

jqc diff a.json b.json --exit-code  # структурный diff
```

### NDJSON

```bash
# чтение
jqc -c '[length]' data.ndjson

# конвертация
jqc convert data.json --to ndjson > data.ndjson
jqc convert data.ndjson --to json > data.json
```

## Формат путей

```
jqc set .a.b        "$.a.b" или "a.b"   — объектная навигация
jqc set 'a[0].b'                         — индекс в массиве
jqc set 'a[-1]'                          — последний элемент
jqc set 'a["key with spaces"]'           — ключ с пробелами
jqc set 'a."key with spaces"'            — то же (jsonc-style)
```

Значение `set` сначала парсится как JSON; если не получается —
используется как строка. Принудительно: `--string` или `--json`.

## Термины (может пригодиться)

| Термин | Что это |
|---|---|
| JSONC | JSON с комментариями (`//`, `/* */`) и trailing-commas — tsconfig.json, devcontainer.json, VS Code settings |
| JSON5 | JSON для людей: однострочные комментарии, unquoted keys, single quotes, `+Infinity`, hex-числа |
| NDJSON | по одному JSON-значению на строку — log-файлы, stream-данные |

## Лицензия

MIT