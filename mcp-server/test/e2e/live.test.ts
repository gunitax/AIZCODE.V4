/**
 * E2E-тесты пяти инструментов над живым HTTP-сервисом объектов 1С:
 * реальные HTTP-запросы через ObjectsServiceClient, стабов нет.
 *
 * Сценарии: поиск типов, описание типа, поиск объектов, чтение объекта,
 * создание партнера с уникальным наименованием, отказ штатной проверки 1С
 * при пропущенной обязательной Организации и недоступность сервиса
 * (закрытый локальный порт).
 *
 * Создание объекта оставляет его в живой демо-базе: сервис объектов не
 * умеет удалять, такие запросы при разработке согласованы пользователем
 * 2026-11-05; объем — один справочник за прогон, метка времени в
 * наименовании делает его уникальным и находимым поиском.
 *
 * Конфигурация: переменные окружения OBJECTS_URL и OBJECTS_AUTH либо файл
 * src/tests/.env, найденный поиском вверх от каталога теста; контрольные
 * идентификаторы демо-данных читаются из того же источника. Значения
 * учетных данных и идентификаторов ни в каких сообщениях тестов не
 * печатаются — только имена ключей. Если конфигурация недоступна (нет
 * переменных и не найден файл), все проверки пропускаются с понятной
 * пометкой; если конфигурация есть, но сервис не отвечает — тесты падают.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDotEnvPath, readEnvFile, resolveConfig } from '../../src/config.ts';
import type { Config } from '../../src/config.ts';
import { ObjectsServiceClient } from '../../src/serviceClient.ts';
import type { Failure, ServiceResult } from '../../src/serviceClient.ts';

/** UUID в нижнем регистре — формат идентификаторов объектов сервиса. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Конфигурация доступна через окружение или найденный src/tests/.env. */
const skipReason =
  (process.env.OBJECTS_URL !== undefined && process.env.OBJECTS_AUTH !== undefined) ||
  findDotEnvPath(import.meta.url) !== undefined
    ? false
    : 'Конфигурация недоступна: нет OBJECTS_URL/OBJECTS_AUTH в окружении и не найден src/tests/.env';

/** Содержимое .env для контрольных идентификаторов демо-данных. */
const envFile = skipReason ? {} : readEnvFile(findDotEnvPath(import.meta.url)!);

/** Идентификатор демо-данных: из окружения или .env; значение не печатается. */
function demoId(key: string): string {
  const value = process.env[key] ?? envFile[key];
  if (value === undefined || value === '') {
    assert.fail(`Не задан идентификатор демо-данных: ${key}`);
  }
  return value;
}

/** Клиент живого сервиса; создается только при доступной конфигурации. */
const client: ObjectsServiceClient | undefined = skipReason
  ? undefined
  : new ObjectsServiceClient(resolveConfig(process.env, import.meta.url) as Config, {
      timeoutMs: 20_000,
    });

function service(): ObjectsServiceClient {
  if (client === undefined) {
    assert.fail('Клиент сервиса не создан: конфигурация недоступна');
  }
  return client;
}

/** Приводит результат к успешному; в сообщении отказа — только вид отказа. */
function requireOk(
  result: ServiceResult,
  what: string,
): { status: number; data: Record<string, unknown> } {
  if (!result.ok) {
    assert.fail(`${what}: ожидался успешный ответ, получен отказ вида «${result.failure.kind}»`);
  }
  return { status: result.status, data: result.data as Record<string, unknown> };
}

/** Приводит результат к отказу «refusal»; в сообщении — только вид отказа. */
function requireRefusal(result: ServiceResult, what: string): Extract<Failure, { kind: 'refusal' }> {
  if (result.ok) {
    assert.fail(`${what}: ожидался отказ «refusal», получен успешный ответ`);
  }
  if (result.failure.kind !== 'refusal') {
    assert.fail(`${what}: ожидался отказ «refusal», получен «${result.failure.kind}»`);
  }
  return result.failure;
}

