// Contraseñas, sesiones y control de acceso.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, ahoraISO } from './db.js';
import { SESION_DIAS_ADMIN, SESION_DIAS_EMPLEADO } from './config.js';

export const hashClave = (clave) => bcrypt.hash(clave, 10);
export const comprobarClave = (clave, hash) => bcrypt.compare(clave, hash);
// Hash contra el que se compara cuando el usuario no existe (mismo tiempo de respuesta).
export const HASH_SEÑUELO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
export const sha256 = (txt) => crypto.createHash('sha256').update(txt).digest('hex');
export const tokenAleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function claveAceptable(clave, rol) {
  if (typeof clave !== 'string') return 'Falta la contraseña';
  const min = rol === 'admin' ? 10 : 6;
  if (clave.length < min) return `La contraseña debe tener al menos ${min} caracteres`;
  if (clave.length > 200) return 'Contraseña demasiado larga';
  return null;
}

// ---- Bloqueo por intentos fallidos: 5 fallos en 15 minutos ----
const VENTANA_MIN = 15, MAX_FALLOS = 5;
export function bloqueado(usuario) {
  const desde = new Date(Date.now() - VENTANA_MIN * 60000).toISOString();
  db.prepare('DELETE FROM intentos WHERE ts < ?').run(desde);
  const n = db.prepare('SELECT COUNT(*) AS n FROM intentos WHERE usuario = ? AND ts >= ?').get(usuario, desde).n;
  return n >= MAX_FALLOS;
}
export const anotarFallo = (usuario) => db.prepare('INSERT INTO intentos (usuario, ts) VALUES (?, ?)').run(usuario, ahoraISO());
export const limpiarFallos = (usuario) => db.prepare('DELETE FROM intentos WHERE usuario = ?').run(usuario);

// ---- Sesiones (cookie con token aleatorio; en la base solo se guarda su hash) ----
const COOKIE = 'sid';
function leerCookie(req, nombre) {
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0 && par.slice(0, i).trim() === nombre) return decodeURIComponent(par.slice(i + 1).trim());
  }
  return null;
}

export function abrirSesion(req, res, usuario) {
  const token = tokenAleatorio();
  const dias = usuario.rol === 'admin' ? SESION_DIAS_ADMIN : SESION_DIAS_EMPLEADO;
  const expira = new Date(Date.now() + dias * 86400000);
  db.prepare('INSERT INTO sesiones (token_hash, usuario_id, creada, expira, dispositivo) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), usuario.id, ahoraISO(), expira.toISOString(), String(req.headers['user-agent'] || '').slice(0, 200));
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires: expira, path: '/' });
}

export function cerrarSesion(req, res) {
  const token = leerCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

export const cerrarSesionesDe = (usuarioId) => db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(usuarioId);

/** Middleware: carga req.usuario si hay sesión válida. */
export function cargarSesion(req, _res, next) {
  req.usuario = null;
  const token = leerCookie(req, COOKIE);
  if (token) {
    const fila = db.prepare(`SELECT u.id, u.usuario, u.nombre, u.dni, u.rol, u.horas_semana, u.debe_cambiar_clave
      FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash = ? AND s.expira > ? AND u.activo = 1`).get(sha256(token), ahoraISO());
    if (fila) req.usuario = fila;
  }
  next();
}

export function requiereSesion(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Inicia sesión' });
  next();
}
export function requiereEmpleado(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Inicia sesión' });
  if (req.usuario.rol !== 'empleado') return res.status(403).json({ error: 'Solo para trabajadores' });
  next();
}
export function requiereAdmin(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Inicia sesión' });
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo para administración' });
  next();
}

/** Protección CSRF: las peticiones que cambian algo deben llevar esta cabecera (la pone la app). */
export function requiereCabecera(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-fichajes'] !== '1') return res.status(400).json({ error: 'Petición no válida' });
  next();
}
