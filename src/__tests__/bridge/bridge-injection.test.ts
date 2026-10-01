/**
 * The bridge builds scripts too, and no tool-side guard can see them.
 *
 * The injection sweep drives tools through a stub whose only member is
 * `executeScript`, so any tool delegating to a real bridge method — `importMedia`,
 * `createSequence`, `renderSequence` and the rest — throws before emitting and
 * drops out of the sweep. Sixteen tools are in that position, and raw
 * interpolation added inside those methods went unnoticed with the whole suite
 * green.
 *
 * So the real bridge is driven here, with the filesystem stubbed, and whatever it
 * writes to the command file is held to the same contract as a tool's script: it
 * must parse as ES3 and must not run a payload.
 *
 * The class is checked against two explicit inventories. A new prototype method
 * makes this test fail until its author classifies it as either a script builder
 * or a non-script helper, so an unclassified method cannot silently escape the
 * sweep.
 */

import vm from 'vm';
import { parse } from 'acorn';
import { PremiereProBridge } from '../../bridge/index.js';
import { promises as fs } from 'fs';

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(), access: jest.fn(), readdir: jest.fn(), writeFile: jest.fn(),
    readFile: jest.fn(), unlink: jest.fn(), rename: jest.fn(), rm: jest.fn(),
  }
}));

jest.mock('node:crypto', () => ({ randomUUID: jest.fn(() => 'test-uuid-1234') }));

const BREAKOUT_DOUBLE = 'zz"); __OWNED = true; ("';
const BREAKOUT_SINGLE = "zz'; __OWNED = true; var __x = '";
const BREAKOUT_BACKSLASH = 'zz\\"); __OWNED = true; ("';
const PAYLOADS = [BREAKOUT_DOUBLE, BREAKOUT_SINGLE, BREAKOUT_BACKSLASH];

/** Bridge methods that build and execute an ExtendScript payload. */
const SCRIPT_BUILDERS = [
  'createProject', 'openProject', 'saveProject', 'importMedia', 'createSequence',
  'addToTimeline', 'addToTimelineBatch', 'renderSequence', 'listProjectItems',
] as const;

/**
 * Everything else on the prototype: lifecycle, filesystem, host detection,
 * transport, and local diagnostics. Keep this list exhaustive; the inventory
 * assertion below turns an unclassified new method into a deliberate choice.
 */
const NON_SCRIPT_METHODS = new Set([
  'constructor', 'initialize', 'setupTempDirectory', 'detectPremiereProInstallation',
  'findPremiereLaunchPath', 'ensureHost', 'isPremiereProcessRunning', 'launchPremiere',
  'waitForStartedHeartbeat', 'initializeCommunication', 'isSelfInvokingScript',
  'buildExecutableScript', 'executeScript', 'readHeartbeat', 'waitForResponse',
  'findInstalledMediaEncoder', 'localConfigValues', 'mediaEncoderEnvCandidates',
  'collectMediaEncoderSearchPaths', 'expandAdobeRootForMediaEncoder',
  'probeMediaEncoderDirectory', 'somePathExists', 'queryRegistryMediaEncoderInstallLocations',
  'cleanup',
]);

function payloadRuns(script: string): boolean {
  const sandbox: Record<string, unknown> = {
    __OWNED: false,
    app: {
      enableQE() {},
      project: {
        name: 'p', sequences: { numSequences: 0 },
        rootItem: { name: 'r', nodeId: 'r', children: { numItems: 0 }, createBin: () => ({ name: 'b', nodeId: 'n' }) },
        activeSequence: null, importFiles: () => true, importSequences: () => true,
        newSequence: () => ({ sequenceID: 's', name: 'n' }),
      },
      encoder: { encodeSequence: () => true, launchEncoder: () => true },
    },
    qe: { project: {} },
    JSON,
    File: function () { return { exists: false, fsName: '/tmp/x' }; },
    Folder: function () { return { exists: false, create: () => false }; },
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(`(function(){${script}})()`, sandbox, { timeout: 2000 });
  } catch {
    // A missing DOM member is expected; only the flag matters.
  }
  return sandbox.__OWNED === true;
}

