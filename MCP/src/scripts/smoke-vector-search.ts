import { initDatabase, closeDatabase } from '../storage/database.js';
import { vectorRepo } from '../storage/repositories/vector-repo.js';
import { search } from '../core/knowledge/vector-search.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('smoke-vector-search');

async function main() {
  const mysqlConfig = {
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: parseInt(process.env.MYSQL_PORT ?? '3306', 10),
    user: process.env.MYSQL_USER ?? 'pathfinder',
    password: process.env.MYSQL_PASSWORD ?? 'pathfinder',
    database: process.env.MYSQL_DATABASE ?? 'pathfinder',
  };

  await initDatabase(mysqlConfig);

  const vectors = await vectorRepo.getAll();
  if (vectors.length === 0) throw new Error('No vectors in DB');

  const queryEmbedding = vectors[0].embedding;
  const results = await search(queryEmbedding, 3, 0.1);

  log.info(`Vectors loaded: ${vectors.length}`);
  if (results.length === 0) {
    log.warn('No search results returned');
    return;
  }

  log.info(
    `Top result: ${results[0].record.url} (chunkIndex=${results[0].record.metadata.chunkIndex}, score=${results[0].score.toFixed(
      4
    )})`
  );
  log.info(`Query url: ${vectors[0].url}`);
  await closeDatabase();
}

main().catch((err) => {
  log.error(`Smoke search failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

