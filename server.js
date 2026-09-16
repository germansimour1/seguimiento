require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambiame';

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  Falta DATABASE_URL en el .env — nada va a funcionar hasta que lo completes.');
}
if (!process.env.GOOGLE_CLIENT_ID) {
  console.warn('⚠️  Falta GOOGLE_CLIENT_ID — el login con Google no va a funcionar hasta que lo completes.');
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

let mailer = null;
if (process.env.MAIL_USER && process.env.MAIL_APP_PASSWORD) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_APP_PASSWORD }
  });
} else {
  console.warn('⚠️  Falta MAIL_USER / MAIL_APP_PASSWORD — las alertas por email quedan desactivadas (el resto de la app funciona igual).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined
});

let mpClient = null;
if (process.env.MP_ACCESS_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
} else {
  console.warn('⚠️  Falta MP_ACCESS_TOKEN — nadie sin pago_confirmado=true va a poder loguearse hasta que esté configurado.');
}

const MONTO_MEMBRESIA = 10; // pesos argentinos, pago único

async function crearPreferenciaPago(usuario) {
  const preferenceClient = new Preference(mpClient);
  const frontendUrl = process.env.FRONTEND_URL || 'https://seguimiento-frontend.onrender.com';
  const pref = await preferenceClient.create({
    body: {
      items: [{
        title: 'Membresía de acceso — Zambo Seguimiento',
        quantity: 1,
        unit_price: MONTO_MEMBRESIA,
        currency_id: 'ARS'
      }],
      external_reference: String(usuario.id),
      back_url: { success: frontendUrl, failure: frontendUrl, pending: frontendUrl },
      notification_url: (process.env.BACKEND_URL || 'https://seguimiento-backend-e7mn.onrender.com') + '/api/pagos/webhook'
    }
  });
  return pref.init_point;
}

// Busca en vivo en Mercado Pago si ya hay un pago aprobado para este usuario
// (además del webhook, sirve de respaldo si la notificación todavía no llegó)
async function tienePagoAprobado(usuarioId) {
  if (!mpClient) return false;
  const paymentClient = new Payment(mpClient);
  const result = await paymentClient.search({
    options: { external_reference: String(usuarioId), sort: 'date_created', criteria: 'desc' }
  });
  const pagos = (result.results || []);
  return pagos.find((p) => p.status === 'approved') || null;
}

// Mercado Pago llama acá cuando cambia el estado de un pago
app.post('/api/pagos/webhook', async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query['data.id'];
    if (paymentId && mpClient) {
      const paymentClient = new Payment(mpClient);
      const pago = await paymentClient.get({ id: paymentId });
      if (pago.status === 'approved' && pago.external_reference) {
        await pool.query(
          `UPDATE usuarios SET pago_confirmado = true, pago_id = $1, pago_fecha = now() WHERE id = $2`,
          [String(pago.id), Number(pago.external_reference)]
        );
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Error procesando webhook de Mercado Pago:', err.message);
    res.sendStatus(200); // igual respondemos 200 para que MP no reintente en loop
  }
});

