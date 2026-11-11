import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fichajes-test-'));
process.env.TZ_EMPRESA = 'Europe/Madrid';
const { efectivos, estadoActual, permitido, calcularDias, resumenMes, localAUtc, fechaLocal, horaLocal } = await import('../src/jornada.js');
const { viernesSanto } = await import('../src/rutas/admin.js');

let n = 0;
const ev = (tipo, local, extra = {}) => ({ id: ++n, tipo, ts: localAUtc(local), origen: 'app', ...extra });
const H = 3600000;

test('la hora local de la empresa se convierte bien a UTC, también en verano', () => {
  assert.equal(localAUtc('2026-11-10T08:00'), '2026-11-10T07:00:00.000Z');   // invierno: UTC+1
  assert.equal(localAUtc('2026-07-10T08:00'), '2026-07-10T06:00:00.000Z');   // verano: UTC+2
  assert.equal(horaLocal('2026-07-10T06:00:00.000Z'), '08:00');
  assert.equal(fechaLocal('2026-11-10T23:30:00.000Z'), '2026-11-11');        // pasada la medianoche local
  assert.equal(localAUtc('no es fecha'), null);
});

test('jornada normal con pausa', () => {
  const efs = efectivos([ev('entrada', '2026-11-10T08:00'), ev('pausa_inicio', '2026-11-10T11:00'), ev('pausa_fin', '2026-11-10T11:30'), ev('salida', '2026-11-10T16:30')]);
  const d = calcularDias(efs).get('2026-11-10');
  assert.equal(d.trabajadoMs, 8 * H);
  assert.equal(d.pausaMs, 0.5 * H);
  assert.deepEqual(d.incidencias, []);
  assert.equal(estadoActual(efs).estado, 'fuera');
});

test('jornada partida: dos tramos el mismo día', () => {
  const efs = efectivos([ev('entrada', '2026-11-10T09:00'), ev('salida', '2026-11-10T13:00'), ev('entrada', '2026-11-10T15:00'), ev('salida', '2026-11-10T19:00')]);
  const d = calcularDias(efs).get('2026-11-10');
  assert.equal(d.jornadas.length, 2);
  assert.equal(d.trabajadoMs, 8 * H);
});

test('turno de noche: cuenta entero en el día de entrada', () => {
  const efs = efectivos([ev('entrada', '2026-11-10T22:00'), ev('salida', '2026-11-11T06:00')]);
  const dias = calcularDias(efs);
  assert.equal(dias.get('2026-11-10').trabajadoMs, 8 * H);
  assert.equal(dias.has('2026-11-11'), false);
});

test('salir estando en pausa cierra la pausa', () => {
  const efs = efectivos([ev('entrada', '2026-11-10T08:00'), ev('pausa_inicio', '2026-11-10T13:00'), ev('salida', '2026-11-10T14:00')]);
  const d = calcularDias(efs).get('2026-11-10');
  assert.equal(d.trabajadoMs, 5 * H);
  assert.equal(d.pausaMs, 1 * H);
});

test('entrada sin salida: no suma horas y avisa', () => {
  const efs = efectivos([ev('entrada', '2026-11-09T08:00'), ev('entrada', '2026-11-10T08:00'), ev('salida', '2026-11-10T16:00')]);
  const dias = calcularDias(efs);
  assert.equal(dias.get('2026-11-09').trabajadoMs, 0);
  assert.equal(dias.get('2026-11-09').incidencias.length, 1);
  assert.equal(dias.get('2026-11-10').trabajadoMs, 8 * H);
});

test('jornada en curso cuenta hasta ahora; más de 16 h se trata como olvido', () => {
  const efs = efectivos([ev('entrada', '2026-11-10T08:00')]);
  const enCurso = calcularDias(efs, localAUtc('2026-11-10T10:00')).get('2026-11-10');
  assert.equal(enCurso.trabajadoMs, 2 * H);
  assert.equal(enCurso.jornadas[0].estado, 'en_curso');
  const olvido = calcularDias(efs, localAUtc('2026-11-11T09:00')).get('2026-11-10');
  assert.equal(olvido.trabajadoMs, 0);
  assert.equal(olvido.jornadas[0].estado, 'sin_salida');
});

test('una anulación quita el fichaje anulado del cálculo', () => {
  const a = ev('entrada', '2026-11-10T08:00'), b = ev('salida', '2026-11-10T12:00'), c = ev('salida', '2026-11-10T16:00');
  const anul = { id: ++n, tipo: 'anulacion', anula_id: b.id, ts: localAUtc('2026-11-10T17:00'), origen: 'manual' };
  const d = calcularDias(efectivos([a, b, c, anul])).get('2026-11-10');
  assert.equal(d.trabajadoMs, 8 * H);
  assert.deepEqual(d.incidencias, []);
});

test('un fichaje manual añadido después se ordena por su hora, no por cuándo se anotó', () => {
  const salida = ev('salida', '2026-11-10T16:00');
  const entradaTardia = ev('entrada', '2026-11-10T08:00', { origen: 'manual' });
  assert.equal(calcularDias(efectivos([salida, entradaTardia])).get('2026-11-10').trabajadoMs, 8 * H);
});

test('transiciones permitidas', () => {
  assert.ok(permitido('fuera', 'entrada'));
  assert.ok(!permitido('fuera', 'salida'));
  assert.ok(!permitido('trabajando', 'entrada'));
  assert.ok(permitido('trabajando', 'pausa_inicio'));
  assert.ok(permitido('pausa', 'pausa_fin'));
  assert.ok(!permitido('pausa', 'pausa_inicio'));
});

test('resumen del mes: previsto descuenta fines de semana, festivos y ausencias aprobadas', () => {
  const r = resumenMes({
    mes: '2026-11', eventos: [ev('entrada', '2026-11-02T08:00'), ev('salida', '2026-11-02T16:00')],
    festivos: [{ fecha: '2026-11-03', nombre: 'Festivo de prueba' }],
    ausencias: [{ estado: 'aprobada', tipo: 'vacaciones', desde: '2026-11-04', hasta: '2026-11-05' }, { estado: 'pendiente', tipo: 'vacaciones', desde: '2026-11-06', hasta: '2026-11-06' }],
    horasSemana: 40, ahora: localAUtc('2026-11-30T23:00'),
  });
  // Noviembre de 2026 tiene 21 días de lunes a viernes; menos 1 festivo y 2 de vacaciones = 18.
  assert.equal(r.totales.previstoMs, 18 * 8 * H);
  assert.equal(r.totales.trabajadoMs, 8 * H);
  assert.equal(r.dias.length, 30);
  assert.equal(r.dias[2].festivo, 'Festivo de prueba');
  assert.equal(r.dias[3].ausencia, 'vacaciones');
  assert.equal(r.dias[5].ausencia, null);
});

test('Viernes Santo', () => {
  assert.equal(viernesSanto(2026), '2026-04-03');
  assert.equal(viernesSanto(2027), '2027-03-26');
  assert.equal(viernesSanto(2025), '2025-04-18');
});
