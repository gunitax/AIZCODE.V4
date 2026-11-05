import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findDotEnvPath, readEnvFile, resolveConfig } from '../../src/config.ts';

/**
 * Создает tmp-дерево: root/src/tests/.env (если задан dotenvContent)
 * и «скрипт» root/mcp-server/build/index.js (сам файл не создается —
 * достаточно URL, поиск идет по каталогам).
 */
function makeTmpTree(dotenvContent: string | null): { root: string; scriptUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  if (dotenvContent !== null) {
    mkdirSync(join(root, 'src', 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'tests', '.env'), dotenvContent, 'utf8');
  }
  const scriptUrl = pathToFileURL(join(root, 'mcp-server', 'build', 'index.js')).href;
  return { root, scriptUrl };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('readEnvFile parses KEY=VALUE and ignores comments and empty lines', () => {
  const { root } = makeTmpTree(null);
  try {
    const file = join(root, '.env');
    writeFileSync(
      file,
      '# комментарий\n\nOBJECTS_URL=http://localhost/demo/hs/objects\n',
      'utf8',
    );
    assert.deepEqual(readEnvFile(file), { OBJECTS_URL: 'http://localhost/demo/hs/objects' });
  } finally {
    cleanup(root);
  }
});

test('readEnvFile trims whitespace around keys and values and strips one pair of quotes', () => {
  const { root } = makeTmpTree(null);
  try {
    const file = join(root, '.env');
    writeFileSync(
      file,
      '  OBJECTS_URL =  http://localhost/demo  \nOBJECTS_AUTH="Basic dXNlcjpwYXNz"\nNAME=\'Текст\'\n',
      'utf8',
    );
    assert.deepEqual(readEnvFile(file), {
      OBJECTS_URL: 'http://localhost/demo',
      OBJECTS_AUTH: 'Basic dXNlcjpwYXNz',
      NAME: 'Текст',
    });
  } finally {
    cleanup(root);
  }
});

test('readEnvFile strips UTF-8 BOM before the first key', () => {
  const { root } = makeTmpTree(null);
  try {
    const file = join(root, '.env');
    writeFileSync(file, '﻿OBJECTS_URL=http://localhost/demo\n', 'utf8');
    assert.deepEqual(readEnvFile(file), { OBJECTS_URL: 'http://localhost/demo' });
  } finally {
    cleanup(root);
  }
});

test('resolveConfig prefers env variables over the .env file', () => {
  const { root, scriptUrl } = makeTmpTree(
    'OBJECTS_URL=http://from-file/\nOBJECTS_AUTH=Basic from-file\n',
  );
  try {
    const config = resolveConfig(
      { OBJECTS_URL: 'http://from-env/', OBJECTS_AUTH: 'Basic from-env' },
      scriptUrl,
    );
    assert.deepEqual(config, { baseUrl: 'http://from-env/', auth: 'Basic from-env' });
  } finally {
    cleanup(root);
  }
});

test('resolveConfig falls back to .env found upward from scriptUrl', () => {
  const { root, scriptUrl } = makeTmpTree(
    'OBJECTS_URL=http://from-file/\nOBJECTS_AUTH=Basic from-file\n',
  );
  try {
    const config = resolveConfig({}, scriptUrl);
    assert.deepEqual(config, { baseUrl: 'http://from-file/', auth: 'Basic from-file' });
  } finally {
    cleanup(root);
  }
});

test('resolveConfig passes auth through verbatim, removing only .env quotes', () => {
  const { root, scriptUrl } = makeTmpTree(
    'OBJECTS_URL=http://from-file/\nOBJECTS_AUTH="Basic dXNlcjpwYXNz"\n',
  );
  try {
    const config = resolveConfig({}, scriptUrl);
    assert.equal(config.auth, 'Basic dXNlcjpwYXNz');
  } finally {
    cleanup(root);
  }
});

test('resolveConfig throws naming OBJECTS_URL and src/tests/.env when nothing found', () => {
  const { root, scriptUrl } = makeTmpTree(null);
  try {
    assert.throws(
      () => resolveConfig({}, scriptUrl),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /OBJECTS_URL/);
        assert.match(error.message, /src\/tests\/\.env/);
        return true;
      },
    );
  } finally {
    cleanup(root);
  }
});

test('findDotEnvPath finds src/tests/.env upward from a deep directory', () => {
  const { root, scriptUrl } = makeTmpTree('OBJECTS_URL=http://from-file/\n');
  try {
    assert.equal(findDotEnvPath(scriptUrl), join(root, 'src', 'tests', '.env'));
  } finally {
    cleanup(root);
  }
});

test('findDotEnvPath returns undefined when no .env exists up to the disk root', () => {
  const { root, scriptUrl } = makeTmpTree(null);
  try {
    assert.equal(findDotEnvPath(scriptUrl), undefined);
  } finally {
    cleanup(root);
  }
});
