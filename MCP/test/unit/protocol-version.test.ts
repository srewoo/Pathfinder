import { describe, it, expect } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  SERVER_VERSION,
  TOOL_VERSIONS,
  getVersionInfo,
} from '../../src/mcp/protocol-version';
import { handleVersion } from '../../src/mcp/handlers/version';

const SEMVER = /^\d+\.\d+\.\d+$/;

describe('protocol-version manifest', () => {
  it('given protocol/server constants when read then are valid semver', () => {
    expect(MCP_PROTOCOL_VERSION).toMatch(SEMVER);
    expect(SERVER_VERSION).toMatch(SEMVER);
  });

  it('given each tool version when read then is valid semver', () => {
    for (const [name, ver] of Object.entries(TOOL_VERSIONS)) {
      expect(ver, `${name} version`).toMatch(SEMVER);
    }
  });

  it('given critical tools when checked then each has a version', () => {
    const critical = [
      'run_one_liners', 'crawl_knowledge', 'explore_app',
      'capture_auth', 'remember', 'recall', 'pathfinder_version',
    ];
    for (const name of critical) {
      expect(TOOL_VERSIONS[name], name).toBeDefined();
    }
  });

  it('given getVersionInfo when called then returns frozen-style copy', () => {
    const info = getVersionInfo();
    info.tools.run_one_liners = '99.99.99';
    expect(TOOL_VERSIONS.run_one_liners).not.toBe('99.99.99');
  });
});

describe('handleVersion', () => {
  it('given called when responding then includes server version line and JSON', async () => {
    const result = await handleVersion();
    const text = result.content[0].text;
    const json = result.content[1].text;
    expect(text).toContain(SERVER_VERSION);
    expect(text).toContain('pathfinder_version');
    expect(JSON.parse(json)).toMatchObject({
      protocol: MCP_PROTOCOL_VERSION,
      server: SERVER_VERSION,
    });
  });
});
