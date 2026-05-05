import mysql from 'mysql2/promise';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');

let pool: mysql.Pool | null = null;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export async function initDatabase(config: DbConfig): Promise<mysql.Pool> {
  if (pool) return pool;

  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
  });

  await createTables(pool);
  await addMissingColumns(pool);
  log.info('MySQL database initialized');
  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Database not initialized. Call initDatabase() first.');
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    log.info('MySQL connection pool closed');
  }
}

/**
 * Adds columns introduced after the initial schema was deployed.
 * Uses IF NOT EXISTS so it is safe to run on every startup.
 * Requires MySQL 8.0.3+. If your MySQL is older, replace with a
 * SHOW COLUMNS guard.
 */
async function addMissingColumns(db: mysql.Pool): Promise<void> {
  const alterations = [
    `ALTER TABLE plan_cache ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL DEFAULT NULL`,
  ];
  for (const sql of alterations) {
    await db.execute(sql).catch((err) => {
      log.warn(`Column migration skipped (may already exist): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

async function createTables(db: mysql.Pool): Promise<void> {
  const queries = [
    `CREATE TABLE IF NOT EXISTS documents (
      url VARCHAR(768) PRIMARY KEY,
      content LONGTEXT NOT NULL,
      title VARCHAR(1024) DEFAULT '',
      content_hash VARCHAR(64) DEFAULT '',
      crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS vectors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      url VARCHAR(2048) NOT NULL,
      chunk_index INT NOT NULL,
      text LONGTEXT NOT NULL,
      embedding LONGBLOB NOT NULL,
      metadata JSON,
      INDEX idx_vectors_url (url(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS interaction_graph (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS flows (
      id VARCHAR(128) PRIMARY KEY,
      data JSON NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS test_cases (
      id VARCHAR(128) PRIMARY KEY,
      data JSON NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS test_results (
      id VARCHAR(128) PRIMARY KEY,
      test_case_id VARCHAR(128) NOT NULL,
      run_id VARCHAR(128) NOT NULL,
      data JSON NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_results_test_case (test_case_id),
      INDEX idx_results_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS plan_cache (
      hash VARCHAR(128) PRIMARY KEY,
      test_case_id VARCHAR(128) NOT NULL,
      plan JSON NOT NULL,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value JSON
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS memory (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value JSON,
      category VARCHAR(64) DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_memory_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const query of queries) {
    await db.execute(query);
  }
}
