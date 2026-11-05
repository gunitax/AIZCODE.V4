/**
 * HTTP-клиент сервиса объектов 1С и классификация ошибок ответов.
 *
 * На каждый запрос выполняется ровно один вызов fetch: повтор после
 * потери ответа небезопасен (POST-операции не идемпотентны). Таймаут
 * по умолчанию 30000 мс через AbortController. Любая сетевая проблема,
 * таймаут или неожиданный ответ возвращаются результатом ServiceResult,
 * а не исключением; учетные данные в сообщениях об ошибках не раскрываются.
 */

import type { Config } from './config.ts';

/** Отказ сервиса: отклонение операции, запрет доступа или недоступность. */
export type Failure =
  | { kind: 'refusal'; code: string; message: string; details: Array<{ path: string | null; message: string }> }
  | { kind: 'access_denied'; message: string }
  | { kind: 'unavailable'; message: string };

/** Результат обращения к сервису: успешные данные или отказ. */
export type ServiceResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status?: number; failure: Failure };

/** Описание отказа внутри тела ответа: { error: { code, message, details } }. */
interface ServiceError {
  code: string;
  message: string;
  details: Array<{ path: string | null; message: string }>;
}

const DEFAULT_TIMEOUT_MS = 30000;

const ACCESS_DENIED_MESSAGE = 'Доступ запрещен: проверьте учетные данные сервиса';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Извлекает из тела ответа описание отказа; при отсутствии error.code возвращает undefined. */
function extractError(body: unknown): ServiceError | undefined {
  const root = asRecord(body);
  const error = root === undefined ? undefined : asRecord(root.error);
  if (error === undefined || typeof error.code !== 'string') {
    return undefined;
  }
  const detailsRaw: unknown[] = Array.isArray(error.details) ? error.details : [];
  return {
    code: error.code,
    message: typeof error.message === 'string' ? error.message : '',
    details: detailsRaw.map((item) => {
      const record = asRecord(item);
      return {
        path: record !== undefined && typeof record.path === 'string' ? record.path : null,
        message: record !== undefined && typeof record.message === 'string' ? record.message : '',
      };
    }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Клиент HTTP-сервиса объектов: get, post и приведение отказов к тексту. */
export class ObjectsServiceClient {
  private readonly cfg: Config;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Config, options?: { timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.cfg = cfg;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  /** Выполняет GET-запрос; пустые значения параметров не передаются. */
  async get(path: string, params: Record<string, string>): Promise<ServiceResult> {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== '') {
        search.set(name, value);
      }
    }
    const query = search.toString();
    const url = `${this.cfg.baseUrl}${path}${query === '' ? '' : `?${query}`}`;
    return this.request(url, { method: 'GET', headers: { Authorization: this.cfg.auth } });
  }

  /** Выполняет POST-запрос с JSON-телом. */
  async post(path: string, body: unknown): Promise<ServiceResult> {
    const url = `${this.cfg.baseUrl}${path}`;
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.cfg.auth },
      body: JSON.stringify(body),
    });
  }

  /** Приводит отказ к каноническому тексту для пользователя. */
  formatFailure(f: Failure): string {
    if (f.kind === 'refusal') {
      const lines = [`1С отклонила операцию (${f.code}): ${f.message}`];
      for (const detail of f.details) {
        const where = detail.path === null ? '(без поля)' : detail.path;
        lines.push(`- ${where}: ${detail.message}`);
      }
      return lines.join('\n');
    }
    return f.message;
  }

  /** Один вызов fetch с таймаутом; ответ классифицируется, исключения не выходят наружу. */
  private async request(url: string, init: RequestInit): Promise<ServiceResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      return await this.classify(response);
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: 'unavailable',
          message: `Сервис объектов недоступен: ${describeError(error)}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async classify(response: Response): Promise<ServiceResult> {
    let body: unknown;
    let bodyIsJson = false;
    try {
      body = await response.json();
      bodyIsJson = true;
    } catch {
      // HTML, пустое тело и прочий не-JSON: тело без error.code.
    }
    const error = bodyIsJson ? extractError(body) : undefined;
    if (error !== undefined) {
      return {
        ok: false,
        status: response.status,
        failure: {
          kind: 'refusal',
          code: error.code,
          message: error.message,
          details: error.details,
        },
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        failure: { kind: 'access_denied', message: ACCESS_DENIED_MESSAGE },
      };
    }
    if (response.ok && bodyIsJson) {
      return { ok: true, status: response.status, data: body };
    }
    return {
      ok: false,
      status: response.status,
      failure: {
        kind: 'unavailable',
        message: `Сервис объектов недоступен: неожиданный ответ HTTP ${response.status}`,
      },
    };
  }
}
