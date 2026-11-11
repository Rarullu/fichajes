// Consultas compartidas por las rutas de trabajador y de administración.
import { db, eventosDe } from './db.js';
import { resumenMes, efectivos, estadoActual, opcionesDe, calcularDias, fechaLocal, horaLocal, vista } from './jornada.js';

export function usuarioPorId(id) {
  return db.prepare('SELECT id, usuario, nombre, dni, rol, horas_semana, activo, alta FROM usuarios WHERE id = ?').get(id);
}

/** Todo lo necesario para mostrar o imprimir el mes de un trabajador. */
export function datosMes(u, mes) {
  const eventos = eventosDe(u.id);
  const festivos = db.prepare('SELECT fecha, nombre FROM festivos WHERE fecha LIKE ?').all(`${mes}-%`);
  const ausencias = db.prepare('SELECT * FROM ausencias WHERE usuario_id = ? AND hasta >= ? AND desde <= ?')
    .all(u.id, `${mes}-01`, `${mes}-31`);
  const resumen = resumenMes({ mes, eventos, festivos, ausencias, horasSemana: u.horas_semana });

  // Lista cruda del mes (incluye anulados) y correcciones, para auditoría.
  const anulaciones = new Map(eventos.filter((e) => e.tipo === 'anulacion').map((e) => [e.anula_id, e]));
  const delMes = eventos.filter((e) => e.tipo !== 'anulacion' && fechaLocal(e.ts).startsWith(mes));
  const crudos = delMes.map((e) => {
    const an = anulaciones.get(e.id);
    return { ...vista(e), anulado: an ? { por: an.autor, motivo: an.motivo, cuando: an.ts_registro } : null };
  });
  const correcciones = [];
  for (const e of delMes) {
    const cuando = `${fechaLocal(e.ts).slice(8)}/${fechaLocal(e.ts).slice(5, 7)} ${horaLocal(e.ts)}`;
    if (e.origen === 'manual') correcciones.push(`${cuando} ${NOMBRE_TIPO[e.tipo]} añadida por ${e.autor}: ${e.motivo}`);
    const an = anulaciones.get(e.id);
    if (an) correcciones.push(`${cuando} ${NOMBRE_TIPO[e.tipo]} anulada por ${an.autor}: ${an.motivo}`);
  }
  return { ...resumen, eventos: crudos, correcciones };
}

export const NOMBRE_TIPO = {
  entrada: 'Entrada', salida: 'Salida', pausa_inicio: 'Inicio de pausa', pausa_fin: 'Fin de pausa', anulacion: 'Anulación',
};

/** Situación actual de un trabajador (para la pantalla de fichar y el panel). */
export function situacion(usuarioId) {
  const efs = efectivos(eventosDe(usuarioId));
  const { estado, desde } = estadoActual(efs);
  const ahora = new Date().toISOString();
  const hoy = fechaLocal(ahora);
  const dias = calcularDias(efs, ahora);
  // La jornada en curso puede haber empezado ayer (turno de noche).
  const enCurso = [...dias.values()].flatMap((d) => d.jornadas).find((j) => j.estado === 'en_curso');
  const dHoy = dias.get(hoy);
  const ultimo = efs[efs.length - 1];
  return {
    estado, desde, opciones: opcionesDe(estado), ahora,
    hoy: { fecha: hoy, trabajadoMs: dHoy?.trabajadoMs ?? 0, pausaMs: dHoy?.pausaMs ?? 0 },
    jornada: enCurso ? { entrada: enCurso.entrada.ts, trabajadoMs: enCurso.trabajadoMs, pausaMs: enCurso.pausaMs } : null,
    ultimo: ultimo ? vista(ultimo) : null,
    olvido: [...dias.values()].some((d) => d.jornadas.some((j) => j.estado === 'sin_salida') && d.fecha >= fechaHace(30)),
  };
}

function fechaHace(dias) {
  return fechaLocal(new Date(Date.now() - dias * 86400000).toISOString());
}

/** Días de los últimos N días con incidencias (olvidos, secuencias raras). */
export function incidenciasRecientes(usuarioId, n = 45) {
  const dias = calcularDias(efectivos(eventosDe(usuarioId)));
  const desde = fechaHace(n);
  return [...dias.values()].filter((d) => d.fecha >= desde && d.incidencias.length)
    .map((d) => ({ fecha: d.fecha, incidencias: d.incidencias }));
}
