import { z } from 'zod';

const configSchema = z.object({
  ai: z.object({
    provider: z.enum(['openai', 'anthropic', 'google']).default('anthropic'),
    apiKey: z.string().min(1),
    model: z.string().default('claude-sonnet-4-20250514'),
    embeddingModel: z.string().default('text-embedding-3-small'),
    useLocalEmbeddings: z.boolean().default(true),
  }),
  browser: z.object({
    headless: z.boolean().default(true),
    concurrency: z.number().min(1).max(6).default(3),
  }),
  mysql: z.object({
    host: z.string().default('localhost'),
    port: z.number().default(3306),
    user: z.string().default('pathfinder'),
    password: z.string().default('pathfinder'),
    database: z.string().default('pathfinder'),
  }),
  execution: z.object({
    batchSize: z.number().min(1).max(10).default(3),
    maxRetries: z.number().min(0).max(5).default(2),
    stepTimeoutMs: z.number().default(10000),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const raw = {
    ai: {
      provider: process.env.AI_PROVIDER ?? 'anthropic',
      apiKey: process.env.AI_API_KEY ?? '',
      model: process.env.AI_MODEL ?? 'claude-sonnet-4-20250514',
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
      useLocalEmbeddings: process.env.USE_LOCAL_EMBEDDINGS !== 'false',
    },
    browser: {
      headless: process.env.HEADLESS !== 'false',
      concurrency: parseInt(process.env.BROWSER_CONCURRENCY ?? '3', 10),
    },
    mysql: {
      host: process.env.MYSQL_HOST ?? 'localhost',
      port: parseInt(process.env.MYSQL_PORT ?? '3306', 10),
      user: process.env.MYSQL_USER ?? 'pathfinder',
      password: process.env.MYSQL_PASSWORD ?? 'pathfinder',
      database: process.env.MYSQL_DATABASE ?? 'pathfinder',
    },
    execution: {
      batchSize: parseInt(process.env.BATCH_SIZE ?? '3', 10),
      maxRetries: parseInt(process.env.MAX_RETRIES ?? '2', 10),
      stepTimeoutMs: parseInt(process.env.STEP_TIMEOUT_MS ?? '10000', 10),
    },
  };

  _config = configSchema.parse(raw);
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}