describe('scripts the bridge builds itself', () => {
  const mockFs = fs as jest.Mocked<typeof fs>;

  const readyBridge = async (): Promise<PremiereProBridge> => {
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.access.mockRejectedValue(new Error('Not found'));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    // Answer immediately so nothing waits on a panel that is not there.
    mockFs.readFile.mockResolvedValue(JSON.stringify({ success: true, result: '{}' }));

    const bridge = new PremiereProBridge();
    await bridge.initialize();
    return bridge;
  };

  /** Every script written during one call. */
  const scriptsWritten = (): string[] =>
    mockFs.writeFile.mock.calls
      .map(([, payload]) => payload)
      .filter((payload): payload is string => typeof payload === 'string' && payload.includes('"script"'))
      .map((payload) => JSON.parse(payload).script as string);

  const prototypeMethods = (): string[] =>
    Object.getOwnPropertyNames(PremiereProBridge.prototype)
      .filter((name) => typeof (PremiereProBridge.prototype as unknown as Record<string, unknown>)[name] === 'function');

  it('cannot be broken out of through any method that builds one', async () => {
    const unclassified = prototypeMethods().filter(
      (name) => !SCRIPT_BUILDERS.includes(name as (typeof SCRIPT_BUILDERS)[number]) && !NON_SCRIPT_METHODS.has(name),
    );
    expect(unclassified).toEqual([]);

    const bridge = await readyBridge();
    const missingBuilders = SCRIPT_BUILDERS.filter(
      (name) => typeof (bridge as unknown as Record<string, unknown>)[name] !== 'function',
    );
    expect(missingBuilders).toEqual([]);

    // AME discovery shells out to the registry on Windows. It is not part of the
    // injection contract, so keep the sweep local and deterministic.
    const discoverySpy = jest
      .spyOn(bridge as unknown as { findInstalledMediaEncoder: () => Promise<{ available: boolean; searchedPaths: string[] }> }, 'findInstalledMediaEncoder')
      .mockResolvedValue({ available: false, searchedPaths: [] });

    const escaped: string[] = [];
    const unparseable: string[] = [];
    let checked = 0;

    for (const method of SCRIPT_BUILDERS) {
      for (const payload of PAYLOADS) {
        // Arity is unknown and varies; the payload is passed in every position a
        // method might read a string from.
        for (const arity of [1, 2, 3, 4]) {
          jest.clearAllMocks();
          const call = (bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method];
          try {
            await call.apply(bridge, Array.from({ length: arity }, () => payload));
          } catch {
            // Argument validation and missing DOM members are fine; anything the
            // method wrote before failing is still inspected below.
          }

          for (const script of scriptsWritten()) {
            checked++;
            try {
              parse(script, { ecmaVersion: 3, allowReturnOutsideFunction: true });
            } catch {
              unparseable.push(`${method}/${arity}`);
              continue;
            }
            if (payloadRuns(script)) escaped.push(`${method}/${arity}`);
          }
        }
      }
    }

    discoverySpy.mockRestore();

    // A floor, so a harness that stopped driving anything cannot pass silently.
    expect(SCRIPT_BUILDERS.length).toBeGreaterThan(5);
    expect(checked).toBeGreaterThan(20);

    // Execution is the contract: no caller value may run as code.
    expect([...new Set(escaped)]).toEqual([]);

    // Parse failures are NOT asserted, and the reason is worth stating rather than
    // hiding. Arity and parameter types are unknown here, so the payload also
    // lands in positions a method interpolates as a number (`var t = ${time};`).
    // A string there cannot parse, which is a property of passing the wrong type
    // rather than of quoting -- the tool layer's schema makes it unreachable, and
    // `addToTimeline` is the only method that shows it. Asserting on it would fail
    // for a defect that does not exist. Recorded so a reader can see the shape.
    expect(unparseable.every((site) => site.startsWith('addToTimeline'))).toBe(true);
  }, 600_000);
});
