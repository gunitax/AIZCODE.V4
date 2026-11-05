/**
 * Локальный smoke-тест MCP-сервера «objects»: собранный build/index.js
 * запускается как реальный дочерний процесс, MCP-клиент SDK подключается
 * к нему по stdio и проверяет список инструментов.
 *
 * Живой HTTP-сервис 1С не вызывается — проверяются старт сервера
 * (включая поиск конфигурации) и протокол MCP. Если конфигурация
 * недоступна (нет OBJECTS_URL/OBJECTS_AUTH в окружении и не найден
 * src/tests/.env поиском вверх от каталога теста), все проверки
 * пропускаются с понятной пометкой.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findDotEnvPath } from '../../src/config.ts';

/** Каталог этого теста: mcp-server/test/e2e. */
const testDir = dirname(fileURLToPath(import.meta.url));
/** Корень проекта mcp-server — рабочая папка дочернего процесса. */
const mcpServerDir = join(testDir, '..', '..');
/** Абсолютный путь к собранной точке входа mcp-server/build/index.js. */
const scriptPath = join(mcpServerDir, 'build', 'index.js');

/**
 * Конфигурация считается доступной, если переменные окружения
 * OBJECTS_URL и OBJECTS_AUTH заданы (они передаются дочернему процессу)
 * или поиском вверх от каталога теста найден src/tests/.env — тот же
 * механизм, которым пользуется сам сервер.
 */
const configAvailable =
  (process.env.OBJECTS_URL !== undefined && process.env.OBJECTS_AUTH !== undefined) ||
  findDotEnvPath(import.meta.url) !== undefined;

const skipReason = configAvailable
  ? false
  : 'Конфигурация недоступна: нет OBJECTS_URL/OBJECTS_AUTH в окружении и не найден src/tests/.env';

/** Гоняет обещание с таймером: rejects, если операция не уложилась в ms. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Превышено время ожидания (${ms} мс): ${what}`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const expectedToolNames = [
  'create_object',
  'describe_type',
  'find_objects',
  'find_types',
  'read_object',
];

test(
  'local-stdio: собранный build/index.js запускается и отдает пять инструментов',
  { timeout: 60_000, skip: skipReason },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [scriptPath],
      cwd: mcpServerDir,
      env: { ...process.env },
    });
    const client = new Client({ name: 'objects-smoke', version: '0.1.0' });
    try {
      // connect выполняет рукопожатие initialize, включая старт процесса.
      await withTimeout(client.connect(transport), 20_000, 'connect');
      const { tools } = await withTimeout(client.listTools(), 10_000, 'listTools');

      assert.equal(tools.length, 5, 'Ожидалось ровно пять инструментов');
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        expectedToolNames,
      );

      const createObject = tools.find((tool) => tool.name === 'create_object');
      assert.ok(createObject, 'Инструмент create_object не найден');
      assert.equal(createObject.annotations?.readOnlyHint, false);
    } finally {
      // Закрываем транспорт: дочерний процесс завершается вместе с ним.
      await transport.close();
    }
  },
);
