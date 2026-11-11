import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fichajes-test-'));
const { db, anadirEvento, verificarCadena } = await import('../src/db.js');

db.prepare("INSERT INTO usuarios (id, usuario, nombre, rol, clave_hash, alta) VALUES (1, 'ana', 'Ana', 'empleado', 'x', '2026-01-01')").run();
const nuevo = (tipo, ts) => anadirEvento({ usuario_id: 1, tipo, ts, origen: 'app', autor_id: 1 });

test('la cadena de huellas se verifica y cada evento enlaza con el anterior', () => {
  const a = nuevo('entrada', '2026-11-10T07:00:00.000Z');
  const b = nuevo('salida', '2026-11-10T15:00:00.000Z');
  assert.equal(b.prev_hash, a.hash);
  const v = verificarCadena();
  assert.deepEqual([v.ok, v.eventos, v.ultimoHash], [true, 2, b.hash]);
});

test('la base de datos rechaza modificar o borrar fichajes', () => {
  assert.throws(() => db.prepare("UPDATE eventos SET ts = '2026-11-10T06:00:00.000Z' WHERE id = 1").run(), /inalterable/);
  assert.throws(() => db.prepare('DELETE FROM eventos WHERE id = 1').run(), /inalterable/);
});

test('el mismo fichaje enviado dos veces (cola sin conexión) no se duplica', () => {
  anadirEvento({ usuario_id: 1, tipo: 'entrada', ts: '2026-11-11T07:00:00.000Z', origen: 'sin_conexion', autor_id: 1, id_cliente: '1:abc' });
  assert.throws(() => anadirEvento({ usuario_id: 1, tipo: 'entrada', ts: '2026-11-11T07:00:00.000Z', origen: 'sin_conexion', autor_id: 1, id_cliente: '1:abc' }));
  assert.equal(verificarCadena().eventos, 3);   // el intento fallido no deja rastro ni rompe la cadena
});

test('si alguien manipula el fichero saltándose los bloqueos, la verificación lo detecta', () => {
  // Simula a alguien con acceso al fichero: quita el bloqueo y cambia una hora.
  const otra = new DatabaseSync(path.join(process.env.DATA_DIR, 'fichajes.db'));
  otra.exec("DROP TRIGGER eventos_no_update; UPDATE eventos SET ts = '2026-11-10T06:00:00.000Z' WHERE id = 1;");
  otra.close();
  const v = verificarCadena();
  assert.equal(v.ok, false);
  assert.match(v.fallo, /nº 1/);
});