/** Проверяет, что значение — массив объектов, и возвращает его. */
function requireArray(value: unknown, what: string): Array<Record<string, unknown>> {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'object' && item !== null)
  ) {
    assert.fail(`${what}: ожидался массив объектов`);
  }
  return value as Array<Record<string, unknown>>;
}

/** Проверяет, что поле записи — строка, и возвращает его. */
function requireString(record: Record<string, unknown>, key: string, what: string): string {
  if (typeof record[key] !== 'string') {
    assert.fail(`${what}: у записи нет строкового поля ${key}`);
  }
  return record[key] as string;
}

/** Идентификатор партнера, найденного сценарием find_objects, для read_object. */
let foundPartnerId: string | undefined;

test(
  'live find_types: найден счет на оплату, у записей есть name, kind, title, creatable',
  { timeout: 30_000, skip: skipReason },
  async () => {
    const { data } = requireOk(await service().get('/types', { q: 'счет' }), 'find_types');
    const types = requireArray(data.types, 'find_types: data.types');
    assert.ok(types.length > 0, 'find_types: список типов пуст');
    for (const record of types) {
      requireString(record, 'name', 'find_types');
      requireString(record, 'kind', 'find_types');
      requireString(record, 'title', 'find_types');
      assert.equal(typeof record.creatable, 'boolean', 'find_types: у записи нет creatable');
    }
    const invoice = types.find((record) => record.name === 'Документ._ДемоСчетНаОплатуПокупателю');
    assert.ok(invoice !== undefined, 'find_types: в списке нет Документ._ДемоСчетНаОплатуПокупателю');
    const title = requireString(invoice, 'title', 'find_types');
    assert.match(title, /счет/i, 'find_types: кириллица в представлении типа искажена');
  },
);

test(
  'live describe_type: поле Дата, табличная часть Товары, ссылки с searchUrl',
  { timeout: 30_000, skip: skipReason },
  async () => {
    const { data } = requireOk(
      await service().get('/type', { name: 'Документ._ДемоСчетНаОплатуПокупателю' }),
      'describe_type',
    );
    const fields = requireArray(data.fields, 'describe_type: data.fields');
    const date = fields.find((field) => field.name === 'Дата');
    assert.ok(date !== undefined, 'describe_type: поле Дата не найдено');
    assert.equal(date.required, true, 'describe_type: поле Дата не помечено обязательным');
    assert.equal(date.writable, true, 'describe_type: поле Дата не помечено записываемым');
    const tables = requireArray(data.tables, 'describe_type: data.tables');
    assert.ok(
      tables.some((table) => table.name === 'Товары'),
      'describe_type: табличная часть Товары не найдена',
    );
    const hasSearchUrl = fields.some(
      (field) =>
        Array.isArray(field.types) &&
        (field.types as unknown[]).some(
          (entry) => typeof entry === 'object' && entry !== null && 'searchUrl' in entry,
        ),
    );
    assert.ok(
      hasSearchUrl,
      'describe_type: ни у одного ссылочного поля в types нет записи с searchUrl',
    );
  },
);

test(
  'live find_objects: поиск «Альфа» отдает id-UUID в нижнем регистре и hasMore',
  { timeout: 30_000, skip: skipReason },
  async () => {
    const { data } = requireOk(
      await service().get('/search', { type: 'Справочник._ДемоПартнеры', q: 'Альфа' }),
      'find_objects',
    );
    const items = requireArray(data.items, 'find_objects: data.items');
    assert.ok(items.length > 0, 'find_objects: поиск по «Альфа» не дал результатов');
    for (const item of items) {
      assert.match(
        requireString(item, 'id', 'find_objects'),
        UUID_RE,
        'find_objects: id не является UUID в нижнем регистре',
      );
    }
    assert.equal(typeof data.hasMore, 'boolean', 'find_objects: hasMore не boolean');
    foundPartnerId = requireString(items[0], 'id', 'find_objects');
  },
);

