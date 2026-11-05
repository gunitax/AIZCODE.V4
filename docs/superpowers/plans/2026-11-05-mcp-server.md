# MCP-сервер `objects` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Локальный MCP-сервер (stdio), открывающий ассистенту 5 инструментов над HTTP-сервисом объектов 1С: найти типы, описать тип, найти объекты, прочитать объект, создать объект.

**Architecture:** Тонкая обертка 1:1 над сервисом объектов (расширение `СчетаМагазина`). Слои: конфигурация (`OBJECTS_URL`/`OBJECTS_AUTH`, фолбэк на `src/tests/.env`) → HTTP-клиент с классификацией отказов → регистрация инструментов в MCP SDK. Сервер ничего не валидирует и не кэширует: один HTTP-вызов на вызов инструмента.

**Tech Stack:** Node.js 22 (type stripping включен по умолчанию), TypeScript, `@modelcontextprotocol/sdk` ^1.32.2 (транспорт stdio), `zod` для inputSchema, `esbuild` (сборка в один ESM-файл), встроенный `node:test` + `node:assert`.

**Spec:** [docs/superpowers/specs/2026-11-05-mcp-server-design.md](../specs/2026-11-05-mcp-server-design.md)

## Global Constraints

- Ветка `feat/mcp-server`, работа в `Q:\AIZCODE.V4` без worktree; коммит после каждой задачи.
- Файлы `mcp-server/**` и `.mcp.json` — UTF-8 **без BOM**, LF. Осознанное исключение из правила AGENTS.md: эти файлы не входят в выгрузку Конфигуратора, BOM в JSON-конфигах MCP может ломать парсеры. Файлы `docs/` и правки выгрузки 1С — по общему правилу (BOM+CRLF).
- Зависимости: только `@modelcontextprotocol/sdk` ^1.32.2 и `zod` ^3.25 (runtime); dev — `typescript` ^5, `esbuild` ^0.25, `@types/node` ^22. HTTP — глобальный `fetch`, других runtime-зависимостей нет.
- Таймаут HTTP — 30000 мс (`AbortController`); ретраев нет: повтор создания после потери ответа небезопасен (спека сервиса).
- Имена инструментов — snake_case ASCII; описания и тексты ошибок — на русском (без «ё»).
- Успех инструмента: `content:[{type:"text",text:JSON.stringify(data)}]`; отказ — тот же content + `isError:true`; данные сервиса проходят дословно, без обрезания и нормализации.
- `src/tests/.env` и секреты не коммитятся; `.mcp.json` и README — без значений секретов.
- Сервис объектов и расширение не меняются; сервер не проверяет обязательность/форматы сам.
- E2E создают объекты в живой базе — согласовано пользователем 2026-11-05 (спека, раздел «Тестовые данные»); удалять созданное нельзя (сервис не умеет), «чистить» базу иными способами запрещено.

## Review Focus

1. Повтор `create_object` после потери ответа создает дубль — сервер делает ровно один HTTP-вызов на вызов инструмента и не ретраит. Пин: Task 2 (счетчик вызовов fetch === 1 при любом исходе).
2. Две природы 403: JSON с `error.code` — отказ 1С; HTML/пустое тело — «Доступ запрещен: проверьте учетные данные сервиса». Пин: Task 2 (два теста).
3. Медленный сервис: ответ позже 30000 мс → «Сервис объектов недоступен», не зависание. Пин: Task 2 (тест с `timeoutMs: 20`).
4. Порча аргументов: `id` (UUID в нижнем регистре) и `q` (кириллица) передаются как есть, без нормализации и перекодирования. Пин: Task 2 (проверка построенного URL) и Task 5 (кириллица в ответах E2E).
5. Аргументы мимо схемы (`limit:0`, `id:123`) отклоняются валидацией MCP без HTTP-вызова. Пин: Task 3 (fetch не вызван).

---

### Task 1: Каркас проекта и конфигурация

**Files:**
- Create: `mcp-server/package.json`, `mcp-server/tsconfig.json`, `mcp-server/build.mjs`, `mcp-server/src/config.ts`, `mcp-server/test/unit/config.test.ts`
- Modify: `.gitignore` (корень) — добавить `mcp-server/node_modules/` и `mcp-server/build/`

