// Configuración: todo sale de variables de entorno (ver .env.example).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
// Zona horaria de la EMPRESA. Todas las fechas se agrupan y muestran en ella,
// esté donde esté el navegador de quien consulta.
export const TZ = process.env.TZ_EMPRESA || process.env.TZ || 'Europe/Madrid';

export const EMPRESA = {
  nombre: process.env.EMPRESA_NOMBRE || 'Mi empresa',
  cif: process.env.EMPRESA_CIF || '',
  direccion: process.env.EMPRESA_DIR || '',
};

// Días que una sesión permanece abierta en el móvil del empleado / del administrador.
export const SESION_DIAS_EMPLEADO = Number(process.env.SESION_DIAS_EMPLEADO || 180);
export const SESION_DIAS_ADMIN = Number(process.env.SESION_DIAS_ADMIN || 7);
// Antigüedad máxima (horas) de un fichaje hecho sin conexión que se acepta al sincronizar.
export const OFFLINE_MAX_HORAS = Number(process.env.OFFLINE_MAX_HORAS || 72);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'copias'), { recursive: true });

// Secreto de la instalación (se genera una vez). No borrar: va con la base de datos.
const secretoPath = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretoPath)) {
  fs.writeFileSync(secretoPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
export const SECRETO = fs.readFileSync(secretoPath, 'utf8').trim();
