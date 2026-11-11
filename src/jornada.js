// Lógica de jornada: estado actual, transiciones válidas y cálculo de horas.
// No toca la base de datos: recibe eventos y devuelve resultados (fácil de probar).
import { TZ } from './config.js';

// ---------- Fechas en la zona horaria de la empresa ----------
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
/** '2026-11-11 08:59:03' en hora de la empresa. */
export const localStr = (iso) => fmt.format(new Date(iso));
export const fechaLocal = (iso) => localStr(iso).slice(0, 10);
export const horaLocal = (iso) => localStr(iso).slice(11, 16);

/** Convierte 'YYYY-MM-DDTHH:MM' (hora de la empresa) a ISO UTC. */
export function localAUtc(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local || '');
  if (!m) return null;
  const objetivo = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = objetivo;
  for (let i = 0; i < 3; i++) {            // corrige el desfase (incluye cambios de hora)
    const visto = Date.parse(localStr(new Date(t).toISOString()).replace(' ', 'T') + 'Z');
    t += objetivo - visto;
  }
  return new Date(t).toISOString();
}

export const diaSemana = (fecha) => new Date(fecha + 'T12:00:00Z').getUTCDay(); // 0 = domingo
export function diasDelMes(mes) {              // mes = 'YYYY-MM'
  const [a, m] = mes.split('-').map(Number);
  const n = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
}
export const mesValido = (mes) => /^\d{4}-(0[1-9]|1[0-2])$/.test(mes || '');
export const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !Number.isNaN(Date.parse(f + 'T00:00:00Z'));

// ---------- Estado y transiciones ----------
export const TIPOS = ['entrada', 'salida', 'pausa_inicio', 'pausa_fin'];
const SIGUIENTES = {
  fuera: ['entrada'],
  trabajando: ['pausa_inicio', 'salida'],
  pausa: ['pausa_fin', 'salida'],      // salir estando en pausa cierra también la pausa
};

/** Quita las anulaciones y los eventos anulados; ordena por momento del fichaje. */
export function efectivos(eventos) {
  const anulados = new Set(eventos.filter((e) => e.tipo === 'anulacion').map((e) => e.anula_id));
  return eventos
    .filter((e) => e.tipo !== 'anulacion' && !anulados.has(e.id))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
}

export function estadoActual(efs) {
  const u = efs[efs.length - 1];
  if (!u || u.tipo === 'salida') return { estado: 'fuera', desde: u?.ts ?? null };
  if (u.tipo === 'pausa_inicio') return { estado: 'pausa', desde: u.ts };
  // entrada o pausa_fin: trabajando desde la última entrada
  const entrada = [...efs].reverse().find((e) => e.tipo === 'entrada');
  return { estado: 'trabajando', desde: entrada?.ts ?? u.ts };
}

export const permitido = (estado, tipo) => (SIGUIENTES[estado] || []).includes(tipo);
export const opcionesDe = (estado) => SIGUIENTES[estado] || [];

// ---------- Cálculo de jornadas ----------
/**
 * Agrupa los eventos efectivos en jornadas (entrada → salida) y las asigna al
 * día (hora de la empresa) en que empezaron. Devuelve Map fecha → resumen.
 */
