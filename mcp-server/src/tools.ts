/**
 * Пять инструментов MCP над HTTP-сервисом объектов 1С: поиск типов,
 * описание типа, поиск объектов, чтение объекта и создание объекта.
 *
 * Успешные данные сервиса возвращаются клиенту дословно текстом JSON,
 * отказ сервиса — текстом client.formatFailure с isError: true.
 * Протокольные ошибки MCP для отказов сервиса не применяются.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ObjectsServiceClient, ServiceResult } from './serviceClient.ts';

/** Приводит результат сервиса к результату вызова инструмента MCP. */
async function toToolResult(
  client: ObjectsServiceClient,
  call: () => Promise<ServiceResult>,
): Promise<CallToolResult> {
  const result = await call();
  if (result.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  }
  return { content: [{ type: 'text', text: client.formatFailure(result.failure) }], isError: true };
}

/** Регистрирует пять инструментов поиска, чтения и создания объектов 1С. */
export function registerTools(server: McpServer, client: ObjectsServiceClient): void {
  server.registerTool(
    'find_types',
    {
      description:
        'Ищет типы объектов базы 1С по части названия и возвращает JSON-список с полями name, kind, title, creatable. ' +
        'Вызывайте первым, чтобы узнать точное имя типа, например Справочник.Валюты или Документ._ДемоСчетНаОплатуПокупателю, ' +
        'перед поиском и чтением объектов.',
      inputSchema: { q: z.string().optional() },
    },
    (args) => toToolResult(client, () => client.get('/types', args.q !== undefined ? { q: args.q } : {})),
  );
  server.registerTool(
    'describe_type',
    {
      description:
        'Возвращает из сервиса объектов 1С описание типа: реквизиты шапки, табличные части и их колонки в JSON. ' +
        'Вызывайте перед create_object, чтобы узнать точные имена полей; name — имя типа, как его вернул find_types.',
      inputSchema: { name: z.string() },
    },
    (args) => toToolResult(client, () => client.get('/type', { name: args.name })),
  );
  server.registerTool(
    'find_objects',
    {
      description:
        'Ищет объекты базы 1С заданного типа по подстроке названия и возвращает JSON со списком объектов ' +
        'и их идентификаторами id. type — имя типа из find_types, q — поисковая строка, ' +
        'limit — необязательный лимит выборки от 1 до 100.',
      inputSchema: {
        type: z.string(),
        q: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    (args) => {
      const params: Record<string, string> = { type: args.type, q: args.q };
      if (args.limit !== undefined) {
        params.limit = String(args.limit);
      }
      return toToolResult(client, () => client.get('/search', params));
    },
  );
  server.registerTool(
    'read_object',
    {
      description:
        'Читает объект базы 1С целиком и возвращает JSON: шапка (header) и табличные части (tables). ' +
        'type — имя типа из find_types, id — UUID объекта в нижнем регистре, ' +
        'например 9203492b-ea3e-11de-8634-001d600d9ad2, из результата find_objects.',
      inputSchema: { type: z.string(), id: z.string() },
    },
    (args) => toToolResult(client, () => client.get('/object', { type: args.type, id: args.id })),
  );
  server.registerTool(
    'create_object',
    {
      description:
        'Создает объект в базе 1С: справочник или непроведенный документ. ' +
        'type — имя типа, header — поля шапки, tables — строки табличных частей; ' +
        'точные имена полей смотрите через describe_type. ' +
        'Операция изменяет базу и требует подтверждения менеджера: ' +
        'повторный вызов после потери ответа создаст дубль объекта.',
      inputSchema: {
        type: z.string(),
        header: z.record(z.string(), z.unknown()),
        tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
      },
      annotations: { readOnlyHint: false },
    },
    (args) =>
      toToolResult(client, () =>
        client.post('/object', { type: args.type, header: args.header, tables: args.tables }),
      ),
  );
}
