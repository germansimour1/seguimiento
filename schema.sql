-- Ejecutar una sola vez en el SQL Editor de Supabase (o cualquier Postgres)

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  rol TEXT NOT NULL DEFAULT 'usuario', -- 'admin' | 'usuario'
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proyectos (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  creado_por INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT now()
);

-- Con qué usuarios registrados está compartido cada proyecto
CREATE TABLE IF NOT EXISTS proyecto_usuarios (
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY (proyecto_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS tareas (
  id SERIAL PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  equipo TEXT,
  prioridad TEXT NOT NULL DEFAULT 'media', -- 'alta' | 'media' | 'baja'
  fecha_inicio DATE,
  fecha_fin DATE,
  horas_estimadas NUMERIC DEFAULT 0,
  avance_pct NUMERIC DEFAULT 0, -- 0 a 1
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tarea_dependencias (
  tarea_id INTEGER NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
  depende_de_id INTEGER NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
  PRIMARY KEY (tarea_id, depende_de_id),
  CHECK (tarea_id <> depende_de_id)
);

CREATE INDEX IF NOT EXISTS idx_tareas_proyecto ON tareas(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_dep_tarea ON tarea_dependencias(tarea_id);
CREATE INDEX IF NOT EXISTS idx_dep_depende ON tarea_dependencias(depende_de_id);
CREATE INDEX IF NOT EXISTS idx_proy_usu_usuario ON proyecto_usuarios(usuario_id);

-- Dado de alta el primer admin manualmente, reemplazá el email por el tuyo:
-- INSERT INTO usuarios (nombre, email, rol) VALUES ('Tu Nombre', 'tu@gmail.com', 'admin');

-- Deseados: auditoría, alertas por atraso y exportación
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS alertado_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS auditoria (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  proyecto_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
  accion TEXT NOT NULL, -- 'crear' | 'editar' | 'eliminar' | 'exportar' | 'compartir'
  entidad TEXT NOT NULL, -- 'proyecto' | 'tarea'
  entidad_id INTEGER,
  detalle TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_proyecto ON auditoria(proyecto_id);