export function calcularDias(efs, ahora = new Date().toISOString()) {
  const dias = new Map();
  const dia = (fecha) => {
    if (!dias.has(fecha)) dias.set(fecha, { fecha, jornadas: [], trabajadoMs: 0, pausaMs: 0, incidencias: [] });
    return dias.get(fecha);
  };
  const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a));
  const huerfano = (e, texto) => dia(fechaLocal(e.ts)).incidencias.push(`${horaLocal(e.ts)} ${texto}`);

  let j = null;
  const cerrar = (finTs, estado) => {
    // estado: 'cerrada' | 'en_curso' | 'sin_salida'
    if (j.pausaAbierta) {
      j.pausas.push({ inicio: j.pausaAbierta, fin: estado === 'cerrada' ? j.salida : null });
      j.pausaAbierta = null;
    }
    const d = dia(j.fecha);
    let pausa = 0;
    for (const p of j.pausas) pausa += ms(p.inicio.ts, p.fin ? p.fin.ts : finTs);
    const total = estado === 'sin_salida' ? 0 : ms(j.entrada.ts, finTs);
    j.estado = estado;
    j.pausaMs = estado === 'sin_salida' ? 0 : pausa;
    j.trabajadoMs = Math.max(0, total - j.pausaMs);
    d.jornadas.push(j);
    d.trabajadoMs += j.trabajadoMs;
    d.pausaMs += j.pausaMs;
    if (estado === 'sin_salida') d.incidencias.push(`Entrada de las ${horaLocal(j.entrada.ts)} sin salida`);
    j = null;
  };

  for (const e of efs) {
    if (e.tipo === 'entrada') {
      if (j) cerrar(e.ts, 'sin_salida');
      j = { fecha: fechaLocal(e.ts), entrada: e, salida: null, pausas: [], pausaAbierta: null };
    } else if (e.tipo === 'pausa_inicio') {
      if (!j || j.pausaAbierta) huerfano(e, 'inicio de pausa fuera de secuencia');
      else j.pausaAbierta = e;
    } else if (e.tipo === 'pausa_fin') {
      if (!j || !j.pausaAbierta) huerfano(e, 'fin de pausa fuera de secuencia');
      else { j.pausas.push({ inicio: j.pausaAbierta, fin: e }); j.pausaAbierta = null; }
    } else if (e.tipo === 'salida') {
      if (!j) huerfano(e, 'salida sin entrada');
      else { j.salida = e; cerrar(e.ts, 'cerrada'); }
    }
  }
  if (j) {
    // Jornada abierta: se cuenta hasta ahora. Si lleva más de 16 h, es un olvido.
    const horas = ms(j.entrada.ts, ahora) / 3600000;
    if (horas > 16) cerrar(ahora, 'sin_salida'); else cerrar(ahora, 'en_curso');
  }
  return dias;
}

/**
 * Resumen de un mes para un trabajador: un elemento por día natural, con lo
 * trabajado, festivo/ausencia y horas previstas (orientativas: horas semanales / 5
 * en días laborables de lunes a viernes sin festivo ni ausencia aprobada).
 */
export function resumenMes({ mes, eventos, festivos = [], ausencias = [], horasSemana = 40, ahora }) {
  const dias = calcularDias(efectivos(eventos), ahora);
  const fest = new Map(festivos.map((f) => [f.fecha, f.nombre]));
  const hoy = fechaLocal(ahora || new Date().toISOString());
  const previstoDia = (horasSemana / 5) * 3600000;
  let trabajadoMs = 0, pausaMs = 0, previstoMs = 0, incidencias = 0;

  const lista = diasDelMes(mes).map((fecha) => {
    const d = dias.get(fecha) || { fecha, jornadas: [], trabajadoMs: 0, pausaMs: 0, incidencias: [] };
    const ds = diaSemana(fecha);
    const aus = ausencias.find((a) => a.estado === 'aprobada' && a.desde <= fecha && fecha <= a.hasta);
    const laborable = ds >= 1 && ds <= 5 && !fest.has(fecha) && !aus;
    const previsto = laborable && fecha <= hoy ? previstoDia : 0;
    trabajadoMs += d.trabajadoMs; pausaMs += d.pausaMs; previstoMs += previsto; incidencias += d.incidencias.length;
    return {
      fecha, diaSemana: ds,
      festivo: fest.get(fecha) || null,
      ausencia: aus ? aus.tipo : null,
      trabajadoMs: d.trabajadoMs, pausaMs: d.pausaMs, previstoMs: previsto,
      incidencias: d.incidencias,
      jornadas: d.jornadas.map((j) => ({
        estado: j.estado,
        entrada: vista(j.entrada), salida: j.salida ? vista(j.salida) : null,
        pausas: j.pausas.map((p) => ({ inicio: vista(p.inicio), fin: p.fin ? vista(p.fin) : null })),
        trabajadoMs: j.trabajadoMs, pausaMs: j.pausaMs,
      })),
    };
  });
  return { mes, dias: lista, totales: { trabajadoMs, pausaMs, previstoMs, saldoMs: trabajadoMs - previstoMs, incidencias } };
}

/** Datos de un evento tal y como se enseñan (hora de la empresa incluida). */
export function vista(e) {
  return {
    id: e.id, tipo: e.tipo, ts: e.ts, hora: horaLocal(e.ts), fecha: fechaLocal(e.ts),
    origen: e.origen, lugar: e.lugar || null, motivo: e.motivo || null,
    autor: e.origen === 'manual' ? e.autor || null : null,
    registrado: e.ts_registro,
  };
}

export function hhmm(ms) {
  const neg = ms < 0; const min = Math.round(Math.abs(ms) / 60000);
  return `${neg ? '-' : ''}${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}
