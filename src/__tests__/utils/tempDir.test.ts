import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { resolvePremiereTempDir } from '../../utils/tempDir.js';

describe('resolvePremiereTempDir', () => {
  const previous = process.env.PREMIERE_TEMP_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.PREMIERE_TEMP_DIR;
    else process.env.PREMIERE_TEMP_DIR = previous;
  });

  it('uses the OS temp directory when PREMIERE_TEMP_DIR is unset', () => {
    delete process.env.PREMIERE_TEMP_DIR;

    expect(resolvePremiereTempDir()).toBe(join(tmpdir(), 'premiere-mcp-bridge'));
  });

  it('uses the configured directory unchanged', () => {
    const configured = join(tmpdir(), 'custom-premiere-bridge');
    process.env.PREMIERE_TEMP_DIR = configured;

    expect(resolvePremiereTempDir()).toBe(configured);
  });

  it('trims configured whitespace and falls back for a blank value', () => {
    process.env.PREMIERE_TEMP_DIR = '  ';

    expect(resolvePremiereTempDir()).toBe(join(tmpdir(), 'premiere-mcp-bridge'));
  });
});
