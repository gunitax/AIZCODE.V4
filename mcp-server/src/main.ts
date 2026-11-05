/**
 * Точка входа MCP-сервера «objects»: конфигурация подключения, клиент
 * HTTP-сервиса объектов, сервер с инструментами и stdio-транспорт.
 *
 * Ошибка конфигурации печатается в stderr одним понятным сообщением
 * (без секретов и стека) и завершает процесс с кодом 1.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig, type Config } from './config.ts';
import { createServer } from './index.ts';
import { ObjectsServiceClient } from './serviceClient.ts';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = resolveConfig(process.env, import.meta.url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const client = new ObjectsServiceClient(config);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

await main();
