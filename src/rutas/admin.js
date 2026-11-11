// Rutas de administración: panel, trabajadores, lugares NFC, correcciones, ausencias, festivos, informes.
import { Router } from 'express';
import { db, anadirEvento, ahoraISO, opcion, guardarOpcion, anotarActividad, verificarCadena } from '../db.js';
import { hashClave, claveAceptable, tokenAleatorio, cerrarSesionesDe, requiereAdmin } from '../seguridad.js';
import { TIPOS, localAUtc, mesValido, fechaValida, fechaLocal, horaLocal } from '../jornada.js';
import { datosMes, situacion, incidenciasRecientes, usuarioPorId, NOMBRE_TIPO } from '../datos.js';
import { informePdf } from '../pdf.js';
import { EMPRESA, TZ } from '../config.js';

export const admin = Router();
admin.use(requiereAdmin);
const txt = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const trabajador = (id) => {
  const u = usuarioPorId(Number(id));
  return u && u.rol === 'empleado' ? u : null;
};

// ---- Panel ----
admin.get('/panel', (_req, res) => {
  const empleados = db.prepare("SELECT id, nombre FROM usuarios WHERE rol = 'empleado' AND activo = 1 ORDER BY nombre").all()
    .map((u) => ({ ...u, ...situacion(u.id), incidencias: incidenciasRecientes(u.id) }));
  res.json({
    empleados,
    pendientes: {
      solicitudes: db.prepare("SELECT COUNT(*) AS n FROM solicitudes WHERE estado = 'pendiente'").get().n,
      ausencias: db.prepare("SELECT COUNT(*) AS n FROM ausencias WHERE estado = 'pendiente'").get().n,
    },
  });
});

// ---- Trabajadores y administradores ----
admin.get('/usuarios', (_req, res) => {
  res.json(db.prepare('SELECT id, usuario, nombre, dni, rol, horas_semana, activo, alta FROM usuarios ORDER BY activo DESC, rol, nombre').all());
});

admin.post('/usuarios', async (req, res) => {
  const b = req.body || {};
  const usuario = txt(b.usuario, 40), nombre = txt(b.nombre, 100), rol = b.rol === 'admin' ? 'admin' : 'empleado';
  if (!/^[a-z0-9._-]{3,40}$/i.test(usuario) || !nombre) return res.status(400).json({ error: 'Revisa el nombre y el usuario (3 a 40 letras o números, sin espacios)' });
  const mal = claveAceptable(b.clave, rol);
  if (mal) return res.status(400).json({ error: mal });
  if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario)) return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
  const horas = Number(b.horas_semana);
  db.prepare('INSERT INTO usuarios (usuario, nombre, dni, rol, clave_hash, horas_semana, debe_cambiar_clave, alta) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(usuario, nombre, txt(b.dni, 20), rol, await hashClave(b.clave), horas > 0 && horas <= 60 ? horas : 40, ahoraISO());
  anotarActividad(req.usuario.id, 'alta_usuario', `${usuario} (${rol})`);
  res.json({ ok: true });
});

admin.patch('/usuarios/:id', async (req, res) => {
  const u = usuarioPorId(Number(req.params.id)), b = req.body || {};
  if (!u) return res.status(404).json({ error: 'No existe' });
  if (b.nombre !== undefined && txt(b.nombre, 100)) db.prepare('UPDATE usuarios SET nombre = ? WHERE id = ?').run(txt(b.nombre, 100), u.id);
  if (b.dni !== undefined) db.prepare('UPDATE usuarios SET dni = ? WHERE id = ?').run(txt(b.dni, 20), u.id);
  if (b.horas_semana !== undefined) {
    const h = Number(b.horas_semana);
    if (!(h > 0 && h <= 60)) return res.status(400).json({ error: 'Horas semanales no válidas' });
    db.prepare('UPDATE usuarios SET horas_semana = ? WHERE id = ?').run(h, u.id);
  }
  if (b.activo !== undefined) {
    if (u.id === req.usuario.id) return res.status(400).json({ error: 'No puedes darte de baja a ti mismo' });
    db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(b.activo ? 1 : 0, u.id);
    if (!b.activo) cerrarSesionesDe(u.id);   // el registro se conserva; solo deja de poder entrar
  }
  if (b.clave !== undefined) {
    const mal = claveAceptable(b.clave, u.rol);
    if (mal) return res.status(400).json({ error: mal });
    db.prepare('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 1 WHERE id = ?').run(await hashClave(b.clave), u.id);
    if (u.id !== req.usuario.id) cerrarSesionesDe(u.id);
  }
  anotarActividad(req.usuario.id, 'cambio_usuario', `${u.usuario}: ${Object.keys(b).join(', ')}`);
  res.json({ ok: true });
});

