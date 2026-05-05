import mysql from 'mysql2/promise';
import { loadConfig } from './src/config/config.js';

async function test() {
  const cfg = loadConfig().mysql;
  console.log("Config:", cfg);
  try {
    const conn = await mysql.createConnection({
      host: cfg.host,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database
    });
    console.log("Connected successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Connection failed:", err);
    process.exit(1);
  }
}
test();
