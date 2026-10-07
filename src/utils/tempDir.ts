import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the directory shared by the MCP server and the CEP bridge.
 *
 * Using `/tmp` as a Windows default resolves relative to the current drive
 * (for example `D:\tmp` when the server starts from D:), so the default must
 * come from Node's platform-aware temp directory instead.
 */
export function resolvePremiereTempDir(): string {
  const configured = process.env.PREMIERE_TEMP_DIR?.trim();
  return configured || join(tmpdir(), 'premiere-mcp-bridge');
}