// ---- Lugares (etiquetas NFC) ----
admin.get('/lugares', (_req, res) => res.json(db.prepare('SELECT * FROM lugares ORDER BY activo DESC, nombre').all()));

admin.post('/lugares', (req, res) => {
  const nombre = txt(req.body.nombre, 80);
  if (!nombre) return res.status(400).json({ error: 'Pon un nombre al lugar' });
  db.prepare('INSERT INTO lugares (nombre, token) VALUES (?, ?)').run(nombre, tokenAleatorio(12));
  anotarActividad(req.usuario.id, 'alta_lugar', nombre);
  res.json({ ok: true });
});

admin.patch('/lugares/:id', (req, res) => {
  const id = Number(req.params.id), b = req.body || {};
  if (b.nombre !== undefined && txt(b.nombre, 80)) db.prepare('UPDATE lugares SET nombre = ? WHERE id = ?').run(txt(b.nombre, 80), id);
  if (b.activo !== undefined) db.prepare('UPDATE lugares SET activo = ? WHERE id = ?').run(b.activo ? 1 : 0, id);
  anotarActividad(req.usuario.id, 'cambio_lugar', String(id));
  res.json({ ok: true });
});

// ---- Registro mensual de un trabajador ----
admin.get('/mes', (req, res) => {
  const u = trabajador(req.query.usuario);
  if (!u || !mesValido(req.query.mes)) return res.status(400).json({ error: 'Elige trabajador y mes' });
  res.json({ trabajador: { id: u.id, nombre: u.nombre }, ...datosMes(u, req.query.mes) });
});

admin.get('/informe.pdf', (req, res) => {
  const u = trabajador(req.query.usuario);
  if (!u || !mesValido(req.query.mes)) return res.status(400).json({ error: 'Elige trabajador y mes' });
  anotarActividad(req.usuario.id, 'informe_pdf', `${u.usuario} ${req.query.mes}`);
  informePdf(res, u, req.query.mes, req.usuario.nombre);
});

