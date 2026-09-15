// Corre schema.sql contra la base al arrancar el servidor.
// Es seguro correrlo siempre: todas las sentencias usan IF NOT EXISTS.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ Falta DATABASE_URL — no se puede migrar.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  try {
    await pool.query(sql);
    console.log('✅ Migración aplicada (tablas creadas o ya existentes).');
  } catch (err) {
    console.error('Error migrando la base:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
