/**
 * Конфигурация MCP-сервера «objects»: адрес HTTP-сервиса объектов 1С
 * и строка авторизации.
 *
 * Источники в порядке приоритета: переменные окружения OBJECTS_URL и
 * OBJECTS_AUTH, затем файл src/tests/.env, найденный поиском вверх
 * по дереву каталогов от каталога файла скрипта.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  baseUrl: string;
  auth: string;
}

/** Снимает одну пару кавычек `"…"` / `'…'`, если значение в них заключено. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Читает файл `.env`: строки `KEY=VALUE`; пустые строки и строки,
 * начинающиеся с `#`, игнорируются; пробелы вокруг ключа и значения
 * обрезаются; одна пара кавычек `"…"` / `'…'` снимается.
 */
export function readEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = stripQuotes(trimmed.slice(separator + 1).trim());
    result[key] = value;
  }
  return result;
}

/**
 * Ищет `src/tests/.env` вверх по дереву каталогов от каталога `scriptUrl`
 * (строка-URL вида file:///…) до корня диска. Возвращает путь к найденному
 * файлу или undefined.
 */
export function findDotEnvPath(scriptUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(scriptUrl));
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, 'src', 'tests', '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dir === root) {
      return undefined;
    }
    dir = dirname(dir);
  }
}

/**
 * Определяет конфигурацию подключения: переменные окружения
 * `OBJECTS_URL` и `OBJECTS_AUTH` имеют приоритет, недостающие значения
 * берутся из `.env`, найденного через findDotEnvPath. `auth` используется
 * как есть (строка уже содержит схему, например `Basic …`).
 * Если ни переменные, ни файл не найдены — бросает ошибку.
 */
export function resolveConfig(env: Record<string, string | undefined>, scriptUrl: string): Config {
  let baseUrl = env.OBJECTS_URL;
  let auth = env.OBJECTS_AUTH;
  if (baseUrl === undefined || auth === undefined) {
    const dotenvPath = findDotEnvPath(scriptUrl);
    if (dotenvPath !== undefined) {
      const file = readEnvFile(dotenvPath);
      baseUrl ??= file.OBJECTS_URL;
      auth ??= file.OBJECTS_AUTH;
    }
  }
  if (baseUrl === undefined || auth === undefined) {
    throw new Error(
      'Конфигурация подключения не задана: укажите переменные окружения OBJECTS_URL ' +
        'и OBJECTS_AUTH или создайте файл src/tests/.env со строками ' +
        'OBJECTS_URL=... и OBJECTS_AUTH=...',
    );
  }
  return { baseUrl, auth };
}
