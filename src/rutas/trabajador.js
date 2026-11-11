// Rutas de sesión y del trabajador: fichar, consultar su registro, pedir correcciones y ausencias.
import { Router } from 'express';
import { db, anadirEvento, eventosDe, ahoraISO, opcion, anotarActividad } from '../db.js';
import { EMPRESA, TZ, OFFLINE_MAX_HORAS } from '../config.js';
import {
  hashClave, comprobarClave, claveAceptable, bloqueado, anotarFallo, limpiarFallos,
  abrirSesion, cerrarSesion, requiereSesion, requiereEmpleado, HASH_SEÑUELO,
} from '../seguridad.js';
import { TIPOS, efectivos, estadoActual, permitido, localAUtc, mesValido, fechaValida, fechaLocal } from '../jornada.js';
import { datosMes, situacion, NOMBRE_TIPO } from '../datos.js';
import { informePdf } from '../pdf.js';

export const rutas = Router();
const hayAdmin = () => !!db.prepare("SELECT 1 FROM usuarios WHERE rol = 'admin' LIMIT 1").get();
const txt = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// ---- Estado general de la app ----
rutas.get('/estado', (req, res) => {
  res.json({
    configurado: hayAdmin(),
    sesion: req.usuario && {
      id: req.usuario.id, nombre: req.usuario.nombre, usuario: req.usuario.usuario, rol: req.usuario.rol,
      debeCambiarClave: !!req.usuario.debe_cambiar_clave,
    },
    empresa: EMPRESA.nombre, zona: TZ,
    opciones: { geo: opcion('geo', '1') === '1', requiereLugar: opcion('requiere_lugar', '0') === '1' },
  });
});

// ---- Primer arranque: crear al administrador ----
rutas.post('/configurar', async (req, res) => {
  if (hayAdmin()) return res.status(409).json({ error: 'La aplicación ya está configurada' });
  const usuario = txt(req.body.usuario, 40), nombre = txt(req.body.nombre, 100);
  if (!/^[a-z0-9._-]{3,40}$/i.test(usuario) || !nombre) return res.status(400).json({ error: 'Revisa el nombre y el usuario (3 a 40 letras o números)' });
  const mal = claveAceptable(req.body.clave, 'admin');
  if (mal) return res.status(400).json({ error: mal });
  const r = db.prepare("INSERT INTO usuarios (usuario, nombre, rol, clave_hash, alta) VALUES (?, ?, 'admin', ?, ?)")
    .run(usuario, nombre, await hashClave(req.body.clave), ahoraISO());
  const u = { id: Number(r.lastInsertRowid), rol: 'admin' };
  anotarActividad(u.id, 'configuracion_inicial', usuario);
  abrirSesion(req, res, u);
  res.json({ ok: true });
});

// ---- Sesión ----
rutas.post('/entrar', async (req, res) => {
  const usuario = txt(req.body.usuario, 40), clave = String(req.body.clave ?? '');
  if (!usuario || !clave) return res.status(400).json({ error: 'Escribe usuario y contraseña' });
  if (bloqueado(usuario)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario);
  // Se compara siempre contra un hash para no revelar si el usuario existe.
  const ok = await comprobarClave(clave, u?.clave_hash || HASH_SEÑUELO);
  if (!u || !ok) {
    anotarFallo(usuario);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  limpiarFallos(usuario);
  abrirSesion(req, res, u);
  anotarActividad(u.id, 'inicio_sesion');
  res.json({ ok: true });
});

rutas.post('/salir', (req, res) => { cerrarSesion(req, res); res.json({ ok: true }); });

rutas.post('/clave', requiereSesion, async (req, res) => {
  const fila = db.prepare('SELECT clave_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (!(await comprobarClave(String(req.body.actual ?? ''), fila.clave_hash))) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  const mal = claveAceptable(req.body.nueva, req.usuario.rol);
  if (mal) return res.status(400).json({ error: mal });
  db.prepare('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 0 WHERE id = ?').run(await hashClave(req.body.nueva), req.usuario.id);
  anotarActividad(req.usuario.id, 'cambio_clave');
  res.json({ ok: true });
});

// ---- Lugar de una etiqueta NFC ----
rutas.get('/lugar/:token', requiereSesion, (req, res) => {
  const l = db.prepare('SELECT nombre FROM lugares WHERE token = ? AND activo = 1').get(req.params.token);
  if (!l) return res.status(404).json({ error: 'Etiqueta no reconocida' });
  res.json(l);
});

// ---- Fichar ----
rutas.get('/mi/situacion', requiereEmpleado, (req, res) => res.json(situacion(req.usuario.id)));

rutas.post('/fichar', requiereEmpleado, (req, res) => {
  const u = req.usuario, b = req.body || {};
  if (!TIPOS.includes(b.tipo)) return res.status(400).json({ error: 'Tipo de fichaje no válido' });

  // Idempotencia: si este fichaje ya llegó (reintento de la cola sin conexión), no se duplica.
  const idCliente = b.id_cliente ? `${u.id}:${txt(b.id_cliente, 64)}` : null;
  if (idCliente && db.prepare('SELECT 1 FROM eventos WHERE id_cliente = ?').get(idCliente)) {
    return res.json({ ok: true, repetido: true, ...situacion(u.id) });
  }

  let lugarId = null;
  if (b.lugar) {
    const l = db.prepare('SELECT id FROM lugares WHERE token = ? AND activo = 1').get(txt(b.lugar, 80));
    if (l) lugarId = l.id;
  }
  if (!lugarId && opcion('requiere_lugar', '0') === '1') {
    return res.status(400).json({ error: 'Acerca el móvil a la etiqueta NFC del lugar de trabajo para fichar', codigo: 'falta_lugar' });
  }

  const efs = efectivos(eventosDe(u.id));
  const ahora = ahoraISO();
  let ts = ahora, origen = 'app';
  if (b.ts_cliente) {
    // Fichaje hecho sin conexión: se respeta su hora si es creíble.
    const t = Date.parse(b.ts_cliente);
    const ultimo = efs[efs.length - 1];
    const creible = Number.isFinite(t) && t <= Date.now() + 120000
      && t >= Date.now() - OFFLINE_MAX_HORAS * 3600000
      && (!ultimo || t > Date.parse(ultimo.ts));
    if (!creible) {
      return res.status(409).json({ error: 'Ese fichaje sin conexión ya no se puede anotar. Pide una corrección.', codigo: 'sin_conexion_rechazado' });
    }
    ts = new Date(t).toISOString(); origen = 'sin_conexion';
  }

  const { estado } = estadoActual(efs);
  if (!permitido(estado, b.tipo)) {
    return res.status(409).json({ error: `No puedes registrar "${NOMBRE_TIPO[b.tipo]}" ahora`, codigo: 'secuencia', ...situacion(u.id) });
  }

  const num = (v, dec) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v).toFixed(dec) : null);
  const conGeo = opcion('geo', '1') === '1';
  anadirEvento({
    usuario_id: u.id, tipo: b.tipo, ts, origen, autor_id: u.id, lugar_id: lugarId, id_cliente: idCliente,
    lat: conGeo ? num(b.lat, 6) : null, lon: conGeo ? num(b.lon, 6) : null, precision_m: conGeo ? num(b.precision, 0) : null,
  });
  res.json({ ok: true, ...situacion(u.id) });
});