// ---- Login con Google ----

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Falta el credential de Google.' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = (payload.email || '').toLowerCase().trim();

    if (!payload.email_verified) {
      return res.status(401).json({ error: 'Tu cuenta de Google no tiene el email verificado.' });
    }

    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    let user = result.rows[0];
    if (!user) {
      // Regla nueva: no hace falta que un admin dé de alta a nadie antes.
      // Cualquier cuenta de Google válida puede entrar — el pago de la membresía
      // sigue siendo el filtro real de acceso (se chequea más abajo).
      const nombreGoogle = payload.name || email.split('@')[0];
      const countRes = await pool.query('SELECT COUNT(*) FROM usuarios');
      const esElPrimero = Number(countRes.rows[0].count) === 0;
      const insertRes = await pool.query(
        `INSERT INTO usuarios (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *`,
        [nombreGoogle, email, esElPrimero ? 'admin' : 'usuario']
      );
      user = insertRes.rows[0];
    }

    if (!user.pago_confirmado && mpClient) {
      // Respaldo: chequeamos en vivo por si el webhook todavía no llegó
      const pagoAprobado = await tienePagoAprobado(user.id);
      if (pagoAprobado) {
        await pool.query(
          `UPDATE usuarios SET pago_confirmado = true, pago_id = $1, pago_fecha = now() WHERE id = $2`,
          [String(pagoAprobado.id), user.id]
        );
        user.pago_confirmado = true;
      }
    }

    // Mientras Mercado Pago no esté configurado (falta MP_ACCESS_TOKEN), el pago
    // no bloquea el acceso — se activa solo cuando se cargue esa variable.
    if (!user.pago_confirmado && mpClient) {
      const initPoint = await crearPreferenciaPago(user);
      return res.status(402).json({
        error: 'pago_requerido',
        mensaje: 'Para entrar por primera vez hace falta abonar la membresía de acceso.',
        initPoint,
        monto: MONTO_MEMBRESIA,
        moneda: 'ARS'
      });
    }

    const token = jwt.sign(
      { sub: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, nombre: user.nombre, email: user.email, rol: user.rol });
  } catch (err) {
    res.status(401).json({ error: 'No se pudo verificar el login de Google: ' + err.message });
  }
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta iniciar sesión.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida o vencida, volvé a iniciar sesión.' });
  }
}

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ nombre: req.user.nombre, email: req.user.email, rol: req.user.rol });
});

// Endpoint interno para crear usuarios sin necesitar acceso externo a la base.
// Protegido con SETUP_SECRET (variable de entorno). Corre dentro de la red de Render,
// así que usa la misma conexión interna que el resto del backend.
app.post('/api/setup/crear-usuario', async (req, res) => {
  const { nombre, email, rol, secret } = req.body;
  if (!process.env.SETUP_SECRET || secret !== process.env.SETUP_SECRET) {
    return res.status(403).json({ error: 'Clave incorrecta.' });
  }
  if (!nombre || !email) {
    return res.status(400).json({ error: 'Faltan nombre o email.' });
  }
  const rolFinal = rol === 'admin' ? 'admin' : 'usuario';
  try {
    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, rol) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre, rol = EXCLUDED.rol
       RETURNING id, nombre, email, rol`,
      [nombre, email.toLowerCase().trim(), rolFinal]
    );
    res.json({ ok: true, usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', requireAuth);

async function registrarAuditoria({ usuario, proyectoId, accion, entidad, entidadId, detalle }) {
  try {
    await pool.query(
      `INSERT INTO auditoria (usuario_id, usuario_nombre, proyecto_id, accion, entidad, entidad_id, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [usuario.sub, usuario.nombre, proyectoId, accion, entidad, entidadId || null, detalle || null]
    );
  } catch (err) {
    console.error('No se pudo registrar auditoría:', err.message);
  }
}

// ---- Chat interno del proyecto ----

