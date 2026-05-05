import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { loadConfig } from '../config/config.js';
import { initDatabase } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-server');

export async function createMcpServer(): Promise<McpServer> {
  const config = loadConfig();

  // Initialize MySQL
  await initDatabase(config.mysql);

  const server = new McpServer({
    name: 'pathfinder',
    version: '1.0.0',
  });

  registerTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('Pathfinder MCP server started');
  return server;
}