// ---- Consulta del propio registro ----
rutas.get('/mi/mes', requiereEmpleado, (req, res) => {
  const mes = mesValido(req.query.mes) ? req.query.mes : fechaLocal(ahoraISO()).slice(0, 7);
  res.json(datosMes(req.usuario, mes));
});

rutas.get('/mi/informe.pdf', requiereEmpleado, (req, res) => {
  if (!mesValido(req.query.mes)) return res.status(400).json({ error: 'Mes no válido' });
  informePdf(res, req.usuario, req.query.mes, req.usuario.nombre);
});

// ---- Solicitudes de corrección ----
rutas.get('/mi/solicitudes', requiereEmpleado, (req, res) => {
  res.json(db.prepare('SELECT * FROM solicitudes WHERE usuario_id = ? ORDER BY id DESC LIMIT 50').all(req.usuario.id));
});

rutas.post('/mi/solicitudes', requiereEmpleado, (req, res) => {
  const b = req.body || {}, motivo = txt(b.motivo, 300);
  if (motivo.length < 5) return res.status(400).json({ error: 'Explica el motivo de la corrección' });
  if (b.accion === 'anadir') {
    const ts = localAUtc(b.momento);
    if (!TIPOS.includes(b.tipo) || !ts) return res.status(400).json({ error: 'Indica el tipo de fichaje, el día y la hora' });
    if (Date.parse(ts) > Date.now()) return res.status(400).json({ error: 'La hora no puede ser futura' });
    db.prepare("INSERT INTO solicitudes (usuario_id, accion, tipo, ts, motivo, creada) VALUES (?, 'anadir', ?, ?, ?, ?)")
      .run(req.usuario.id, b.tipo, ts, motivo, ahoraISO());
  } else if (b.accion === 'anular') {
    const e = db.prepare("SELECT id FROM eventos WHERE id = ? AND usuario_id = ? AND tipo <> 'anulacion'").get(Number(b.evento_id), req.usuario.id);
    if (!e) return res.status(400).json({ error: 'Fichaje no encontrado' });
    db.prepare("INSERT INTO solicitudes (usuario_id, accion, evento_id, motivo, creada) VALUES (?, 'anular', ?, ?, ?)")
      .run(req.usuario.id, e.id, motivo, ahoraISO());
  } else return res.status(400).json({ error: 'Solicitud no válida' });
  res.json({ ok: true });
});

// ---- Ausencias (vacaciones, permisos) ----
rutas.get('/mi/ausencias', requiereEmpleado, (req, res) => {
  res.json(db.prepare('SELECT * FROM ausencias WHERE usuario_id = ? ORDER BY desde DESC LIMIT 100').all(req.usuario.id));
});

rutas.post('/mi/ausencias', requiereEmpleado, (req, res) => {
  const b = req.body || {};
  if (!['vacaciones', 'permiso', 'otro'].includes(b.tipo)) return res.status(400).json({ error: 'Tipo no válido' });
  if (!fechaValida(b.desde) || !fechaValida(b.hasta) || b.hasta < b.desde) return res.status(400).json({ error: 'Revisa las fechas' });
  db.prepare('INSERT INTO ausencias (usuario_id, tipo, desde, hasta, nota, creada, creada_por) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, b.tipo, b.desde, b.hasta, txt(b.nota, 200), ahoraISO(), req.usuario.id);
  res.json({ ok: true });
});
