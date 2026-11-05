/**
 * Тесты пяти инструментов MCP: список инструментов, передача параметров
 * в клиент сервиса и приведение результатов сервиса к результату вызова.
 *
 * Вызовы идут через настоящий McpServer и SDK-клиент по паре
 * InMemory-транспортов; клиент сервиса заменяется заглушкой.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/index.ts';
import { ObjectsServiceClient, type Failure, type ServiceResult } from '../../src/serviceClient.ts';

interface StubState {
  gets: Array<{ path: string; params: Record<string, string> }>;
  posts: Array<{ path: string; body: unknown }>;
}

/** Создает заглушку клиента сервиса: записывает вызовы и возвращает заготовленные результаты. */
function stubClient(overrides?: { get?: ServiceResult; post?: ServiceResult }): { stub: ObjectsServiceClient } & StubState {
  const real = new ObjectsServiceClient({ baseUrl: 'http://localhost/demo/hs/objects', auth: 'Basic dGVzdDp0ZXN0' });
  const state: StubState = { gets: [], posts: [] };
  const stub = {
    get: async (path: string, params: Record<string, string>): Promise<ServiceResult> => {
      state.gets.push({ path, params });
      return overrides?.get ?? { ok: true, status: 200, data: {} };
    },
    post: async (path: string, body: unknown): Promise<ServiceResult> => {
      state.posts.push({ path, body });
      return overrides?.post ?? { ok: true, status: 200, data: {} };
    },
    formatFailure: (failure: Failure): string => real.formatFailure(failure),
  };
  return { stub: stub as unknown as ObjectsServiceClient, ...state };
}

/** Подключает SDK-клиент к серверу через пару InMemory-транспортов. */
async function connectClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Возвращает текст первого блока content результата вызова инструмента. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const block = content?.[0];
  assert.ok(block !== undefined, 'content не должен быть пустым');
  assert.equal(block.type, 'text');
  if (block.type !== 'text' || typeof block.text !== 'string') {
    assert.fail('первый блок content должен быть текстом');
  }
  return block.text;
}

test('tools/list: ровно пять инструментов, аннотации и русские описания', async () => {
  const { stub } = stubClient();
  const client = await connectClient(createServer(stub));
  const list = await client.listTools();
  assert.deepEqual(
    list.tools.map((tool) => tool.name).sort(),
    ['create_object', 'describe_type', 'find_objects', 'find_types', 'read_object'],
  );
  const byName = new Map(list.tools.map((tool) => [tool.name, tool]));
  const create = byName.get('create_object');
  assert.ok(create !== undefined, 'create_object должен быть в списке');
  assert.equal(create.annotations?.readOnlyHint, false, 'create_object помечается изменяющим');
  const createDescription = create.description ?? '';
  assert.ok(createDescription.includes('подтверждени'), 'create_object требует подтверждения менеджера');
  assert.ok(createDescription.includes('баз'), 'create_object называет базу');
  assert.ok(/справочник|документ/.test(createDescription), 'create_object называет вид создаваемых объектов');
  assert.ok(createDescription.includes('дубл'), 'create_object предупреждает о дубле при повторе');
  assert.ok(/[А-Яа-я]/.test(createDescription), 'описание create_object на русском');
  for (const name of ['find_types', 'describe_type', 'find_objects', 'read_object']) {
    const tool = byName.get(name);
    assert.ok(tool !== undefined, `${name} должен быть в списке`);
    assert.notEqual(tool.annotations?.readOnlyHint, false, `${name} не помечается изменяющим`);
    const description = tool.description ?? '';
    assert.ok(description.length > 0, `${name}: описание не пустое`);
    assert.ok(/сервис|базы/.test(description), `${name}: описание называет сервис или базу`);
    assert.ok(/[А-Яа-я]/.test(description), `${name}: описание на русском`);
  }
});