**Interfaces:**
- Produces (используют Tasks 2, 4, 5):
  - `export interface Config { baseUrl: string; auth: string; }`
  - `export function readEnvFile(path: string): Record<string, string>` — строки `KEY=VALUE`, игнорировать пустые и начинающиеся с `#`, обрезать пробелы вокруг ключа и значения, снять одну пару кавычек `"…"`/`'…'` если значение в них заключено.
  - `export function resolveConfig(env: Record<string, string | undefined>, scriptUrl: string): Config` — порядок: `env.OBJECTS_URL`/`env.OBJECTS_AUTH`; иначе поиск `src/tests/.env` **вверх** по дереву от каталога `scriptUrl` до корня; `auth` — значение `OBJECTS_AUTH` как есть (оно уже содержит схему, напр. `Basic …`); ничего не найдено — `throw new Error` с текстом, называющим обе переменные и путь `src/tests/.env`.

- [ ] **Step 1: Инициализировать пакет и инструменты**

`mcp-server/package.json`:

```json
{
  "name": "objects-mcp",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test test/unit/",
    "test:e2e": "node --test test/e2e/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.2",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "esbuild": "^0.25.0",
    "typescript": "^5"
  }
}
```

`mcp-server/tsconfig.json`: `strict:true`, `target:"ES2022"`, `module:"ESNext"`, `moduleResolution:"bundler"`, `noEmit:true`, `allowImportingTsExtensions:true`, `types:["node"]`, `skipLibCheck:true`, `include:["src","test"]`.

`mcp-server/build.mjs`: `esbuild.build({ entryPoints:['src/main.ts'], bundle:true, platform:'node', target:'node22', format:'esm', outfile:'build/index.js' })`.

Run: `cd mcp-server && npm install` — ожидание: установилось без ошибок, `package-lock.json` создан (коммитится).

- [ ] **Step 2: Тесты конфигурации (сначала — падающие)**

`mcp-server/test/unit/config.test.ts`, runner `node:test` + `node:assert/strict`:

- `readEnvFile` — парсит `KEY=VALUE`, комментарии `#`, пробелы, кавычки `"Текст"` → `Текст`.
- `resolveConfig`: env-переменные имеют приоритет над `.env`; при пустом env конфиг берется из `.env`, найденного **вверх** от `scriptUrl` (в тесте — tmp-дерево `root/src/tests/.env` + `scriptUrl = root/mcp-server/build/index.js` через `pathToFileURL`); если ни env, ни файла — `assert.throws` с сообщением, содержащим `OBJECTS_URL` и `src/tests/.env`.
- `auth` проходит дословно: `OBJECTS_AUTH="Basic dXNlcjpwYXNz"` → `config.auth === 'Basic dXNlcjpwYXNz'`.

- [ ] **Step 3: Запустить, убедиться в падении**

Run: `npm test` — ожидание: FAIL, `config.ts` не существует.

- [ ] **Step 4: Реализовать `src/config.ts`**

Минимально по интерфейсу; поиск `.env` — цикл вверх по `dirname` от `new URL('.', scriptUrl)` (ограничение: до корня диска).

- [ ] **Step 5: Запустить тесты**

Run: `npm test` — ожидание: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/ .gitignore
git commit -m "mcp-server: каркас проекта и конфигурация (env + src/tests/.env)"
```

---

### Task 2: HTTP-клиент сервиса и классификация ошибок

**Files:**
- Create: `mcp-server/src/serviceClient.ts`, `mcp-server/test/unit/serviceClient.test.ts`

**Interfaces:**
- Consumes: `Config` из Task 1.
- Produces (используют Tasks 3, 5):

```ts
export type Failure =
  | { kind: 'refusal'; code: string; message: string; details: Array<{ path: string | null; message: string }> }
  | { kind: 'access_denied'; message: string }   // текст всегда: «Доступ запрещен: проверьте учетные данные сервиса»
  | { kind: 'unavailable'; message: string };    // текст всегда начинается: «Сервис объектов недоступен: …»