app.get('/api/proyectos/:id/mensajes', async (req, res) => {
  const proyectoId = req.params.id;
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }
    const result = await pool.query(
      `SELECT * FROM mensajes WHERE proyecto_id = $1 ORDER BY created_at ASC LIMIT 300`,
      [proyectoId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proyectos/:id/mensajes', async (req, res) => {
  const proyectoId = req.params.id;
  const { texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }
    const result = await pool.query(
      `INSERT INTO mensajes (proyecto_id, usuario_id, usuario_nombre, texto) VALUES ($1,$2,$3,$4) RETURNING *`,
      [proyectoId, req.user.sub, req.user.nombre, texto.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proyectos/:id/auditoria', async (req, res) => {
  const proyectoId = req.params.id;
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }
    const result = await pool.query(
      `SELECT * FROM auditoria WHERE proyecto_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [proyectoId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proyectos/:id/auditoria/exportar', async (req, res) => {
  const proyectoId = req.params.id;
  const { tipo } = req.body; // 'pdf' | 'excel'
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }
    await registrarAuditoria({
      usuario: req.user, proyectoId, accion: 'exportar', entidad: 'proyecto',
      entidadId: proyectoId, detalle: 'Exportó tareas a ' + (tipo || 'archivo')
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function verificarYAlertar(proyectoId, tareas) {
  if (!mailer) return 0;
  const hoyStr = new Date().toISOString().slice(0, 10);
  const nuevasAtrasadas = tareas.filter((t) => t.estado === 'atrasada' && !t.alertado_at);
  if (nuevasAtrasadas.length === 0) return 0;

  try {
    const proyectoRes = await pool.query('SELECT p.*, u.email AS email_dueno, u.nombre AS nombre_dueno FROM proyectos p JOIN usuarios u ON u.id = p.creado_por WHERE p.id = $1', [proyectoId]);
    const proyecto = proyectoRes.rows[0];
    if (!proyecto) return 0;

    const listaHtml = nuevasAtrasadas.map((t) =>
      '<li><b>' + t.nombre + '</b> (equipo: ' + (t.equipo || 'sin asignar') + ') — vencía el ' + t.fecha_fin + '</li>'
    ).join('');

    await mailer.sendMail({
      from: process.env.MAIL_USER,
      to: proyecto.email_dueno,
      subject: '⚠️ Tareas atrasadas en "' + proyecto.nombre + '"',
      html: '<p>Hola ' + proyecto.nombre_dueno + ', estas tareas de tu proyecto <b>' + proyecto.nombre + '</b> están atrasadas:</p><ul>' + listaHtml + '</ul>'
    });

    const ids = nuevasAtrasadas.map((t) => t.id);
    await pool.query('UPDATE tareas SET alertado_at = now() WHERE id = ANY($1::int[])', [ids]);
    return ids.length;
  } catch (err) {
    console.error('No se pudo enviar la alerta por email:', err.message);
    return 0;
  }
}

// ---- Usuarios registrados (para el selector de "compartir") ----

app.get('/api/usuarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nombre, email, rol FROM usuarios ORDER BY nombre');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Proyectos ----

async function tieneAccesoProyecto(proyectoId, userId) {
  const result = await pool.query(
    `SELECT 1 FROM proyectos WHERE id = $1 AND creado_por = $2
     UNION
     SELECT 1 FROM proyecto_usuarios WHERE proyecto_id = $1 AND usuario_id = $2`,
    [proyectoId, userId]
  );
  return result.rows.length > 0;
}

app.get('/api/proyectos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT p.*, (p.creado_por = $1) AS es_propietario
       FROM proyectos p
       LEFT JOIN proyecto_usuarios pu ON pu.proyecto_id = p.id
       WHERE p.creado_por = $1 OR pu.usuario_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.sub]
    );

    const compartidosRes = await pool.query(
      `SELECT pu.proyecto_id, u.id, u.nombre, u.email
       FROM proyecto_usuarios pu JOIN usuarios u ON u.id = pu.usuario_id`
    );
    const compartidosPorProyecto = {};
    compartidosRes.rows.forEach((r) => {
      if (!compartidosPorProyecto[r.proyecto_id]) compartidosPorProyecto[r.proyecto_id] = [];
      compartidosPorProyecto[r.proyecto_id].push({ id: r.id, nombre: r.nombre, email: r.email });
    });

    res.json(result.rows.map((p) => ({ ...p, compartido_con: compartidosPorProyecto[p.id] || [] })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proyectos', async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del proyecto.' });
  try {
    const result = await pool.query(
      `INSERT INTO proyectos (nombre, descripcion, creado_por) VALUES ($1,$2,$3) RETURNING *`,
      [nombre, descripcion || null, req.user.sub]
    );
    await registrarAuditoria({ usuario: req.user, proyectoId: result.rows[0].id, accion: 'crear', entidad: 'proyecto', entidadId: result.rows[0].id, detalle: nombre });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/proyectos/:id', async (req, res) => {
  try {
    const check = await pool.query('SELECT creado_por FROM proyectos WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Proyecto no encontrado.' });
    if (check.rows[0].creado_por !== req.user.sub) {
      return res.status(403).json({ error: 'Solo quien creó el proyecto lo puede eliminar.' });
    }
    await pool.query('DELETE FROM proyectos WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compartir: reemplaza la lista completa de usuarios con los que está compartido
app.put('/api/proyectos/:id/compartir', async (req, res) => {
  const { usuario_ids } = req.body;
  const proyectoId = req.params.id;
  try {
    const check = await pool.query('SELECT creado_por FROM proyectos WHERE id = $1', [proyectoId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Proyecto no encontrado.' });
    if (check.rows[0].creado_por !== req.user.sub) {
      return res.status(403).json({ error: 'Solo quien creó el proyecto puede compartirlo.' });
    }

    await pool.query('DELETE FROM proyecto_usuarios WHERE proyecto_id = $1', [proyectoId]);
    for (const usuarioId of (usuario_ids || [])) {
      if (Number(usuarioId) !== req.user.sub) {
        await pool.query(
          'INSERT INTO proyecto_usuarios (proyecto_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [proyectoId, usuarioId]
        );
      }
    }
    await registrarAuditoria({ usuario: req.user, proyectoId, accion: 'compartir', entidad: 'proyecto', entidadId: proyectoId, detalle: (usuario_ids || []).length + ' usuario(s)' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Tareas (siempre dentro de un proyecto) ----

function calcularEstado(t, hoyStr) {
  const avance = Number(t.avance_pct) || 0;
  if (avance >= 1) return 'completada';
  if (t.fecha_fin && t.fecha_fin < hoyStr) return 'atrasada';
  return 'pendiente';
}

async function tareasDeProyecto(proyectoId) {
  const tareasRes = await pool.query(
    'SELECT * FROM tareas WHERE proyecto_id = $1 ORDER BY fecha_inicio NULLS LAST, id',
    [proyectoId]
  );
  const depsRes = await pool.query(
    `SELECT d.tarea_id, d.depende_de_id, t.nombre AS depende_de_nombre
     FROM tarea_dependencias d
     JOIN tareas t ON t.id = d.depende_de_id
     WHERE d.tarea_id IN (SELECT id FROM tareas WHERE proyecto_id = $1)`,
    [proyectoId]
  );

  const hoyStr = new Date().toISOString().slice(0, 10);
  const depsPorTarea = {};
  depsRes.rows.forEach((d) => {
    if (!depsPorTarea[d.tarea_id]) depsPorTarea[d.tarea_id] = [];
    depsPorTarea[d.tarea_id].push({ id: d.depende_de_id, nombre: d.depende_de_nombre });
  });

  return tareasRes.rows.map((t) => {
    const fecha_inicio = t.fecha_inicio ? t.fecha_inicio.toISOString().slice(0, 10) : null;
    const fecha_fin = t.fecha_fin ? t.fecha_fin.toISOString().slice(0, 10) : null;
    return {
      ...t,
      fecha_inicio,
      fecha_fin,
      estado: calcularEstado({ avance_pct: t.avance_pct, fecha_fin }, hoyStr),
      dependencias: depsPorTarea[t.id] || []
    };
  });
}

app.get('/api/proyectos/:id/tareas', async (req, res) => {
  const proyectoId = req.params.id;
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }
    res.json(await tareasDeProyecto(proyectoId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proyectos/:id/dashboard', async (req, res) => {
  const proyectoId = req.params.id;
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }
    const tareas = await tareasDeProyecto(proyectoId);
    const alertasEnviadas = await verificarYAlertar(proyectoId, tareas);
    const total = tareas.length;
    const avanceGeneral = total ? tareas.reduce((s, t) => s + (Number(t.avance_pct) || 0), 0) / total : 0;
    const horasTotales = tareas.reduce((s, t) => s + (Number(t.horas_estimadas) || 0), 0);
    const pendientes = tareas.filter((t) => t.estado === 'pendiente').length;
    const completadas = tareas.filter((t) => t.estado === 'completada').length;
    const atrasadas = tareas.filter((t) => t.estado === 'atrasada').length;
    res.json({ totalTareas: total, avanceGeneral, horasTotales, pendientes, completadas, atrasadas, alertasEnviadas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proyectos/:id/tareas', async (req, res) => {
  const proyectoId = req.params.id;
  const { nombre, equipo, prioridad, fecha_inicio, fecha_fin, horas_estimadas, avance_pct, dependencias } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la tarea.' });

  const client = await pool.connect();
  try {
    if (!(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto.' });
    }

    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO tareas (proyecto_id, nombre, equipo, prioridad, fecha_inicio, fecha_fin, horas_estimadas, avance_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [proyectoId, nombre, equipo || null, prioridad || 'media', fecha_inicio || null, fecha_fin || null,
       horas_estimadas || 0, avance_pct || 0]
    );
    const id = result.rows[0].id;

    if (Array.isArray(dependencias)) {
      for (const depId of dependencias) {
        if (Number(depId) !== id) {
          await client.query(
            'INSERT INTO tarea_dependencias (tarea_id, depende_de_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [id, depId]
          );
        }
      }
    }

    await client.query('COMMIT');
    await registrarAuditoria({ usuario: req.user, proyectoId, accion: 'crear', entidad: 'tarea', entidadId: id, detalle: nombre });
    res.status(201).json({ id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

async function proyectoDeTarea(tareaId) {
  const r = await pool.query('SELECT proyecto_id FROM tareas WHERE id = $1', [tareaId]);
  return r.rows[0] ? r.rows[0].proyecto_id : null;
}

app.put('/api/tareas/:id', async (req, res) => {
  const id = req.params.id;
  const { nombre, equipo, prioridad, fecha_inicio, fecha_fin, horas_estimadas, avance_pct, dependencias } = req.body;

  const client = await pool.connect();
  try {
    const proyectoId = await proyectoDeTarea(id);
    if (!proyectoId || !(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a esta tarea.' });
    }

    await client.query('BEGIN');
    const fields = { nombre, equipo, prioridad, fecha_inicio, fecha_fin, horas_estimadas, avance_pct };
    const sets = [];
    const params = [];
    Object.keys(fields).forEach((k) => {
      if (fields[k] !== undefined) {
        params.push(fields[k]);
        sets.push(`${k} = $${params.length}`);
      }
    });
    if (sets.length) {
      params.push(id);
      await client.query(`UPDATE tareas SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    }

    if (Array.isArray(dependencias)) {
      await client.query('DELETE FROM tarea_dependencias WHERE tarea_id = $1', [id]);
      for (const depId of dependencias) {
        if (Number(depId) !== Number(id)) {
          await client.query(
            'INSERT INTO tarea_dependencias (tarea_id, depende_de_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [id, depId]
          );
        }
      }
    }

    await client.query('COMMIT');
    await registrarAuditoria({ usuario: req.user, proyectoId, accion: 'editar', entidad: 'tarea', entidadId: id, detalle: nombre || null });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/tareas/:id', async (req, res) => {
  try {
    const proyectoId = await proyectoDeTarea(req.params.id);
    if (!proyectoId || !(await tieneAccesoProyecto(proyectoId, req.user.sub))) {
      return res.status(403).json({ error: 'No tenés acceso a esta tarea.' });
    }
    const tareaRes = await pool.query('SELECT nombre FROM tareas WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM tareas WHERE id = $1', [req.params.id]);
    await registrarAuditoria({ usuario: req.user, proyectoId, accion: 'eliminar', entidad: 'tarea', entidadId: req.params.id, detalle: tareaRes.rows[0] ? tareaRes.rows[0].nombre : null });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend de seguimiento (v2, con proyectos y roles) corriendo en http://localhost:${PORT}`);
});
