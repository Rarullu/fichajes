// Servidor de la aplicación de fichajes.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, EMPRESA, TZ, DATA_DIR } from './config.js';
import { verificarCadena } from './db.js';
import { cargarSesion, requiereCabecera } from './seguridad.js';
import { rutas } from './rutas/trabajador.js';
import { admin } from './rutas/admin.js';
import { programarCopias } from './copias.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // detrás de Nginx Proxy Manager: para saber si la conexión es HTTPS

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  next();
});

app.use('/api', express.json({ limit: '20kb' }), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); },
  requiereCabecera, cargarSesion);
app.use('/api/admin', admin);
app.use('/api', rutas);
app.use('/api', (_req, res) => res.status(404).json({ error: 'No existe' }));

const publico = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(publico, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos no válidos' });
  console.error(err);
  res.status(500).json({ error: 'Error interno. Inténtalo de nuevo.' });
});

const integridad = verificarCadena();
console.log(`[fichajes] ${EMPRESA.nombre} · zona ${TZ} · datos en ${DATA_DIR}`);
console.log(`[fichajes] registro: ${integridad.eventos} fichajes, integridad ${integridad.ok ? 'correcta' : 'ROTA → ' + integridad.fallo}`);
programarCopias();

app.listen(PORT, () => console.log(`[fichajes] escuchando en el puerto ${PORT}`));
