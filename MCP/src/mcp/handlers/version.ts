import { getVersionInfo } from '../protocol-version.js';

export async function handleVersion() {
  const info = getVersionInfo();
  const lines = [
    `Pathfinder MCP Server`,
    `  protocol: ${info.protocol}`,
    `  server:   ${info.server}`,
    ``,
    `Tools (name @ version):`,
    ...Object.entries(info.tools)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ver]) => `  • ${name} @ ${ver}`),
  ];
  return {
    content: [
      { type: 'text' as const, text: lines.join('\n') },
      { type: 'text' as const, text: JSON.stringify(info, null, 2) },
    ],
  };
}
