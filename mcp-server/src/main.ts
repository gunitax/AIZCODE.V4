/**
 * Точка входа MCP-сервера «objects»: конфигурация подключения, клиент
 * HTTP-сервиса объектов, сервер с инструментами и stdio-транспорт.
 *
 * Любая ошибка старта печатается в stderr одной строкой (без стека и
 * секретов) и завершает процесс с кодом 1: ошибка конфигурации — своим
 * понятным сообщением из resolveConfig, остальные — общей строкой.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from './config.ts';
import { createServer } from './index.ts';
import { ObjectsServiceClient } from './serviceClient.ts';

async function main(): Promise<void> {
  let stage: 'config' | 'startup' = 'config';
  try {
    const config = resolveConfig(process.env, import.meta.url);
    stage = 'startup';
    const client = new ObjectsServiceClient(config);
    const server = createServer(client);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(
      stage === 'config'
        ? error instanceof Error
          ? error.message
          : String(error)
        : 'Ошибка запуска MCP-сервера «objects»',
    );
    process.exitCode = 1;
  }
}

await main();