test(
  'live read_object: найденный партнер читается целиком',
  { timeout: 30_000, skip: skipReason },
  async () => {
    if (foundPartnerId === undefined) {
      assert.fail('read_object: сценарий find_objects не нашел партнера');
    }
    const { data } = requireOk(
      await service().get('/object', { type: 'Справочник._ДемоПартнеры', id: foundPartnerId }),
      'read_object',
    );
    assert.equal(data.kind, 'catalog', 'read_object: kind не catalog');
    assert.equal(typeof data.header, 'object', 'read_object: header не объект');
    assert.ok(data.header !== null && !Array.isArray(data.header), 'read_object: header не объект');
    assert.equal(data.id, foundPartnerId, 'read_object: id не совпадает с найденным при поиске');
  },
);

test(
  'live create_object: создание партнера с уникальным наименованием (объект остается в базе, согласовано)',
  { timeout: 30_000, skip: skipReason },
  async () => {
    // Метка времени ISO без «:» и «.» делает наименование уникальным;
    // повторный прогон создает нового партнера — так и задумано.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const { status, data } = requireOk(
      await service().post('/object', {
        type: 'Справочник._ДемоПартнеры',
        header: { Наименование: `MCP E2E ${stamp}`, ВидПартнера: 'ЮридическоеЛицо' },
        tables: {},
      }),
      'create_object',
    );
    assert.equal(status, 201, 'create_object: ожидался HTTP 201');
    assert.ok(
      requireString(data, 'id', 'create_object').length > 0,
      'create_object: в ответе пустой id',
    );
    assert.ok(
      requireString(data, 'code', 'create_object').length > 0,
      'create_object: в ответе пустой code',
    );
  },
);

test(
  'live отказ 1С: документ без Организации отклонен с validation_failed',
  { timeout: 30_000, skip: skipReason },
  async () => {
    // Организация — обязательное поле шапки счета; намеренно не передается.
    const result = await service().post('/object', {
      type: 'Документ._ДемоСчетНаОплатуПокупателю',
      header: {
        Дата: '2026-11-05T12:00:00',
        Партнер: demoId('PARTNER_ID'),
        Контрагент: demoId('COUNTERPARTY_ID'),
        Подразделение: demoId('DEPARTMENT_ID'),
        Ответственный: demoId('RESPONSIBLE_ID'),
        ВалютаДокумента: demoId('CURRENCY_ID'),
      },
      tables: {
        Товары: [{ Номенклатура: demoId('PRODUCT_ID'), Цена: 100, Сумма: 100, Всего: 100 }],
      },
    });
    const failure = requireRefusal(result, 'create_object (сценарий отказа)');
    assert.equal(failure.code, 'validation_failed', 'create_object: код отказа не validation_failed');
    const detail = failure.details.find((item) => item.path === 'header.Организация');
    assert.ok(
      detail !== undefined,
      'create_object: среди details нет записи с path header.Организация',
    );
    const text = service().formatFailure(failure);
    assert.ok(text.includes(detail.message), 'formatFailure: нет текста проверки 1С');
  },
);

test(
  'live недоступность: закрытый порт дает отказ unavailable',
  { timeout: 30_000, skip: skipReason },
  async () => {
    // Порт 9 закрыт; строка Basic ниже — заведомая фикция, не учетные данные.
    const deadClient = new ObjectsServiceClient(
      { baseUrl: 'http://127.0.0.1:9', auth: 'Basic dGVzdDp0ZXN0' },
      { timeoutMs: 20_000 },
    );
    const result = await deadClient.get('/types', {});
    if (result.ok) {
      assert.fail('live недоступность: ожидался отказ unavailable, получен успешный ответ');
    }
    assert.equal(result.failure.kind, 'unavailable', 'live недоступность: вид отказа не unavailable');
  },
);