test('find_types: передает q в сервис и возвращает данные дословно', async () => {
  const data = { types: [{ name: 'Справочник.Валюты', kind: 'catalog', title: 'Валюты', creatable: true }] };
  const { stub, gets } = stubClient({ get: { ok: true, status: 200, data } });
  const client = await connectClient(createServer(stub));
  const result = await client.callTool({ name: 'find_types', arguments: { q: 'валют' } });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), JSON.stringify(data));
  assert.equal(gets.length, 1);
  assert.equal(gets[0].path, '/types');
  assert.deepEqual(gets[0].params, { q: 'валют' });
});

test('describe_type: отказ сервиса приходит текстом с isError, без протокольной ошибки', async () => {
  const { stub } = stubClient({
    get: { ok: false, failure: { kind: 'refusal', code: 'unknown_type', message: 'Тип не найден', details: [] } },
  });
  const client = await connectClient(createServer(stub));
  const result = await client.callTool({ name: 'describe_type', arguments: { name: 'X' } });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.ok(text.includes('1С отклонила операцию (unknown_type)'));
  assert.ok(text.includes('Тип не найден'));
});

test('find_objects: limit=0 отклоняется схемой, сервис не вызывается', async () => {
  const { stub, gets } = stubClient();
  const client = await connectClient(createServer(stub));
  // SDK 1.32.2 возвращает ошибку валидации как результат с isError, не как протокольную ошибку.
  const result = await client.callTool({ name: 'find_objects', arguments: { type: 'X', q: 'а', limit: 0 } });
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes('Input validation error'));
  assert.equal(gets.length, 0);
});

test('find_objects: limit строкой отклоняется схемой, сервис не вызывается', async () => {
  const { stub, gets } = stubClient();
  const client = await connectClient(createServer(stub));
  const result = await client.callTool({ name: 'find_objects', arguments: { type: 'X', q: 'а', limit: '' } });
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes('Input validation error'));
  assert.equal(gets.length, 0);
});

test('find_objects: limit передается строкой, без limit параметр не передается', async () => {
  const { stub, gets } = stubClient();
  const client = await connectClient(createServer(stub));
  await client.callTool({ name: 'find_objects', arguments: { type: 'Справочник.Валюты', q: 'вал', limit: 25 } });
  assert.equal(gets.length, 1);
  assert.equal(gets[0].path, '/search');
  assert.deepEqual(gets[0].params, { type: 'Справочник.Валюты', q: 'вал', limit: '25' });
  await client.callTool({ name: 'find_objects', arguments: { type: 'Справочник.Валюты', q: 'вал' } });
  assert.equal(gets.length, 2);
  assert.deepEqual(gets[1].params, { type: 'Справочник.Валюты', q: 'вал' });
});

test('create_object: передает шапку и таблицы дословно и возвращает id созданного', async () => {
  const { stub, posts } = stubClient({ post: { ok: true, status: 201, data: { id: 'abc' } } });
  const client = await connectClient(createServer(stub));
  const arguments_ = {
    type: 'Документ._ДемоСчетНаОплатуПокупателю',
    header: { Дата: '2026-01-01T00:00:00' },
    tables: { Товары: [{ Номенклатура: 'x' }] },
  };
  const result = await client.callTool({ name: 'create_object', arguments: arguments_ });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), JSON.stringify({ id: 'abc' }));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/object');
  assert.deepEqual(posts[0].body, { type: arguments_.type, header: arguments_.header, tables: arguments_.tables });
});

test('read_object: передает type и id дословно', async () => {
  const { stub, gets } = stubClient();
  const client = await connectClient(createServer(stub));
  const result = await client.callTool({
    name: 'read_object',
    arguments: { type: 'Справочник._ДемоПартнеры', id: '9203492b-ea3e-11de-8634-001d600d9ad2' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(gets.length, 1);
  assert.equal(gets[0].path, '/object');
  assert.deepEqual(gets[0].params, { type: 'Справочник._ДемоПартнеры', id: '9203492b-ea3e-11de-8634-001d600d9ad2' });
});
