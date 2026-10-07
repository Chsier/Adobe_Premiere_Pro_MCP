import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from '@jest/globals';

let testTempRoot: string | undefined;
let previousTempDir: string | undefined;

beforeAll(async () => {
  testTempRoot = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-test-'));
  previousTempDir = process.env.PREMIERE_TEMP_DIR;
  process.env.PREMIERE_TEMP_DIR = testTempRoot;
});

afterAll(async () => {
  if (previousTempDir === undefined) delete process.env.PREMIERE_TEMP_DIR;
  else process.env.PREMIERE_TEMP_DIR = previousTempDir;
  if (testTempRoot) await fs.rm(testTempRoot, { recursive: true, force: true });
});
