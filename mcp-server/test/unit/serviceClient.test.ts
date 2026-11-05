import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectsServiceClient, type Failure, type ServiceResult } from '../../src/serviceClient.ts';
import type { Config } from '../../src/config.ts';

const cfg: Config = { baseUrl: 'http://localhost/demo/hs/objects', auth: 'Basic dXNlcjpwYXNz' };

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/** Создает fetch-заглушку: записывает вызов и отвечает телом со статусом. */
function mockFetch(status: number, bodyText: string, calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(bodyText, { status });
  };
}

function expectSuccess(result: ServiceResult): Extract<ServiceResult, { ok: true }> {
  if (!result.ok) {
    assert.fail(`ожидался успех, получен отказ: ${JSON.stringify(result.failure)}`);
  }
  return result;
}

function expectFailure(result: ServiceResult): Failure {
  if (result.ok) {
    assert.fail('ожидался отказ, получен успешный результат');
  }
  return result.failure;
}

test('200 JSON returns ok:true with parsed data, Authorization verbatim, no Content-Type on GET', async () => {
  const calls: RecordedCall[] = [];
  const payload = {
    items: [{ ref: '9203492b-ea3e-11de-8634-001d600d9ad2', presentation: 'Альфа' }],
    total: 1,
  };
  const client = new ObjectsServiceClient(cfg, {
    fetchImpl: mockFetch(200, JSON.stringify(payload), calls),
  });
  const result = await client.get('/v1/objects', { q: 'Альфа' });
  const success = expectSuccess(result);
  assert.equal(success.status, 200);
  assert.deepEqual(success.data, payload);
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('Authorization'), 'Basic dXNlcjpwYXNz');
  assert.equal(headers.get('Content-Type'), null);
});

test('POST sends method POST, Content-Type application/json and body exactly JSON.stringify', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, { fetchImpl: mockFetch(200, '{"ok":true}', calls) });
  const body = { type: 'Документ.ЗаказПокупателя', filter: { presentation: 'Альфа' }, limit: 5 };
  const result = await client.post('/v1/objects', body);
  expectSuccess(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'POST');
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('Authorization'), 'Basic dXNlcjpwYXNz');
  assert.equal(calls[0].init?.body, JSON.stringify(body));
});

test('422 with error.code returns refusal preserving fields; formatFailure renders code, path, message', async () => {
  const calls: RecordedCall[] = [];
  const errorBody =
    '{"error":{"code":"validation_failed","message":"Проверка параметров не пройдена",' +
    '"details":[{"path":"header.Организация","message":"Поле не заполнено"}]}}';
  const client = new ObjectsServiceClient(cfg, { fetchImpl: mockFetch(422, errorBody, calls) });
  const result = await client.get('/v1/objects', {});
  const failure = expectFailure(result);
  assert.deepEqual(failure, {
    kind: 'refusal',
    code: 'validation_failed',
    message: 'Проверка параметров не пройдена',
    details: [{ path: 'header.Организация', message: 'Поле не заполнено' }],
  });
  assert.equal(result.status, 422);
  const text = client.formatFailure(failure);
  assert.ok(text.includes('1С отклонила операцию (validation_failed)'));
  assert.ok(text.includes('header.Организация'));
  assert.ok(text.includes('Поле не заполнено'));
  assert.equal(
    text,
    '1С отклонила операцию (validation_failed): Проверка параметров не пройдена\n' +
      '- header.Организация: Поле не заполнено',
  );
});

test('400 unknown_type returns refusal; formatFailure adds no lines for empty details', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, {
    fetchImpl: mockFetch(400, '{"error":{"code":"unknown_type","message":"Неизвестный тип объекта"}}', calls),
  });
  const result = await client.get('/v1/objects', {});
  const failure = expectFailure(result);
  assert.deepEqual(failure, {
    kind: 'refusal',
    code: 'unknown_type',
    message: 'Неизвестный тип объекта',
    details: [],
  });
  assert.equal(client.formatFailure(failure), '1С отклонила операцию (unknown_type): Неизвестный тип объекта');
});

test('403 JSON with error.code is refusal, not access_denied', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, {
    fetchImpl: mockFetch(403, '{"error":{"code":"forbidden","message":"Недостаточно прав на операцию"}}', calls),
  });
  const failure = expectFailure(await client.get('/v1/objects', {}));
  assert.deepEqual(failure, {
    kind: 'refusal',
    code: 'forbidden',
    message: 'Недостаточно прав на операцию',
    details: [],
  });
});

test('403 with HTML body returns access_denied with canonical message', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, {
    fetchImpl: mockFetch(403, '<html><body>403 Forbidden</body></html>', calls),
  });
  const result = await client.get('/v1/objects', {});
  const failure = expectFailure(result);
  assert.deepEqual(failure, {
    kind: 'access_denied',
    message: 'Доступ запрещен: проверьте учетные данные сервиса',
  });
  assert.equal(result.status, 403);
});

