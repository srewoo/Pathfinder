require('dotenv').config();
const mysql = require('mysql2/promise');
async function test() {
  console.log("Using host:", process.env.MYSQL_HOST);
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD
    });
    console.log("Connected!");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
test();
