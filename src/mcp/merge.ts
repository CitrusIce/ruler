import { McpStrategy } from '../types';

/**
 * Merge native and incoming MCP server configurations according to strategy.
 * @param base Existing native MCP config object.
 * @param incoming Ruler MCP config object.
 * @param strategy Merge strategy: 'merge' to union servers, 'overwrite' to replace.
 * @param serverKey The key to use for servers in the output (e.g., 'servers' for Copilot, 'mcpServers' for others).
 * @returns Merged MCP config object.
 */
export function mergeMcp(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  strategy: McpStrategy,
  serverKey: string,
): Record<string, unknown> {
  if (strategy === 'overwrite') {
    // Overwrite only the MCP servers section, but preserve unrelated keys.
    // This is important for config files that contain more than MCP servers
    // (e.g. Codex config.toml or Claude's ~/.claude.json).
    const incomingServers =
      (incoming[serverKey] as Record<string, unknown>) ||
      (incoming.mcpServers as Record<string, unknown>) ||
      (incoming.mcp as Record<string, unknown>) ||
      {};

    const newBase = { ...base };
    delete (newBase as Record<string, unknown>).mcpServers;
    delete (newBase as Record<string, unknown>).mcp;
    delete (newBase as Record<string, unknown>)[serverKey];
    return {
      ...newBase,
      [serverKey]: incomingServers,
    };
  }

  const baseServers =
    (base[serverKey] as Record<string, unknown>) ||
    (base.mcpServers as Record<string, unknown>) ||
    (base.mcp as Record<string, unknown>) ||
    {};
  const incomingServers =
    (incoming[serverKey] as Record<string, unknown>) ||
    (incoming.mcpServers as Record<string, unknown>) ||
    (incoming.mcp as Record<string, unknown>) ||
    {};

  const mergedServers = { ...baseServers, ...incomingServers };

  const newBase = { ...base };
  delete newBase.mcpServers; // Remove old key if present

  return {
    ...newBase,
    [serverKey]: mergedServers,
  } as Record<string, unknown>;
}
