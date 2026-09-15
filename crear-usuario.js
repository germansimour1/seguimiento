require('dotenv').config();
const { Pool } = require('pg');

const [nombre, email, rol] = process.argv.slice(2);

if (!nombre || !email) {
  console.error('Uso: node crear-usuario.js "Nombre Apellido" email@gmail.com [admin|usuario]');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('❌ Falta DATABASE_URL en tu archivo .env');
  process.exit(1);
}

const rolFinal = (rol === 'admin') ? 'admin' : 'usuario';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, rol) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre, rol = EXCLUDED.rol
       RETURNING id, nombre, email, rol`,
      [nombre, email.toLowerCase().trim(), rolFinal]
    );
    console.log('✅ Usuario registrado en Zambo:', result.rows[0]);
  } catch (err) {
    console.error('Error creando el usuario:', err.message);
  } finally {
    await pool.end();
  }
}

main();
