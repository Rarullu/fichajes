// Base de datos SQLite (integrada en Node) y registro inalterable de fichajes.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'fichajes.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY,
    usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nombre TEXT NOT NULL,
    dni TEXT NOT NULL DEFAULT '',
    rol TEXT NOT NULL CHECK (rol IN ('empleado','admin')),
    clave_hash TEXT NOT NULL,
    horas_semana REAL NOT NULL DEFAULT 40,
    activo INTEGER NOT NULL DEFAULT 1,
    debe_cambiar_clave INTEGER NOT NULL DEFAULT 0,
    alta TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    creada TEXT NOT NULL,
    expira TEXT NOT NULL,
    dispositivo TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS intentos (
    usuario TEXT NOT NULL COLLATE NOCASE,
    ts TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lugares (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    activo INTEGER NOT NULL DEFAULT 1
  );

  -- Registro de fichajes: SOLO se añade. Nunca se modifica ni se borra.
  -- Una corrección es un evento nuevo (manual o 'anulacion') con autor y motivo.
  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida','pausa_inicio','pausa_fin','anulacion')),
    ts TEXT NOT NULL,            -- momento al que se refiere el fichaje (UTC ISO)
    ts_registro TEXT NOT NULL,   -- momento en que el servidor lo anotó (UTC ISO)
    lugar_id INTEGER REFERENCES lugares(id),
    lat TEXT, lon TEXT, precision_m TEXT,
    origen TEXT NOT NULL CHECK (origen IN ('app','sin_conexion','manual')),
    autor_id INTEGER NOT NULL REFERENCES usuarios(id),
    motivo TEXT,
    anula_id INTEGER REFERENCES eventos(id),
    id_cliente TEXT UNIQUE,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS eventos_usuario_ts ON eventos(usuario_id, ts);

  CREATE TRIGGER IF NOT EXISTS eventos_no_update BEFORE UPDATE ON eventos
    BEGIN SELECT RAISE(ABORT, 'El registro de fichajes es inalterable'); END;
  CREATE TRIGGER IF NOT EXISTS eventos_no_delete BEFORE DELETE ON eventos
    BEGIN SELECT RAISE(ABORT, 'El registro de fichajes es inalterable'); END;

  CREATE TABLE IF NOT EXISTS solicitudes (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    accion TEXT NOT NULL CHECK (accion IN ('anadir','anular')),
    tipo TEXT,                 -- para 'anadir': entrada/salida/pausa_inicio/pausa_fin
    ts TEXT,                   -- para 'anadir': momento propuesto (UTC ISO)
    evento_id INTEGER REFERENCES eventos(id),  -- para 'anular'
    motivo TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada')),
    creada TEXT NOT NULL,
    resuelta TEXT, resuelta_por INTEGER REFERENCES usuarios(id), respuesta TEXT
  );

  CREATE TABLE IF NOT EXISTS ausencias (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('vacaciones','baja','permiso','otro')),
    desde TEXT NOT NULL, hasta TEXT NOT NULL,   -- fechas YYYY-MM-DD, ambas incluidas
    nota TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada')),
    creada TEXT NOT NULL, creada_por INTEGER NOT NULL REFERENCES usuarios(id),
    resuelta TEXT, resuelta_por INTEGER REFERENCES usuarios(id)
  );

  CREATE TABLE IF NOT EXISTS festivos (
    fecha TEXT PRIMARY KEY,
    nombre TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS opciones (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  -- Traza de acciones de administración y accesos (quién hizo qué y cuándo).
  CREATE TABLE IF NOT EXISTS actividad (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    usuario_id INTEGER,
    accion TEXT NOT NULL,
    detalle TEXT NOT NULL DEFAULT ''
  );
`);

export const ahoraISO = () => new Date().toISOString();

export function opcion(clave, porDefecto) {
  const f = db.prepare('SELECT valor FROM opciones WHERE clave = ?').get(clave);
  return f ? f.valor : porDefecto;
}
export function guardarOpcion(clave, valor) {
  db.prepare('INSERT INTO opciones (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, String(valor));
}

export function anotarActividad(usuarioId, accion, detalle = '') {
  db.prepare('INSERT INTO actividad (ts, usuario_id, accion, detalle) VALUES (?, ?, ?, ?)')
    .run(ahoraISO(), usuarioId ?? null, accion, String(detalle).slice(0, 500));
}

// ---- Cadena de hashes ----
const GENESIS = '0'.repeat(64);

export function hashEvento(prev, e) {
  const canon = JSON.stringify([
    prev, e.id, e.usuario_id, e.tipo, e.ts, e.ts_registro, e.lugar_id ?? null,
    e.lat ?? null, e.lon ?? null, e.precision_m ?? null, e.origen, e.autor_id,
    e.motivo ?? null, e.anula_id ?? null, e.id_cliente ?? null,
  ]);
  return crypto.createHash('sha256').update(canon).digest('hex');
}

const insertar = db.prepare(`INSERT INTO eventos
  (id, usuario_id, tipo, ts, ts_registro, lugar_id, lat, lon, precision_m, origen, autor_id, motivo, anula_id, id_cliente, prev_hash, hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Añade un evento al registro encadenándolo con el anterior. Devuelve el evento completo. */
export function anadirEvento(datos) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const ultimo = db.prepare('SELECT id, hash FROM eventos ORDER BY id DESC LIMIT 1').get();
    const e = {
      id: (ultimo?.id ?? 0) + 1,
      usuario_id: datos.usuario_id,
      tipo: datos.tipo,
      ts: datos.ts,
      ts_registro: ahoraISO(),
      lugar_id: datos.lugar_id ?? null,
      lat: datos.lat ?? null, lon: datos.lon ?? null, precision_m: datos.precision_m ?? null,
      origen: datos.origen,
      autor_id: datos.autor_id,
      motivo: datos.motivo ?? null,
      anula_id: datos.anula_id ?? null,
      id_cliente: datos.id_cliente ?? null,
    };
    e.prev_hash = ultimo?.hash ?? GENESIS;
    e.hash = hashEvento(e.prev_hash, e);
    insertar.run(e.id, e.usuario_id, e.tipo, e.ts, e.ts_registro, e.lugar_id, e.lat, e.lon, e.precision_m,
      e.origen, e.autor_id, e.motivo, e.anula_id, e.id_cliente, e.prev_hash, e.hash);
    db.exec('COMMIT');
    return e;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Recalcula toda la cadena. Si alguien tocó la base de datos por fuera, lo detecta. */
export function verificarCadena() {
  let prev = GENESIS, n = 0, esperado = 1;
  for (const e of db.prepare('SELECT * FROM eventos ORDER BY id').iterate()) {
    if (e.id !== esperado) return { ok: false, eventos: n, fallo: `Falta el evento nº ${esperado} (hay un hueco en el registro)` };
    if (e.prev_hash !== prev || e.hash !== hashEvento(prev, e)) {
      return { ok: false, eventos: n, fallo: `El evento nº ${e.id} no coincide con su huella` };
    }
    prev = e.hash; n++; esperado++;
  }
  return { ok: true, eventos: n, ultimoHash: prev };
}

export function ultimoHash() {
  return db.prepare('SELECT hash FROM eventos ORDER BY id DESC LIMIT 1').get()?.hash ?? GENESIS;
}

export function eventosDe(usuarioId) {
  return db.prepare(`SELECT e.*, l.nombre AS lugar, a.nombre AS autor
    FROM eventos e LEFT JOIN lugares l ON l.id = e.lugar_id LEFT JOIN usuarios a ON a.id = e.autor_id
    WHERE e.usuario_id = ? ORDER BY e.ts, e.id`).all(usuarioId);
}