test('401 with empty body returns access_denied with canonical message', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, { fetchImpl: mockFetch(401, '', calls) });
  const failure = expectFailure(await client.get('/v1/objects', {}));
  assert.deepEqual(failure, {
    kind: 'access_denied',
    message: 'Доступ запрещен: проверьте учетные данные сервиса',
  });
});

test('500 HTML without error.code returns unavailable mentioning HTTP 500', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, {
    fetchImpl: mockFetch(500, '<html><body>Internal Server Error</body></html>', calls),
  });
  const result = await client.get('/v1/objects', {});
  const failure = expectFailure(result);
  assert.equal(failure.kind, 'unavailable');
  assert.ok(failure.message.startsWith('Сервис объектов недоступен: '));
  assert.ok(failure.message.includes('HTTP 500'));
  assert.equal(result.status, 500);
});

test('200 with non-JSON body returns unavailable mentioning unexpected HTTP 200', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, { fetchImpl: mockFetch(200, '<html></html>', calls) });
  const failure = expectFailure(await client.get('/v1/objects', {}));
  assert.equal(failure.kind, 'unavailable');
  assert.ok(failure.message.includes('неожиданный ответ HTTP 200'));
});

test('fetch connection failure returns unavailable without throwing', async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    throw new Error('ECONNREFUSED: соединение отвергнуто');
  };
  const client = new ObjectsServiceClient(cfg, { fetchImpl });
  const failure = expectFailure(await client.get('/v1/objects', {}));
  assert.equal(failure.kind, 'unavailable');
  assert.ok(failure.message.startsWith('Сервис объектов недоступен: '));
  assert.ok(failure.message.includes('ECONNREFUSED'));
  assert.equal(calls.length, 1);
});

test('timeout aborts request and returns unavailable quickly', async () => {
  const calls: RecordedCall[] = [];
  const hangingFetch: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return new Promise<Response>((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('мок: fetch не был прерван')), 500);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(fallback);
          reject(new DOMException('This operation was aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  };
  const client = new ObjectsServiceClient(cfg, { timeoutMs: 20, fetchImpl: hangingFetch });
  const started = Date.now();
  const failure = expectFailure(await client.get('/v1/objects', {}));
  assert.equal(failure.kind, 'unavailable');
  assert.ok(failure.message.startsWith('Сервис объектов недоступен: '));
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 5000, 'тест с таймаутом должен завершиться быстро');
});

test('makes exactly one fetch call per request for success, refusal, HTTP error and network failure', async () => {
  const cases: Array<{ name: string; status: number; body: string }> = [
    { name: 'успех', status: 200, body: '{"items":[]}' },
    { name: 'отказ', status: 422, body: '{"error":{"code":"validation_failed","message":"Ошибка"}}' },
    { name: 'HTTP 500', status: 500, body: '<html></html>' },
  ];
  for (const c of cases) {
    const calls: RecordedCall[] = [];
    const client = new ObjectsServiceClient(cfg, { fetchImpl: mockFetch(c.status, c.body, calls) });
    await client.get('/v1/objects', {});
    assert.equal(calls.length, 1, `${c.name}: ожидался ровно один вызов fetch`);
  }
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    throw new Error('ECONNREFUSED');
  };
  const client = new ObjectsServiceClient(cfg, { fetchImpl });
  await client.get('/v1/objects', {});
  assert.equal(calls.length, 1, 'сетевой сбой: ожидался ровно один вызов fetch');
});

test('GET encodes q, keeps UUID verbatim and omits empty limit from query', async () => {
  const calls: RecordedCall[] = [];
  const client = new ObjectsServiceClient(cfg, { fetchImpl: mockFetch(200, '{"items":[]}', calls) });
  await client.get('/v1/objects', {
    q: 'Альфа',
    id: '9203492b-ea3e-11de-8634-001d600d9ad2',
    limit: '',
  });
  assert.equal(calls.length, 1);
  const url = calls[0].url;
  assert.equal(
    url,
    'http://localhost/demo/hs/objects/v1/objects' +
      '?q=%D0%90%D0%BB%D1%8C%D1%84%D0%B0&id=9203492b-ea3e-11de-8634-001d600d9ad2',
  );
  assert.equal(new URL(url).searchParams.get('q'), 'Альфа');
  assert.ok(!url.includes('limit'));
});

test('formatFailure renders path:null details as "(без поля)" lines', () => {
  const client = new ObjectsServiceClient(cfg);
  const text = client.formatFailure({
    kind: 'refusal',
    code: 'internal_error',
    message: 'Внутренняя ошибка сервиса',
    details: [
      { path: null, message: 'Обратитесь к администратору' },
      { path: 'header.Контрагент', message: 'Ссылка недействительна' },
    ],
  });
  assert.equal(
    text,
    '1С отклонила операцию (internal_error): Внутренняя ошибка сервиса\n' +
      '- (без поля): Обратитесь к администратору\n' +
      '- header.Контрагент: Ссылка недействительна',
  );
});