admin.get('/informe.csv', (req, res) => {
  const u = trabajador(req.query.usuario);
  if (!u || !mesValido(req.query.mes)) return res.status(400).json({ error: 'Elige trabajador y mes' });
  const d = datosMes(u, req.query.mes);
  const horas = (ms) => (ms / 3600000).toFixed(2).replace('.', ',');
  const lineas = ['Trabajador;DNI;Fecha;Entrada;Salida;Pausa (h);Trabajado (h);Lugar;Origen;Observaciones'];
  for (const dia of d.dias) {
    const obs = [dia.festivo && `Festivo: ${dia.festivo}`, dia.ausencia && `Ausencia: ${dia.ausencia}`, ...dia.incidencias].filter(Boolean).join(' | ');
    if (!dia.jornadas.length) { if (obs) lineas.push([u.nombre, u.dni, dia.fecha, '', '', '', '', '', '', obs].join(';')); continue; }
    for (const j of dia.jornadas) {
      lineas.push([u.nombre, u.dni, dia.fecha, j.entrada.hora, j.salida ? j.salida.hora : '', horas(j.pausaMs), horas(j.trabajadoMs),
        j.entrada.lugar || '', j.entrada.origen, obs].map((c) => String(c).replace(/[;\n]/g, ' ')).join(';'));
    }
  }
  lineas.push(['', '', 'TOTAL', '', '', horas(d.totales.pausaMs), horas(d.totales.trabajadoMs), '', '', ''].join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fichajes-${u.usuario}-${req.query.mes}.csv"`);
  res.send('﻿' + lineas.join('\r\n'));
});

// ---- Correcciones: nunca se edita; se añade un fichaje manual o una anulación, con motivo ----
function comprobarMotivo(m) { return txt(m, 300).length >= 5 ? txt(m, 300) : null; }

function anular(eventoId, autorId, motivo) {
  const e = db.prepare('SELECT * FROM eventos WHERE id = ?').get(Number(eventoId));
  if (!e || e.tipo === 'anulacion') return 'Fichaje no encontrado';
  if (db.prepare("SELECT 1 FROM eventos WHERE tipo = 'anulacion' AND anula_id = ?").get(e.id)) return 'Ese fichaje ya estaba anulado';
  anadirEvento({ usuario_id: e.usuario_id, tipo: 'anulacion', ts: ahoraISO(), origen: 'manual', autor_id: autorId, motivo, anula_id: e.id });
  return null;
}

admin.post('/eventos', (req, res) => {
  const b = req.body || {}, u = trabajador(b.usuario_id), ts = localAUtc(b.momento), motivo = comprobarMotivo(b.motivo);
  if (!u || !TIPOS.includes(b.tipo) || !ts) return res.status(400).json({ error: 'Indica trabajador, tipo, día y hora' });
  if (!motivo) return res.status(400).json({ error: 'El motivo de la corrección es obligatorio' });
  if (Date.parse(ts) > Date.now()) return res.status(400).json({ error: 'La hora no puede ser futura' });
  anadirEvento({ usuario_id: u.id, tipo: b.tipo, ts, origen: 'manual', autor_id: req.usuario.id, motivo });
  anotarActividad(req.usuario.id, 'fichaje_manual', `${u.usuario} ${b.tipo} ${b.momento}`);
  res.json({ ok: true });
});

admin.post('/eventos/:id/anular', (req, res) => {
  const motivo = comprobarMotivo(req.body.motivo);
  if (!motivo) return res.status(400).json({ error: 'El motivo de la anulación es obligatorio' });
  const error = anular(req.params.id, req.usuario.id, motivo);
  if (error) return res.status(400).json({ error });
  anotarActividad(req.usuario.id, 'anulacion', `evento ${req.params.id}`);
  res.json({ ok: true });
});

// ---- Solicitudes de corrección de los trabajadores ----
admin.get('/solicitudes', (_req, res) => {
  const filas = db.prepare(`SELECT s.*, u.nombre, e.tipo AS ev_tipo, e.ts AS ev_ts FROM solicitudes s
    JOIN usuarios u ON u.id = s.usuario_id LEFT JOIN eventos e ON e.id = s.evento_id
    ORDER BY (s.estado = 'pendiente') DESC, s.id DESC LIMIT 100`).all();
  res.json(filas.map((s) => {
    const ts = s.accion === 'anadir' ? s.ts : s.ev_ts, tipo = s.accion === 'anadir' ? s.tipo : s.ev_tipo;
    return { ...s, descripcion: `${s.accion === 'anadir' ? 'Añadir' : 'Anular'} ${NOMBRE_TIPO[tipo].toLowerCase()} del ${fechaLocal(ts).split('-').reverse().join('/')} a las ${horaLocal(ts)}` };
  }));
});

admin.post('/solicitudes/:id', (req, res) => {
  const s = db.prepare("SELECT * FROM solicitudes WHERE id = ? AND estado = 'pendiente'").get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Solicitud no encontrada o ya resuelta' });
  const aprobar = !!req.body.aprobar, respuesta = txt(req.body.respuesta, 300);
  if (aprobar) {
    const motivo = `Solicitud nº ${s.id} del trabajador: ${s.motivo}`;
    if (s.accion === 'anadir') {
      anadirEvento({ usuario_id: s.usuario_id, tipo: s.tipo, ts: s.ts, origen: 'manual', autor_id: req.usuario.id, motivo });
    } else {
      const error = anular(s.evento_id, req.usuario.id, motivo);
      if (error) return res.status(400).json({ error });
    }
  }
  db.prepare('UPDATE solicitudes SET estado = ?, resuelta = ?, resuelta_por = ?, respuesta = ? WHERE id = ?')
    .run(aprobar ? 'aprobada' : 'rechazada', ahoraISO(), req.usuario.id, respuesta, s.id);
  anotarActividad(req.usuario.id, aprobar ? 'solicitud_aprobada' : 'solicitud_rechazada', `nº ${s.id}`);
  res.json({ ok: true });
});

// ---- Ausencias ----
admin.get('/ausencias', (_req, res) => {
  res.json(db.prepare(`SELECT a.*, u.nombre FROM ausencias a JOIN usuarios u ON u.id = a.usuario_id
    ORDER BY (a.estado = 'pendiente') DESC, a.desde DESC LIMIT 200`).all());
});

admin.post('/ausencias', (req, res) => {
  const b = req.body || {}, u = trabajador(b.usuario_id);
  if (!u || !['vacaciones', 'baja', 'permiso', 'otro'].includes(b.tipo)) return res.status(400).json({ error: 'Elige trabajador y tipo' });
  if (!fechaValida(b.desde) || !fechaValida(b.hasta) || b.hasta < b.desde) return res.status(400).json({ error: 'Revisa las fechas' });
  db.prepare(`INSERT INTO ausencias (usuario_id, tipo, desde, hasta, nota, estado, creada, creada_por, resuelta, resuelta_por)
    VALUES (?, ?, ?, ?, ?, 'aprobada', ?, ?, ?, ?)`)
    .run(u.id, b.tipo, b.desde, b.hasta, txt(b.nota, 200), ahoraISO(), req.usuario.id, ahoraISO(), req.usuario.id);
  anotarActividad(req.usuario.id, 'ausencia', `${u.usuario} ${b.tipo} ${b.desde}..${b.hasta}`);
  res.json({ ok: true });
});

admin.post('/ausencias/:id', (req, res) => {
  const estado = req.body.estado;
  if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado no válido' });
  const r = db.prepare('UPDATE ausencias SET estado = ?, resuelta = ?, resuelta_por = ? WHERE id = ?')
    .run(estado, ahoraISO(), req.usuario.id, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'No existe' });
  anotarActividad(req.usuario.id, `ausencia_${estado}`, `nº ${req.params.id}`);
  res.json({ ok: true });
});

