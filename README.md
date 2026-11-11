# Fichajes

Aplicación de registro de jornada para una empresa pequeña. Los trabajadores fichan desde su móvil
(entrada, pausas y salida), con etiquetas NFC para identificar el lugar de trabajo, y la empresa
consulta, corrige con trazabilidad y descarga los informes.

Es una aplicación web instalable (PWA) con un único servicio: **Node.js + SQLite** en un contenedor Docker.
No necesita base de datos externa.

## Qué hace

**Trabajador (móvil)**
- Fichar entrada, pausa, vuelta de pausa y salida con un toque.
- Lugar de trabajo por etiqueta NFC (al acercar el móvil se abre la app con el lugar identificado) y, si se activa, ubicación del móvil solo en el instante de fichar.
- Funciona sin conexión: el fichaje se guarda en el móvil con su hora real y se envía al volver la red.
- Consulta de su propio registro, descarga en PDF, solicitud de correcciones y de ausencias.

**Administración**
- Panel con quién está trabajando, avisos de jornadas sin salida y solicitudes pendientes.
- Registro mensual por trabajador, informe PDF para firmar y CSV para la gestoría.
- Correcciones: fichaje manual o anulación, siempre con autor y motivo. El original nunca se borra.
- Trabajadores, lugares NFC (con grabación de la etiqueta desde un Android), ausencias, festivos y opciones.
- Verificación de integridad, exportación completa en JSON y traza de actividad.

## Cómo encaja con la normativa

> Esto no es asesoramiento jurídico. Revisa el resultado con tu gestoría o asesor laboral.

- **Vigente (art. 34.9 del Estatuto de los Trabajadores):** registro diario con hora concreta de inicio y fin,
  conservado cuatro años y accesible para trabajadores, representantes e Inspección. La app lo cubre:
  hora del servidor, informe mensual por trabajador, acceso del trabajador a su registro y copias diarias.
- **Proyecto de real decreto de registro digital** (sin aprobar a 11 de noviembre de 2026): pide registro digital,
  inalterable y con correcciones trazables. La app ya funciona así: los fichajes se guardan en una tabla que solo
  admite añadidos (la propia base de datos rechaza modificar o borrar) y cada uno va encadenado al anterior con
  una huella SHA-256, de modo que cualquier manipulación del fichero se detecta en «Ajustes → Datos».
- **Pendiente:** el acceso remoto de la Inspección tendrá un formato técnico que aún no está publicado.
  Hasta entonces, la exportación completa (JSON) y los PDF son la forma de entregar el registro.
- **Protección de datos:** informa por escrito a los trabajadores de que se registra su jornada y, si lo activas,
  la ubicación en el momento de fichar. No se usa biometría ni seguimiento continuo.

## Despliegue en el servidor (Docker)

Requisitos: Docker con el plugin Compose, y un proxy inverso con HTTPS (por ejemplo Nginx Proxy Manager).

```bash
git clone https://github.com/Rarullu/fichajes.git
cd fichajes
cp .env.example .env
nano .env                                   # nombre de la empresa, CIF y puerto
mkdir -p data && sudo chown 1000:1000 data  # el contenedor escribe como usuario 1000
docker compose up -d --build
docker compose logs -f                      # debe decir "escuchando en el puerto 3000"
```

La app queda en `http://IP-DEL-SERVIDOR:3080` (o el `PUERTO` que pongas en `.env`).

### HTTPS (obligatorio)

Sin HTTPS no funcionan ni la instalación como app, ni el modo sin conexión, ni el NFC, ni la ubicación.
En Nginx Proxy Manager crea un *Proxy Host*:

- Dominio: el que vayas a usar (p. ej. `fichajes.tudominio.duckdns.org`)
- Destino: `http://IP-DEL-SERVIDOR:3080`
- Pestaña SSL: pedir certificado Let's Encrypt y activar *Force SSL*

Usa siempre ese dominio, también dentro de la oficina: las etiquetas NFC llevan grabada la dirección.

### Primer uso

1. Abre el dominio: la app pide crear la cuenta de administración.
2. **Ajustes → Trabajadores → Nuevo**: crea cada trabajador con una contraseña provisional (la cambiará al entrar).
3. **Ajustes → Lugares NFC → Nuevo**: crea cada lugar. Para grabar la etiqueta, abre esa pantalla en Chrome
   de un móvil Android y pulsa *Grabar etiqueta*, o copia la dirección y grábala con una app como NFC Tools.
4. **Ajustes → Festivos**: carga los nacionales y añade los autonómicos y locales.
5. Cada trabajador abre el dominio en Chrome de su móvil, entra y elige *Añadir a pantalla de inicio*.

### Actualizar

```bash
cd fichajes && git pull && docker compose up -d --build
```

Los datos están en `data/` y no se tocan al actualizar.

## Copias de seguridad

Todo lo que importa está en la carpeta `data/`:

- `fichajes.db`: la base de datos.
- `copias/`: una copia por día (se guardan 90 días, y la del día 1 de cada mes para siempre).
- `secret.key`: secreto de la instalación.

Hay que sacar esas copias **fuera del servidor**. Con rclone, en el cron del servidor:

```cron
30 3 * * * rclone copy /ruta/a/fichajes/data/copias gdrive:copias/fichajes --max-age 3d
```

Para restaurar: para el contenedor, sustituye `data/fichajes.db` por una copia y arráncalo de nuevo.
Borra antes `data/fichajes.db-wal` y `data/fichajes.db-shm` si existen.

## Desarrollo

```bash
npm install
npm test                 # cálculo de jornada y registro inalterable
DATA_DIR=./data-dev npm run dev    # http://localhost:3000
```

Requiere Node.js 22.13 o superior.

```
src/
  server.js          Servidor Express y cabeceras de seguridad
  config.js          Variables de entorno
  db.js              Esquema SQLite, registro encadenado por huellas
  jornada.js         Estado, transiciones y cálculo de horas (sin base de datos)
  datos.js           Consultas compartidas (mes de un trabajador, situación actual)
  seguridad.js       Contraseñas (bcrypt), sesiones, bloqueo por intentos
  pdf.js             Informe mensual
  copias.js          Copia diaria
  rutas/trabajador.js   Sesión, fichar, mi registro, solicitudes, ausencias
  rutas/admin.js        Administración
public/              App de página única (HTML, CSS y JS sin dependencias) + service worker
test/                Tests con el runner integrado de Node
```

## Limitaciones conocidas

- Una etiqueta NFC identifica el lugar, pero su dirección se puede guardar y abrir desde otro sitio.
  Si necesitas más garantía, activa también la ubicación al fichar.
- El saldo de horas es orientativo: reparte las horas semanales de contrato entre lunes y viernes.
  No contempla turnos, jornadas irregulares ni bolsas de horas.
- No envía correos ni notificaciones: los avisos se ven al abrir la app.
- Pensada para una sola empresa por instalación.
