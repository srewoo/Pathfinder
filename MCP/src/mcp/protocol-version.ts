/**
 * MCP server + tool schema versioning.
 *
 * Bump SERVER_VERSION on any breaking change to server behavior.
 * Bump a TOOL_VERSIONS entry on any change to that tool's input/output schema
 * (additive changes increment minor; breaking changes increment major).
 *
 * Clients can introspect this via the `pathfinder_version` tool to detect drift.
 */

export const MCP_PROTOCOL_VERSION = '1.0.0';
export const SERVER_VERSION = '1.1.0';

/** Per-tool schema version. */
export const TOOL_VERSIONS: Record<string, string> = {
  // Test execution
  run_one_liners: '1.2.0',
  run_csv: '1.0.0',
  expand_tests: '1.0.0',

  // Knowledge base
  crawl_knowledge: '1.1.0',
  export_knowledge: '1.0.0',
  import_knowledge: '1.0.0',
  clear_knowledge: '1.0.0',

  // Exploration
  explore_app: '1.2.0',
  export_explore: '1.0.0',
  import_explore: '1.0.0',
  clear_explore: '1.0.0',

  // Flows + results
  learn_flows: '1.0.0',
  get_results: '1.0.0',
  get_graph: '1.0.0',
  get_flows: '1.0.0',

  // Auth
  capture_auth: '1.0.0',
  import_chrome_cookies: '1.0.0',

  // Memory
  remember: '1.0.0',
  recall: '1.0.0',

  // Operation control
  cancel_operation: '1.0.0',

  // Introspection
  pathfinder_version: '1.0.0',
};

export interface VersionInfo {
  protocol: string;
  server: string;
  tools: Record<string, string>;
}

export function getVersionInfo(): VersionInfo {
  return {
    protocol: MCP_PROTOCOL_VERSION,
    server: SERVER_VERSION,
    tools: { ...TOOL_VERSIONS },
  };
}