export type ServiceResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status?: number; failure: Failure };
export class ObjectsServiceClient {
  constructor(cfg: Config, options?: { timeoutMs?: number; fetchImpl?: typeof fetch });
  get(path: string, params: Record<string, string>): Promise<ServiceResult>;   // пустые значения параметров не передаются
  post(path: string, body: unknown): Promise<ServiceResult>;
  formatFailure(f: Failure): string;
}
```

Классификация (пин): сбой `fetch`/abort/таймаут → `unavailable`; тело с `error.code` (любой статус) → `refusal` (`code`, `message`, `details` как в ответе); статус 401/403 с телом **без** `error.code` (HTML/пусто) → `access_denied`; прочие тела без `error.code` → `unavailable` («…неожиданный ответ HTTP <status>»). Ровно один вызов `fetch`, без ретраев. `formatFailure` для `refusal`: `1С отклонила операцию (<code>): <message>`, затем по строке `\n- <path | (без поля)>: <detail.message>` на каждый элемент `details` (если непуст).

- [ ] **Step 1: Тесты на мок-`fetch` (сначала — падающие)**

`mcp-server/test/unit/serviceClient.test.ts` (все — через `fetchImpl`, реальной сети нет):

- 200 JSON → `ok:true`, `data` распарсен; `Authorization` = `config.auth` дословно; заголовок `Content-Type: application/json` только у POST; POST-тело — `JSON.stringify(body)` дословно.
- 422 с `{"error":{"code":"validation_failed","message":"…","details":[{"path":"header.Организация","message":"…"}]}}` → `refusal`, поля сохранены; `formatFailure` → текст содержит `1С отклонила операцию (validation_failed)`, `header.Организация` и текст сообщения.
- 400 `unknown_type` → `refusal`; 403 JSON `forbidden` → `refusal` (не `access_denied`).
- 403 с HTML-телом → `access_denied`; 401 пустое тело → `access_denied`.
- 500 HTML без `error.code` → `unavailable`, текст содержит `HTTP 500`.
- `fetch` отверг соединение → `unavailable`.
- Таймаут: `options.timeoutMs = 20`, `fetchImpl` висит 500 мс → `unavailable` (не исключение наружу), прошла <5 с.
- Ровно один вызов `fetch` на запрос при любом исходе (счетчик в моке).
- URL: `q='Альфа'` → закодирован в query; `id='9203492b-…'` в query дословно; пустой `limit:''` не попадает в query.

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `npm test` — ожидание: FAIL (модуля нет).

- [ ] **Step 3: Реализовать `src/serviceClient.ts`**

`AbortController` с таймаутом (по умолчанию 30000), `clearTimeout` в `finally`; парсинг тела — `res.json()` в `try` (HTML/пусто → считать телом без `error.code`).

- [ ] **Step 4: Запустить тесты**

Run: `npm test` — ожидание: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/serviceClient.ts mcp-server/test/unit/serviceClient.test.ts
git commit -m "mcp-server: HTTP-клиент сервиса объектов и классификация отказов"
```

---

### Task 3: MCP-сервер и пять инструментов

**Files:**
- Create: `mcp-server/src/tools.ts`, `mcp-server/src/index.ts`, `mcp-server/src/main.ts`, `mcp-server/test/unit/tools.test.ts`

**Interfaces:**
- Consumes: `ObjectsServiceClient` (Task 2), `Config`/`resolveConfig` (Task 1).
- Produces (использует Task 4):

```ts
// src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export function createServer(client: ObjectsServiceClient): McpServer; // name 'objects', registerTools внутри
// src/main.ts — точка сборки (entryPoints в build.mjs):
// resolveConfig(process.env, import.meta.url) → client → createServer → StdioServerTransport → connect;
// ошибка конфигурации: console.error(текст) + process.exitCode = 1, без стека.
```

Пять инструментов (имена/параметры фиксированы спекой):

| Имя | inputSchema (zod) | Вызов | annotations |
| --- | --- | --- | --- |
| `find_types` | `{ q: z.string().optional() }` | `get('/types', q? {q}:{})` | — |
| `describe_type` | `{ name: z.string() }` | `get('/type', { name })` | — |
| `find_objects` | `{ type: z.string(), q: z.string(), limit: z.number().int().min(1).max(100).optional() }` | `get('/search', { type, q, ...limit? })` | — |
| `read_object` | `{ type: z.string(), id: z.string() }` | `get('/object', { type, id })` | — |
| `create_object` | `{ type: z.string(), header: z.record(z.string(), z.unknown()), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }` | `post('/object', { type, header, tables })` | `{ readOnlyHint: false }` |

