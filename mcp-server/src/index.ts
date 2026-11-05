/**
 * Сборка MCP-сервера «objects»: экземпляр McpServer SDK с пятью
 * инструментами над HTTP-сервисом объектов 1С.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ObjectsServiceClient } from './serviceClient.ts';
import { registerTools } from './tools.ts';

/** Создает MCP-сервер «objects» с инструментами над сервисом объектов 1С. */
export function createServer(client: ObjectsServiceClient): McpServer {
  const server = new McpServer({ name: 'objects', version: '0.1.0' });
  registerTools(server, client);
  return server;
}