// ---- Festivos ----
admin.get('/festivos', (req, res) => {
  const anio = /^\d{4}$/.test(req.query.anio || '') ? req.query.anio : fechaLocal(ahoraISO()).slice(0, 4);
  res.json(db.prepare('SELECT * FROM festivos WHERE fecha LIKE ? ORDER BY fecha').all(`${anio}-%`));
});

admin.post('/festivos', (req, res) => {
  const fecha = req.body.fecha, nombre = txt(req.body.nombre, 80);
  if (!fechaValida(fecha) || !nombre) return res.status(400).json({ error: 'Indica fecha y nombre' });
  db.prepare('INSERT INTO festivos (fecha, nombre) VALUES (?, ?) ON CONFLICT(fecha) DO UPDATE SET nombre = excluded.nombre').run(fecha, nombre);
  res.json({ ok: true });
});

admin.delete('/festivos/:fecha', (req, res) => {
  db.prepare('DELETE FROM festivos WHERE fecha = ?').run(req.params.fecha);
  res.json({ ok: true });
});

// Festivos nacionales de fecha fija + Viernes Santo. Los autonómicos y locales se añaden a mano.
admin.post('/festivos/nacionales', (req, res) => {
  const anio = Number(req.body.anio);
  if (!(anio >= 2020 && anio <= 2100)) return res.status(400).json({ error: 'Año no válido' });
  const fijos = [['01-01', 'Año Nuevo'], ['01-06', 'Epifanía del Señor'], ['05-01', 'Fiesta del Trabajo'], ['08-15', 'Asunción de la Virgen'],
    ['10-12', 'Fiesta Nacional de España'], ['11-01', 'Todos los Santos'], ['12-06', 'Día de la Constitución'],
    ['12-08', 'Inmaculada Concepción'], ['12-25', 'Natividad del Señor']];
  const lista = fijos.map(([d, n]) => [`${anio}-${d}`, n]);
  lista.push([viernesSanto(anio), 'Viernes Santo']);
  const ins = db.prepare('INSERT INTO festivos (fecha, nombre) VALUES (?, ?) ON CONFLICT(fecha) DO NOTHING');
  for (const [f, n] of lista) ins.run(f, n);
  res.json({ ok: true, anadidos: lista.length });
});

export function viernesSanto(anio) {       // Pascua (algoritmo gregoriano anónimo) − 2 días
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(anio, mes - 1, dia - 2)).toISOString().slice(0, 10);
}

// ---- Opciones, integridad, exportación y actividad ----
admin.get('/opciones', (_req, res) => res.json({ geo: opcion('geo', '1') === '1', requiereLugar: opcion('requiere_lugar', '0') === '1' }));

admin.post('/opciones', (req, res) => {
  if (req.body.geo !== undefined) guardarOpcion('geo', req.body.geo ? '1' : '0');
  if (req.body.requiereLugar !== undefined) guardarOpcion('requiere_lugar', req.body.requiereLugar ? '1' : '0');
  anotarActividad(req.usuario.id, 'cambio_opciones', JSON.stringify(req.body).slice(0, 200));
  res.json({ ok: true });
});

admin.get('/integridad', (_req, res) => res.json(verificarCadena()));

// Copia completa y legible del registro (para Inspección, gestoría o migración).
admin.get('/exportar.json', (req, res) => {
  anotarActividad(req.usuario.id, 'exportacion_completa');
  res.setHeader('Content-Disposition', `attachment; filename="fichajes-export-${fechaLocal(ahoraISO())}.json"`);
  res.json({
    generado: ahoraISO(), empresa: EMPRESA, zonaHoraria: TZ, integridad: verificarCadena(),
    usuarios: db.prepare('SELECT id, usuario, nombre, dni, rol, horas_semana, activo, alta FROM usuarios').all(),
    lugares: db.prepare('SELECT id, nombre, activo FROM lugares').all(),
    eventos: db.prepare('SELECT * FROM eventos ORDER BY id').all(),
    solicitudes: db.prepare('SELECT * FROM solicitudes ORDER BY id').all(),
    ausencias: db.prepare('SELECT * FROM ausencias ORDER BY id').all(),
    festivos: db.prepare('SELECT * FROM festivos ORDER BY fecha').all(),
  });
});

admin.get('/actividad', (_req, res) => {
  res.json(db.prepare(`SELECT a.ts, a.accion, a.detalle, u.nombre FROM actividad a LEFT JOIN usuarios u ON u.id = a.usuario_id
    ORDER BY a.id DESC LIMIT 200`).all().map((a) => ({ ...a, cuando: `${fechaLocal(a.ts).split('-').reverse().join('/')} ${horaLocal(a.ts)}` })));
});