Описания инструментов — на русском, каждое называет действие, результат и когда вызывать; `create_object` — прямо: создает объект в базе (справочник или непроведенный документ), требует подтверждения менеджера, повтор после потери ответа создаст дубль. Результат обработчика: успех — `{content:[{type:'text',text:JSON.stringify(data)}]}`; отказ — тот же text из `formatFailure` + `isError:true`.

- [ ] **Step 1: Тесты через `InMemoryTransport` (сначала — падающие)**

`mcp-server/test/unit/tools.test.ts`: собрать `createServer` со стаб-клиентом (тот же интерфейс `get`/`post`, отдача заготовленных `ServiceResult`), подключить пару транспортов из `@modelcontextprotocol/sdk/inMemory.js`, клиентом `@modelcontextprotocol/sdk/client/index.js` вызвать:

- `tools/list` — ровно 5 имен; у `create_object` `annotations.readOnlyHint === false`, остальные — без аннотации изменяющего; описание `create_object` содержит «подтверждени» и «баз»; описания остальных содержат слово «сервис» или «базы».
- `tools/call find_types {q:'валют'}` (стаб `get` вернул `{types:[…]}`) → `isError` нет, `content[0].text === JSON.stringify({types:[…]})`; стаб получил `params` `{q:'валют'}`.
- `tools/call describe_type` при стабе-`refusal unknown_type` → `isError:true`, текст содержит `1С отклонила операцию (unknown_type)`.
- `tools/call find_objects {type:'X', q:'а', limit:0}` → ошибка валидации, стаб-клиент НЕ вызывался.
- `tools/call create_object` (стаб `post`) → стаб получил тело `{type, header, tables}` дословно; текст ответа = JSON ответа сервиса.
- `tools/call find_objects {…, limit:''}` — тоже ошибка валидации (не строка).

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `npm test` — ожидание: FAIL.

- [ ] **Step 3: Реализовать `tools.ts`, `index.ts`, `main.ts`**

`server.registerTool(имя, { description, inputSchema, annotations? }, handler)`; в `main.ts` — `resolveConfig`, при отсутствии конфига понятное сообщение в stderr (секреты не печатать).

- [ ] **Step 4: Запустить тесты**

Run: `npm test` — ожидание: PASS (все юнит-тесты Tasks 1–3).

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src mcp-server/test/unit/tools.test.ts
git commit -m "mcp-server: пять инструментов MCP, create_object помечен изменяющим"
```

---

### Task 4: Сборка, подключение к ZCode, README

**Files:**
- Create: `mcp-server/build/index.js` (артефакт сборки, не коммитится), `.mcp.json` (корень, коммитится), `mcp-server/README.md`, `mcp-server/test/e2e/local-stdio.test.ts`

**Interfaces:**
- Consumes: `createServer`/`main` (Task 3), сборка `build.mjs` (Task 1).
- Produces: рабочая точка запуска `node mcp-server/build/index.js`; проектная конфигурация MCP `.mcp.json` с сервером `objects`.

- [ ] **Step 1: Собрать и проверить артефакт**

Run: `npm run build` — ожидание: создан `build/index.js`.

- [ ] **Step 2: Локальный smoke — реальный stdio-процесс**

`mcp-server/test/e2e/local-stdio.test.ts`: через `StdioClientTransport` (SDK) запустить `node build/index.js` (cwd `mcp-server`), `initialize`, `tools/list` → 5 инструментов, закрыть транспорт. Тест требует `src/tests/.env` (сервер при старте читает конфиг); если конфига нет — тест `skip`.

Run: `npm run test:e2e` — ожидание: PASS.

- [ ] **Step 3: Подключение проекта ZCode**

`.mcp.json` в корне репозитория:

```json
{ "mcpServers": { "objects": { "command": "node", "args": ["mcp-server/build/index.js"] } } }
```

Проверка: `node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8'))"` — без ошибок; секретов в файле нет. Если формат не будет принят клиентом при приемке — запасной вариант `zcode mcp add objects -- node mcp-server/build/index.js` (отметить в README).

