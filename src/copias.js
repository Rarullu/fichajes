// Copia diaria de la base de datos en data/copias/ (la obligación legal es conservar 4 años).
// Estas copias deben sacarse además FUERA del servidor (ver README: rclone a Google Drive).
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { fechaLocal } from './jornada.js';

const DIR = path.join(DATA_DIR, 'copias');
const DIAS_DIARIAS = 90;   // se guardan 90 días de copias diarias + la del día 1 de cada mes para siempre

export function copiaDiaria() {
  try {
    const hoy = fechaLocal(new Date().toISOString());
    const destino = path.join(DIR, `fichajes-${hoy}.db`);
    if (!fs.existsSync(destino)) {
      db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
      console.log(`[copias] creada ${destino}`);
    }
    const limite = fechaLocal(new Date(Date.now() - DIAS_DIARIAS * 86400000).toISOString());
    for (const f of fs.readdirSync(DIR)) {
      const m = /^fichajes-(\d{4}-\d{2}-(\d{2}))\.db$/.exec(f);
      if (m && m[1] < limite && m[2] !== '01') fs.unlinkSync(path.join(DIR, f));
    }
  } catch (err) {
    console.error('[copias] ERROR al hacer la copia diaria:', err.message);
  }
}

export function programarCopias() {
  copiaDiaria();
  setInterval(copiaDiaria, 3600000).unref();   // comprueba cada hora; solo copia una vez al día
}
