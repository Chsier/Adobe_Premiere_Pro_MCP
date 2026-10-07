import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PremiereProBridge } from '../../bridge/index.js';
import { PremiereProTools } from '../../tools/index.js';
import { executeExpandedTool } from '../../tools/expanded.js';

jest.mock('../../bridge/index.js');

describe('temporary output path resolution', () => {
  let root: string;
  let previousTempDir: string | undefined;
  let mockBridge: jest.Mocked<PremiereProBridge>;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'premiere-temp-paths-'));
    previousTempDir = process.env.PREMIERE_TEMP_DIR;
    process.env.PREMIERE_TEMP_DIR = root;
    mockBridge = new PremiereProBridge() as jest.Mocked<PremiereProBridge>;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (previousTempDir === undefined) delete process.env.PREMIERE_TEMP_DIR;
    else process.env.PREMIERE_TEMP_DIR = previousTempDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps motion-demo assets under the resolved bridge directory', async () => {
    mockBridge.importMedia = jest
      .fn()
      .mockResolvedValueOnce({ success: true, id: 'item-1', name: '01_focus.png' } as any)
      .mockResolvedValueOnce({ success: true, id: 'item-2', name: '02_precision.png' } as any)
      .mockResolvedValueOnce({ success: true, id: 'item-3', name: '03_finish.png' } as any);
    mockBridge.addToTimeline = jest
      .fn()
      .mockResolvedValueOnce({ success: true, id: 'clip-1', name: '01_focus.png' } as any)
      .mockResolvedValueOnce({ success: true, id: 'clip-2', name: '02_precision.png' } as any)
      .mockResolvedValueOnce({ success: true, id: 'clip-3', name: '03_finish.png' } as any);
    mockBridge.executeScript
      .mockResolvedValueOnce({ success: true, id: 'seq-1', name: 'Demo Sequence' })
      .mockResolvedValue({ success: true, videoTracks: [], audioTracks: [] });

    const tools = new PremiereProTools(mockBridge);
    const result = await tools.executeTool('build_motion_graphics_demo', {
      sequenceName: 'Demo Sequence',
    });

    expect(result.success).toBe(true);
    expect(resolve(result.assetDir).startsWith(resolve(root))).toBe(true);
    expect(result.assets.every((asset: any) => resolve(asset.path).startsWith(resolve(root)))).toBe(true);
  }, 30000);

  it('keeps generated color bars under the resolved bridge directory', async () => {
    mockBridge.importMedia = jest.fn().mockResolvedValue({ success: true, id: 'bars-1' } as any);

    const result = await executeExpandedTool(mockBridge, 'create_bars_and_tone', {
      width: 8,
      height: 8,
    });

    expect(result.success).toBe(true);
    expect(resolve(result.data.path).startsWith(resolve(join(root, 'generated-assets')))).toBe(true);
  });

  it('keeps delete_preview_files fallback scans under the resolved bridge directory', async () => {
    mockBridge.executeScript = jest.fn().mockResolvedValue({
      success: true,
      projectPath: '',
      projectName: '',
      sequenceName: '',
    } as any);

    const result = await executeExpandedTool(mockBridge, 'delete_preview_files', {});

    expect(result.success).toBe(true);
    expect(result.data.scanned.length).toBeGreaterThan(0);
    expect(result.data.scanned.every((entry: string) => resolve(entry).startsWith(resolve(root)))).toBe(true);
  });
});