- [ ] **Step 4: README `mcp-server/README.md`**

Разделы: назначение (5 инструментов, изменяющий `create_object`), сборка (`npm install && npm run build`), подключение (`.mcp.json`, без секретов), конфигурация (`OBJECTS_URL`/`OBJECTS_AUTH`, фолбэк `src/tests/.env`), тесты (`npm test`, `npm run test:e2e` — E2E создает объекты в живой базе, согласовано).

- [ ] **Step 5: Commit**

```bash
git add .mcp.json mcp-server/README.md mcp-server/test/e2e/local-stdio.test.ts
git commit -m "mcp-server: сборка, подключение проекта ZCode (.mcp.json), README"
```

---

### Task 5: E2E на живом сервисе и финальная регрессия

**Files:**
- Create: `mcp-server/test/e2e/live.test.ts`

**Interfaces:**
- Consumes: `resolveConfig` (Task 1), `ObjectsServiceClient` (Task 2), `createServer` (Task 3) — реальный клиент поверх реального сервиса из `src/tests/.env`; стабов нет.

- [ ] **Step 1: E2E read-only на существующих демо-данных**

`mcp-server/test/e2e/live.test.ts`; конфига нет — все тесты `skip` (пометить в выводе):

- `find_types q='счет'` → `ok:true`; в `types` есть `Документ._ДемоСчетНаОплатуПокупателю`; у каждой записи поля `name`/`kind`/`title`/`creatable`; кириллица в `title` не искажена.
- `describe_type name='Документ._ДемоСчетНаОплатуПокупателю'` → поле `Дата`: `required:true`, `writable:true`; есть `tables` с `Товары`; у ссылочного поля в `types` есть запись с `searchUrl`.
- `find_objects type='Справочник._ДемоПартнеры' q='Альфа'` → `items` непустой; `id` — UUID в нижнем регистре; `hasMore` — boolean.
- `read_object` по `id` из предыдущего → `kind:'catalog'`, `header` — объект, `id` совпадает.

- [ ] **Step 2: E2E изменяющего пути и отказа (создает объект в живой базе — согласовано)**

- `create_object type='Справочник._ДемоПартнеры' header={Наименование:'MCP E2E <метка времени ISO>', ВидПартнера:'ЮридическоеЛицо'} tables={}` → `ok:true`, в `data` есть `id` и `code`; повторный запуск создает нового партнера — так и задумано.
- Отказ: `create_object type='Документ._ДемоСчетНаОплатуПокупателю'` с `Дата` и реквизитами из `src/tests/.env` (PARTNER_ID, COUNTERPARTY_ID, DEPARTMENT_ID, RESPONSIBLE_ID, CURRENCY_ID, PRODUCT_ID — как в `objects.http`, запрос 13), **без** `Организация` → `failure.kind === 'refusal'`, `code === 'validation_failed'`, среди `details` есть `path === 'header.Организация'`; `formatFailure` содержит текст проверки 1С.
- Недоступность: клиент с `baseUrl='http://127.0.0.1:9'` → `failure.kind === 'unavailable'`.

- [ ] **Step 3: Полная регрессия**

Run: `npm test && npm run test:e2e` — ожидание: PASS без пропусков (кроме skip при отсутствии `.env`).

- [ ] **Step 4: Commit**

```bash
git add mcp-server/test/e2e/live.test.ts
git commit -m "mcp-server: E2E на живом сервисе объектов (read-only, создание, отказы)"
```

---

## Приемка (после Task 5 — вручную пользователем)

1. Новый чат ZCode в проекте видит 5 инструментов сервера `objects`.
2. Контрольный пример словами: «выставь счет на оплату покупателю <имя> на <товар>» → ассистент находит тип, поля, подбирает ссылки поиском, создает счет, называет номер; документ в 1С непроведен.
3. Перед `create_object` клиент запросил подтверждение.
4. Отказ и недоступность различимы ассистентом (см. Task 5 сценарии).
