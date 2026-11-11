// App de fichajes (página única). Sin dependencias.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const guardado = (k, v) => {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
    localStorage.setItem(k, JSON.stringify(v));
  } catch { /* almacenamiento no disponible */ }
  return null;
};

const G = { est: null, vista: null, sit: null, mes: null, sinRed: false, adminUsuario: null, ajuste: 'trabajadores', pend: null };
const NOMBRE = { entrada: 'Entrada', salida: 'Salida', pausa_inicio: 'Inicio de pausa', pausa_fin: 'Fin de pausa' };
const AUSENCIA = { vacaciones: 'Vacaciones', baja: 'Baja', permiso: 'Permiso', otro: 'Otro' };

// ---------- Comunicación con el servidor ----------
async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  let r;
  try {
    r = await fetch('/api' + ruta, {
      method: metodo, credentials: 'same-origin',
      headers: { 'X-Fichajes': '1', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    const e = new Error('Sin conexión con el servidor'); e.red = true; throw e;
  }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && G.est?.sesion) { G.est.sesion = null; pintar(); }
  if (!r.ok) { const e = new Error(datos.error || 'Error'); e.datos = datos; e.estado = r.status; throw e; }
  return datos;
}

// ---------- Fechas (siempre en la zona horaria de la empresa) ----------
const zona = () => G.est?.zona || 'Europe/Madrid';
const hora = (iso) => new Intl.DateTimeFormat('es-ES', { timeZone: zona(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const hoyEmpresa = () => new Intl.DateTimeFormat('sv-SE', { timeZone: zona() }).format(new Date());
const fechaLarga = (f) => new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(f + 'T12:00:00Z'));
const fechaCorta = (f) => f.split('-').reverse().join('/');
const mayus = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const nombreMes = (m) => mayus(new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(m + '-15T12:00:00Z')));
const cuando = (iso) => `${fechaCorta(new Intl.DateTimeFormat('sv-SE', { timeZone: zona() }).format(new Date(iso)))} ${hora(iso)}`;
const dur = (ms) => { const m = Math.round(Math.abs(ms) / 60000); return `${ms < 0 ? '−' : ''}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const durCorta = (ms) => { const m = Math.round(Math.abs(ms) / 60000); return `${ms < 0 ? '−' : ''}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const moverMes = (m, n) => { const [a, b] = m.split('-').map(Number); return new Date(Date.UTC(a, b - 1 + n, 1)).toISOString().slice(0, 7); };

// ---------- Avisos y diálogos ----------
let tTostada;
function tostada(texto, mal = false) {
  const t = $('#tostada'); t.textContent = texto; t.className = 'tostada' + (mal ? ' mal' : ''); t.hidden = false;
  clearTimeout(tTostada); tTostada = setTimeout(() => { t.hidden = true; }, mal ? 5000 : 2500);
}

/** Abre un formulario en un diálogo. Devuelve los valores o null si se cancela. */
function formulario(titulo, campos, boton = 'Guardar', texto = '') {
  const d = $('#dialogo');
  d.innerHTML = `<form method="dialog"><h2>${esc(titulo)}</h2>${texto ? `<p class="suave">${esc(texto)}</p>` : ''}
    ${campos.map((c) => {
      const comun = `name="${c.n}" ${c.req === false ? '' : 'required'}`;
      let campo;
      if (c.t === 'select') campo = `<select ${comun}>${c.o.map(([v, e]) => `<option value="${esc(v)}" ${v == c.v ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>`;
      else if (c.t === 'textarea') campo = `<textarea ${comun} maxlength="300">${esc(c.v || '')}</textarea>`;
      else campo = `<input ${comun} type="${c.t || 'text'}" value="${esc(c.v ?? '')}" ${c.extra || ''}>`;
      return `<label>${esc(c.e)}${campo}</label>`;
    }).join('')}
    <p class="error" hidden></p>
    <div class="pie"><button type="button" value="cancelar">Cancelar</button><button class="principal" value="ok">${esc(boton)}</button></div></form>`;
  return new Promise((resolver) => {
    const f = $('form', d);
    $('button[type=button]', d).onclick = () => { d.close(); resolver(null); };
    d.oncancel = () => resolver(null);
    f.onsubmit = (ev) => { ev.preventDefault(); d.close(); resolver(Object.fromEntries(new FormData(f))); };
    d.showModal();
  });
}

async function hacer(fn, ok) {
  try { await fn(); if (ok) tostada(ok); return true; } catch (e) { tostada(e.message, true); return false; }
}

// ---------- Lugar (etiqueta NFC) ----------
const LUGAR_MIN = 15;
function lugarActual() {
  try {
    const l = JSON.parse(sessionStorage.getItem('lugar') || 'null');
    return l && Date.now() - l.t < LUGAR_MIN * 60000 ? l : null;
  } catch { return null; }
}
async function fijarLugar(token) {
  let nombre = 'Etiqueta leída';
  try { nombre = (await api('/lugar/' + encodeURIComponent(token))).nombre; }
  catch (e) { if (!e.red) { tostada('Etiqueta NFC no reconocida', true); return; } }
  sessionStorage.setItem('lugar', JSON.stringify({ token, nombre, t: Date.now() }));
}
function tokenDeUrl(url) {
  try { return new URL(url, location.origin).searchParams.get('l'); } catch { return null; }
}
async function leerNfc() {
  try {
    const lector = new NDEFReader();
    const control = new AbortController();
    await lector.scan({ signal: control.signal });
    tostada('Acerca el móvil a la etiqueta…');
    lector.onreading = async ({ message }) => {
      control.abort();
      for (const rec of message.records) {
        if (rec.recordType !== 'url' && rec.recordType !== 'absolute-url') continue;
        const token = tokenDeUrl(new TextDecoder().decode(rec.data));
        if (token) { await fijarLugar(token); pintar(); return; }
      }
      tostada('Esa etiqueta no es de esta aplicación', true);
    };
  } catch { tostada('No se pudo usar el NFC. Comprueba que está activado.', true); }
}

// ---------- Fichar, con cola para cuando no hay conexión ----------
const cola = { leer: () => guardado('cola') || [], poner: (c) => guardado('cola', c) };
const SIGUIENTE = { entrada: 'trabajando', pausa_inicio: 'pausa', pausa_fin: 'trabajando', salida: 'fuera' };
const OPCIONES = { fuera: ['entrada'], trabajando: ['pausa_inicio', 'salida'], pausa: ['pausa_fin', 'salida'] };

function posicion() {
  if (!G.est.opciones.geo || !navigator.geolocation) return Promise.resolve({});
  return new Promise((ok) => navigator.geolocation.getCurrentPosition(
    (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy }),
    () => ok({}), { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }));
}

async function fichar(tipo) {
  const momento = new Date().toISOString();
  const item = { tipo, id_cliente: crypto.randomUUID(), lugar: lugarActual()?.token, ...(await posicion()) };
  try {
    G.sit = await api('/fichar', { metodo: 'POST', cuerpo: item });
    guardado('sit', G.sit);
    tostada(`${NOMBRE[tipo]} registrada a las ${hora(G.sit.ultimo.ts)}`);
  } catch (e) {
    if (e.red) {
      // Sin conexión: se guarda con su hora real y se envía en cuanto vuelva la red.
      cola.poner([...cola.leer(), { ...item, ts_cliente: momento }]);
      const estado = SIGUIENTE[tipo];
      G.sit = { ...(G.sit || {}), estado, desde: momento, opciones: OPCIONES[estado], ultimo: { tipo, ts: momento, origen: 'sin_conexion' } };
      guardado('sit', G.sit);
      tostada(`${NOMBRE[tipo]} guardada sin conexión. Se enviará sola.`);
    } else {
      if (e.datos?.estado) G.sit = e.datos;
      tostada(e.message, true);
    }
  }
  pintar();
}

let sincronizando = false;
async function sincronizar() {
  if (sincronizando || !cola.leer().length || G.est?.sesion?.rol !== 'empleado') return;
  sincronizando = true;
  try {
    while (cola.leer().length) {
      const [item, ...resto] = cola.leer();
      try { G.sit = await api('/fichar', { metodo: 'POST', cuerpo: item }); }
      catch (e) {
        if (e.red) break;
        guardado('rechazados', [...(guardado('rechazados') || []), { tipo: item.tipo, ts: item.ts_cliente, motivo: e.message }]);
      }
      cola.poner(resto);
    }
    if (!cola.leer().length) { G.sit = await api('/mi/situacion'); guardado('sit', G.sit); }
  } catch { /* se reintenta luego */ }
  sincronizando = false;
  if (G.vista === 'fichar') pintar();
}

// ---------- Arranque ----------
async function arrancar() {
  const token = tokenDeUrl(location.href);
  if (token) { sessionStorage.setItem('lugarPendiente', token); history.replaceState(null, '', '/'); }
  try { G.est = await api('/estado'); guardado('est', G.est); G.sinRed = false; }
  catch (e) { if (!e.red) throw e; G.est = guardado('est'); G.sinRed = true; }
  if (!G.est) { $('#app').innerHTML = '<p class="cargando">Sin conexión. Abre la app con conexión al menos una vez.</p>'; return; }
  G.mes = hoyEmpresa().slice(0, 7);
  G.vista = G.est.sesion?.rol === 'admin' ? 'panel' : 'fichar';
  const pendiente = sessionStorage.getItem('lugarPendiente');
  if (pendiente && G.est.sesion) { sessionStorage.removeItem('lugarPendiente'); await fijarLugar(pendiente); }
  await pintar();
  sincronizar();
}

// ---------- Pintado ----------
const VISTAS_EMPLEADO = [['fichar', '⏱', 'Fichar'], ['registro', '📋', 'Mis fichajes'], ['ausencias', '🌴', 'Ausencias'], ['cuenta', '👤', 'Cuenta']];
const VISTAS_ADMIN = [['panel', '🏠', 'Panel'], ['registro', '📋', 'Registro'], ['solicitudes', '✏️', 'Correcciones'], ['ausencias', '🌴', 'Ausencias'], ['ajustes', '⚙️', 'Ajustes']];

async function pintar() {
  const s = G.est.sesion, app = $('#app');
  $('#aviso').hidden = !G.sinRed; $('#aviso').textContent = 'Sin conexión: los fichajes se guardan en el móvil y se envían al volver la red.';
  $('#cabecera').hidden = $('#menu').hidden = !s;
  if (!G.est.configurado) { app.innerHTML = vistaConfigurar(); return; }
  if (!s) { app.innerHTML = vistaEntrar(); return; }
  if (s.debeCambiarClave && !G.sinRed) { app.innerHTML = vistaClaveObligatoria(); return; }

  $('#cabecera').innerHTML = `<div><b>${esc(G.est.empresa)}</b><small>${esc(s.nombre)}${s.rol === 'admin' ? ' · Administración' : ''}</small></div>`;
  const vistas = s.rol === 'admin' ? VISTAS_ADMIN : VISTAS_EMPLEADO;
  const globo = (v) => {
    const n = v === 'solicitudes' ? G.pend?.solicitudes : v === 'ausencias' ? G.pend?.ausencias : 0;
    return s.rol === 'admin' && n ? `<span class="globo">${n}</span>` : '';
  };
  $('#menu').innerHTML = vistas.map(([v, ico, e]) =>
    `<button data-a="ir" data-v="${v}" aria-current="${G.vista === v}"><span class="ico" aria-hidden="true">${ico}</span>${e}${globo(v)}</button>`).join('');

  const pintor = (s.rol === 'admin' ? ADMIN : EMPLEADO)[G.vista];
  try { app.innerHTML = await pintor(); G.sinRed = false; }
  catch (e) {
    if (e.red) { G.sinRed = true; app.innerHTML = G.vista === 'fichar' ? await EMPLEADO.fichar(true) : '<p class="cargando">Esta pantalla necesita conexión.</p>'; }
    else app.innerHTML = `<p class="cargando">${esc(e.message)}</p>`;
  }
  $('#aviso').hidden = !G.sinRed;
}

// ---------- Acceso ----------
const vistaConfigurar = () => `<div class="tarjeta acceso"><h1>Primer arranque</h1>
  <p class="suave">Crea la cuenta de administración de ${esc(G.est.empresa)}. Con ella darás de alta a los trabajadores.</p>
  <form data-f="configurar">
    <label>Tu nombre<input name="nombre" required autocomplete="name"></label>
    <label>Usuario (sin espacios)<input name="usuario" required pattern="[A-Za-z0-9._\\-]{3,40}" autocapitalize="none" autocomplete="username"></label>
    <label>Contraseña (mínimo 10 caracteres)<input name="clave" type="password" required minlength="10" autocomplete="new-password"></label>
    <p class="error" hidden></p><button class="principal">Crear administrador</button></form></div>`;

const vistaEntrar = () => `<div class="tarjeta acceso"><h1>${esc(G.est.empresa)}</h1><p class="suave">Registro de jornada</p>
  <form data-f="entrar">
    <label>Usuario<input name="usuario" required autocapitalize="none" autocomplete="username"></label>
    <label>Contraseña<input name="clave" type="password" required autocomplete="current-password"></label>
    <p class="error" hidden></p><button class="principal">Entrar</button></form></div>`;

const vistaClaveObligatoria = () => `<div class="tarjeta acceso"><h2>Elige tu contraseña</h2>
  <p class="suave">La contraseña que te han dado es provisional. Cámbiala por una que solo conozcas tú.</p>${formClave()}</div>`;

const formClave = () => `<form data-f="clave">
  <label>Contraseña actual<input name="actual" type="password" required autocomplete="current-password"></label>
  <label>Contraseña nueva<input name="nueva" type="password" required minlength="6" autocomplete="new-password"></label>
  <p class="error" hidden></p><button class="principal">Cambiar contraseña</button></form>`;

// ---------- Trozos comunes ----------
function htmlMes(d, esAdmin) {
  const t = d.totales, hoy = hoyEmpresa();
  const porFecha = {};
  for (const e of d.eventos) (porFecha[e.fecha] ||= []).push(e);
  const dias = d.dias.filter((x) => x.fecha <= hoy || x.festivo || x.ausencia)
    .filter((x) => x.jornadas.length || x.incidencias.length || x.festivo || x.ausencia || x.previstoMs || porFecha[x.fecha]).reverse();
  return `
    <div class="totales">
      <div><b>${durCorta(t.trabajadoMs)}</b><span>Trabajado</span></div>
      <div><b>${durCorta(t.pausaMs)}</b><span>Pausas</span></div>
      <div><b>${durCorta(t.previstoMs)}</b><span>Previsto</span></div>
      <div><b>${durCorta(t.saldoMs)}</b><span>Saldo</span></div>
    </div>
    ${t.incidencias ? `<p class="nota mal">Hay ${t.incidencias} incidencia(s) este mes: revisa los días marcados.</p>` : ''}
    <div class="lista">${dias.map((x) => `
      <div class="dia ${x.diaSemana === 0 || x.diaSemana === 6 ? 'finde' : ''} ${x.jornadas.length ? '' : 'vacio'}">
        <div class="fila"><b class="fecha">${esc(fechaLarga(x.fecha))}</b><span class="num">${x.jornadas.length ? dur(x.trabajadoMs) : ''}</span></div>
        ${x.festivo ? `<span class="suave">Festivo: ${esc(x.festivo)}</span>` : ''}
        ${x.ausencia ? `<span class="suave">Ausencia: ${esc(AUSENCIA[x.ausencia])}</span>` : ''}
        ${!x.jornadas.length && !x.festivo && !x.ausencia && x.previstoMs ? '<span class="suave">Sin fichajes</span>' : ''}
        ${x.jornadas.map((j) => `<div class="tramo">${j.entrada.hora} → ${j.salida ? j.salida.hora : j.estado === 'en_curso' ? '<span class="pastilla trabajando">en curso</span>' : '<span class="pastilla mal plana">sin salida</span>'}
          ${j.pausaMs >= 30000 ? `<span class="suave"> · pausa ${durCorta(j.pausaMs)}</span>` : ''}${j.entrada.lugar ? `<span class="suave"> · ${esc(j.entrada.lugar)}</span>` : ''}</div>`).join('')}
        ${x.incidencias.map((i) => `<div class="nota mal">${esc(i)}</div>`).join('')}
        ${porFecha[x.fecha] ? `<details><summary>Ver fichajes del día (${porFecha[x.fecha].length})</summary><div class="lista">
          ${porFecha[x.fecha].map((e) => `<div class="fila"><div class="crece ${e.anulado ? 'tachado' : ''}"><span class="num">${e.hora}</span> ${NOMBRE[e.tipo]}
            <div class="suave mini">${e.origen === 'manual' ? `Añadido por ${esc(e.autor)}: ${esc(e.motivo)}` : e.origen === 'sin_conexion' ? 'Hecho sin conexión' : 'Desde la app'}${e.lugar ? ' · ' + esc(e.lugar) : ''}
            ${e.anulado ? `<br>Anulado por ${esc(e.anulado.por)}: ${esc(e.anulado.motivo)}` : ''}</div></div>
            ${e.anulado ? '' : `<button class="chico" data-a="${esAdmin ? 'anular' : 'pedirAnular'}" data-id="${e.id}">${esAdmin ? 'Anular' : 'Pedir anulación'}</button>`}</div>`).join('')}
        </div></details>` : ''}
      </div>`).join('') || '<p class="suave">No hay nada en este mes.</p>'}</div>`;
}
const barraMes = () => `<div class="mes"><button class="chico" data-a="mes" data-n="-1" aria-label="Mes anterior">‹</button>
  <b>${esc(nombreMes(G.mes))}</b><button class="chico" data-a="mes" data-n="1" aria-label="Mes siguiente">›</button></div>`;
const estadoTxt = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' };
const pastillaEstado = (e) => `<span class="pastilla plana ${e === 'aprobada' ? 'trabajando' : e === 'rechazada' ? 'mal' : 'pausa'}">${estadoTxt[e]}</span>`;

// ---------- Vistas del trabajador ----------
const EMPLEADO = {
  async fichar(sinRed = false) {
    if (!sinRed) { G.sit = await api('/mi/situacion'); guardado('sit', G.sit); }
    else G.sit = G.sit || guardado('sit') || { estado: 'fuera', opciones: ['entrada'] };
    const s = G.sit, lugar = lugarActual(), pendientes = cola.leer(), rechazados = guardado('rechazados') || [];
    const txt = { fuera: 'Fuera', trabajando: 'Trabajando', pausa: 'En pausa' }[s.estado];
    const clases = { entrada: 'entrar', salida: 'salir', pausa_inicio: 'pausar', pausa_fin: 'entrar' };
    const etiquetas = { entrada: 'Entrar', salida: 'Salir', pausa_inicio: 'Pausa', pausa_fin: 'Volver de la pausa' };
    const falta = G.est.opciones.requiereLugar && !lugar;
    return `
      <div class="tarjeta estado">
        <span class="pastilla ${s.estado}">${txt}</span>
        <div class="reloj" id="reloj">${hora(new Date().toISOString())}</div>
        <p class="suave">${s.estado === 'fuera' ? (s.ultimo ? `Última salida: ${cuando(s.ultimo.ts)}` : 'Aún no has fichado') :
          s.estado === 'pausa' ? `En pausa desde las ${hora(s.desde)}` : `Entrada a las ${hora(s.desde)}`}</p>
        ${s.hoy && !sinRed ? `<p>Hoy llevas <b class="num">${dur(s.jornada ? Math.max(s.hoy.trabajadoMs, s.jornada.trabajadoMs) : s.hoy.trabajadoMs)}</b></p>` : ''}
        ${lugar ? `<span class="pastilla marca plana">📍 ${esc(lugar.nombre)}</span>` : ''}
      </div>
      ${falta ? '<p class="nota">Para fichar, acerca el móvil a la etiqueta NFC del lugar de trabajo.</p>' : ''}
      <div class="botones ${s.opciones.length > 1 ? 'dos' : ''}">
        ${s.opciones.map((o) => `<button class="grande ${clases[o]}" data-a="fichar" data-t="${o}" ${falta ? 'disabled' : ''}>${etiquetas[o]}</button>`).join('')}
      </div>
      ${'NDEFReader' in window ? '<button data-a="nfc">📶 Leer etiqueta NFC del lugar</button>' : ''}
      ${pendientes.length ? `<p class="nota">${pendientes.length} fichaje(s) guardados en el móvil, pendientes de enviar.</p>` : ''}
      ${rechazados.length ? `<div class="nota mal">No se pudieron anotar estos fichajes hechos sin conexión. Pide una corrección en «Mis fichajes»:
        ${rechazados.map((r) => `<br>· ${NOMBRE[r.tipo]} del ${cuando(r.ts)}`).join('')}<br><button class="chico" data-a="olvidarRechazados">Entendido</button></div>` : ''}
      ${s.olvido ? '<p class="nota mal">Tienes una jornada sin salida. Pide la corrección en «Mis fichajes».</p>' : ''}`;
  },

  async registro() {
    const [d, sol] = await Promise.all([api('/mi/mes?mes=' + G.mes), api('/mi/solicitudes')]);
    return `<div class="tarjeta">${barraMes()}${htmlMes(d, false)}
        <div class="fila"><a class="boton" href="/api/mi/informe.pdf?mes=${G.mes}" target="_blank" rel="noopener">Descargar PDF</a>
        <button class="principal" data-a="pedirAnadir">Pedir corrección</button></div></div>
      <div class="tarjeta"><h3>Mis solicitudes de corrección</h3><div class="lista">${sol.map((s) => `<div>
        <div class="fila"><span>${s.accion === 'anadir' ? `Añadir ${NOMBRE[s.tipo].toLowerCase()} el ${cuando(s.ts)}` : `Anular fichaje nº ${s.evento_id}`}</span>${pastillaEstado(s.estado)}</div>
        <div class="suave mini">${esc(s.motivo)}${s.respuesta ? ` — Respuesta: ${esc(s.respuesta)}` : ''}</div></div>`).join('') || '<p class="suave">No has pedido ninguna.</p>'}</div></div>`;
  },

  async ausencias() {
    const l = await api('/mi/ausencias');
    return `<div class="tarjeta"><div class="fila"><h2>Ausencias</h2><button class="principal" data-a="pedirAusencia">Solicitar</button></div>
      <div class="lista">${l.map((a) => `<div><div class="fila"><span><b>${AUSENCIA[a.tipo]}</b> · ${fechaCorta(a.desde)}${a.hasta !== a.desde ? ' – ' + fechaCorta(a.hasta) : ''}</span>${pastillaEstado(a.estado)}</div>
        ${a.nota ? `<div class="suave mini">${esc(a.nota)}</div>` : ''}</div>`).join('') || '<p class="suave">No tienes ausencias registradas.</p>'}</div></div>`;
  },

  async cuenta() { return vistaCuenta(); },
};

const vistaCuenta = () => `<div class="tarjeta"><h2>${esc(G.est.sesion.nombre)}</h2><p class="suave">Usuario: ${esc(G.est.sesion.usuario)}</p>
    <button data-a="salirSesion">Cerrar sesión en este dispositivo</button></div>
  <div class="tarjeta"><h3>Cambiar contraseña</h3>${formClave()}</div>
  <div class="tarjeta"><h3>Tus datos</h3><p class="suave">Esta aplicación guarda la hora de tus fichajes${G.est.opciones.geo ? ', el lugar de trabajo y la ubicación del móvil solo en el instante de fichar' : ' y el lugar de trabajo'},
    para cumplir la obligación legal de registro de jornada (art. 34.9 del Estatuto de los Trabajadores). Se conservan cuatro años. Puedes consultar y descargar tu registro en «Mis fichajes» y pedir la corrección de cualquier error.</p></div>`;

// ---------- Vistas de administración ----------
const ADMIN = {
  async panel() {
    const p = await api('/admin/panel'); G.pend = p.pendientes;
    const txt = { fuera: 'Fuera', trabajando: 'Trabajando', pausa: 'En pausa' };
    return `${p.pendientes.solicitudes || p.pendientes.ausencias ? `<p class="nota">Pendiente de revisar: ${p.pendientes.solicitudes} corrección(es) y ${p.pendientes.ausencias} ausencia(s).</p>` : ''}
      ${p.empleados.map((e) => `<div class="tarjeta">
        <div class="fila"><h2>${esc(e.nombre)}</h2><span class="pastilla ${e.estado}">${txt[e.estado]}</span></div>
        <p class="suave">${e.estado === 'fuera' ? (e.ultimo ? `Última salida: ${cuando(e.ultimo.ts)}` : 'Sin fichajes todavía') :
          `${e.estado === 'pausa' ? 'En pausa desde' : 'Entró a'} las ${hora(e.desde)}${e.ultimo?.lugar ? ' · ' + esc(e.ultimo.lugar) : ''}`}
          · Hoy: <b class="num">${dur(e.jornada ? Math.max(e.hoy.trabajadoMs, e.jornada.trabajadoMs) : e.hoy.trabajadoMs)}</b></p>
        ${e.incidencias.map((i) => `<div class="nota mal">${fechaCorta(i.fecha)}: ${esc(i.incidencias.join('; '))}</div>`).join('')}
        <button class="chico" data-a="verRegistro" data-id="${e.id}">Ver registro</button></div>`).join('')
        || '<div class="tarjeta"><p>Todavía no hay trabajadores. Créalos en <b>Ajustes → Trabajadores</b>.</p></div>'}`;
  },

  async registro() {
    const us = (await api('/admin/usuarios')).filter((u) => u.rol === 'empleado');
    if (!us.length) return '<div class="tarjeta"><p>Todavía no hay trabajadores.</p></div>';
    if (!us.some((u) => u.id == G.adminUsuario)) G.adminUsuario = us[0].id;
    const d = await api(`/admin/mes?usuario=${G.adminUsuario}&mes=${G.mes}`);
    const q = `usuario=${G.adminUsuario}&mes=${G.mes}`;
    return `<div class="tarjeta">
      <label>Trabajador<select data-c="adminUsuario">${us.map((u) => `<option value="${u.id}" ${u.id == G.adminUsuario ? 'selected' : ''}>${esc(u.nombre)}${u.activo ? '' : ' (baja)'}</option>`).join('')}</select></label>
      ${barraMes()}${htmlMes(d, true)}
      <div class="fila"><a class="boton" href="/api/admin/informe.pdf?${q}" target="_blank" rel="noopener">PDF</a>
        <a class="boton" href="/api/admin/informe.csv?${q}">CSV</a>
        <button class="principal" data-a="manual">Añadir fichaje</button></div></div>`;
  },

  async solicitudes() {
    const l = await api('/admin/solicitudes');
    return `<div class="tarjeta"><h2>Correcciones solicitadas</h2><div class="lista">${l.map((s) => `<div>
      <div class="fila"><b>${esc(s.nombre)}</b>${pastillaEstado(s.estado)}</div>
      <div>${esc(s.descripcion)}</div><div class="suave mini">Motivo: ${esc(s.motivo)}${s.respuesta ? ` — Respuesta: ${esc(s.respuesta)}` : ''}</div>
      ${s.estado === 'pendiente' ? `<div class="fila"><button class="chico principal" data-a="resolver" data-id="${s.id}" data-ok="1">Aprobar</button>
        <button class="chico peligro" data-a="resolver" data-id="${s.id}" data-ok="">Rechazar</button></div>` : ''}</div>`).join('')
      || '<p class="suave">No hay solicitudes.</p>'}</div></div>`;
  },

  async ausencias() {
    const l = await api('/admin/ausencias');
    return `<div class="tarjeta"><div class="fila"><h2>Ausencias</h2><button class="principal" data-a="nuevaAusencia">Añadir</button></div>
      <div class="lista">${l.map((a) => `<div><div class="fila"><span><b>${esc(a.nombre)}</b> · ${AUSENCIA[a.tipo]}</span>${pastillaEstado(a.estado)}</div>
        <div class="suave">${fechaCorta(a.desde)}${a.hasta !== a.desde ? ' – ' + fechaCorta(a.hasta) : ''}${a.nota ? ' · ' + esc(a.nota) : ''}</div>
        <div class="fila">${a.estado !== 'aprobada' ? `<button class="chico principal" data-a="ausenciaEstado" data-id="${a.id}" data-e="aprobada">Aprobar</button>` : ''}
        ${a.estado !== 'rechazada' ? `<button class="chico peligro" data-a="ausenciaEstado" data-id="${a.id}" data-e="rechazada">${a.estado === 'aprobada' ? 'Cancelar' : 'Rechazar'}</button>` : ''}</div></div>`).join('')
      || '<p class="suave">No hay ausencias.</p>'}</div></div>`;
  },

  async ajustes() {
    const secciones = [['trabajadores', 'Trabajadores'], ['lugares', 'Lugares NFC'], ['festivos', 'Festivos'], ['opciones', 'Opciones'], ['datos', 'Datos'], ['cuenta', 'Mi cuenta']];
    const pestanas = `<div class="fila">${secciones.map(([k, e]) => `<button class="chico ${G.ajuste === k ? 'principal' : ''}" data-a="ajuste" data-k="${k}">${e}</button>`).join('')}</div>`;
    return pestanas + await AJUSTES[G.ajuste]();
  },
};

const AJUSTES = {
  async trabajadores() {
    const us = await api('/admin/usuarios');
    return `<div class="tarjeta"><div class="fila"><h2>Usuarios</h2><button class="principal" data-a="nuevoUsuario">Nuevo</button></div>
      <div class="lista">${us.map((u) => `<div><div class="fila"><span class="${u.activo ? '' : 'tachado'}"><b>${esc(u.nombre)}</b> <span class="suave">${esc(u.usuario)}${u.rol === 'admin' ? ' · administrador' : ` · ${u.horas_semana} h/semana`}${u.dni ? ' · ' + esc(u.dni) : ''}</span></span></div>
        <div class="fila"><button class="chico" data-a="editarUsuario" data-id="${u.id}" data-nombre="${esc(u.nombre)}" data-dni="${esc(u.dni)}" data-horas="${u.horas_semana}">Editar</button>
          <button class="chico" data-a="claveUsuario" data-id="${u.id}" data-nombre="${esc(u.nombre)}">Nueva contraseña</button>
          ${u.id === G.est.sesion.id ? '' : `<button class="chico ${u.activo ? 'peligro' : ''}" data-a="activoUsuario" data-id="${u.id}" data-activo="${u.activo ? '' : '1'}">${u.activo ? 'Dar de baja' : 'Reactivar'}</button>`}</div></div>`).join('')}</div>
      <p class="suave mini">Dar de baja impide entrar, pero el registro del trabajador se conserva y sigue disponible en los informes.</p></div>`;
  },

  async lugares() {
    const l = await api('/admin/lugares'), nfc = 'NDEFReader' in window;
    return `<div class="tarjeta"><div class="fila"><h2>Lugares de trabajo</h2><button class="principal" data-a="nuevoLugar">Nuevo</button></div>
      <p class="suave">Cada lugar tiene una dirección para grabar en su etiqueta NFC. Al acercar el móvil se abre la app con el lugar ya identificado.</p>
      <div class="lista">${l.map((x) => { const url = `${location.origin}/?l=${x.token}`; return `<div>
        <div class="fila"><b class="${x.activo ? '' : 'tachado'}">${esc(x.nombre)}</b></div><div class="codigo">${esc(url)}</div>
        <div class="fila"><button class="chico" data-a="copiar" data-txt="${esc(url)}">Copiar dirección</button>
          ${nfc ? `<button class="chico principal" data-a="grabarNfc" data-url="${esc(url)}">Grabar etiqueta</button>` : ''}
          <button class="chico" data-a="activoLugar" data-id="${x.id}" data-activo="${x.activo ? '' : '1'}">${x.activo ? 'Desactivar' : 'Activar'}</button></div></div>`; }).join('')
        || '<p class="suave">No hay lugares todavía.</p>'}</div>
      ${nfc ? '' : '<p class="suave mini">Para grabar etiquetas desde aquí abre esta pantalla en Chrome de un móvil Android. También puedes copiar la dirección y grabarla con una app como NFC Tools (registro de tipo URL).</p>'}</div>`;
  },

  async festivos() {
    const anio = G.mes.slice(0, 4), l = await api('/admin/festivos?anio=' + anio);
    return `<div class="tarjeta"><div class="fila"><h2>Festivos de ${anio}</h2><button class="principal" data-a="nuevoFestivo">Añadir</button></div>
      <div class="lista">${l.map((f) => `<div class="fila"><span>${esc(fechaLarga(f.fecha))} · ${esc(f.nombre)}</span><button class="chico" data-a="borrarFestivo" data-f="${f.fecha}">Quitar</button></div>`).join('')
        || '<p class="suave">No hay festivos cargados para este año.</p>'}</div>
      <button data-a="festivosNacionales" data-anio="${anio}">Cargar festivos nacionales de ${anio}</button>
      <p class="suave mini">Se cargan los nacionales de fecha fija y el Viernes Santo. Añade a mano los autonómicos y locales y revisa el calendario laboral oficial: algunos se trasladan cuando caen en domingo. Los festivos solo afectan al cálculo de horas previstas. Para ver otro año, cambia el mes en «Registro».</p></div>`;
  },

  async opciones() {
    const o = await api('/admin/opciones');
    return `<div class="tarjeta"><h2>Opciones</h2>
      <label class="interruptor"><input type="checkbox" data-o="geo" ${o.geo ? 'checked' : ''}>Guardar la ubicación del móvil al fichar</label>
      <p class="suave mini">Solo en el instante de fichar, nunca de forma continua. Informa de ello a los trabajadores.</p>
      <label class="interruptor"><input type="checkbox" data-o="requiereLugar" ${o.requiereLugar ? 'checked' : ''}>Exigir etiqueta NFC para fichar</label>
      <p class="suave mini">Si lo activas, solo se podrá fichar justo después de acercar el móvil a una etiqueta de un lugar de trabajo.</p></div>`;
  },

  async datos() {
    const [i, act] = await Promise.all([api('/admin/integridad'), api('/admin/actividad')]);
    return `<div class="tarjeta"><h2>Integridad del registro</h2>
      <p class="nota ${i.ok ? 'ok' : 'mal'}">${i.ok ? `Correcta: ${i.eventos} fichajes encadenados sin alteraciones.` : `ALTERADO: ${esc(i.fallo)}`}</p>
      ${i.ultimoHash ? `<div class="codigo">${i.ultimoHash}</div>` : ''}
      <a class="boton" href="/api/admin/exportar.json">Descargar copia completa (JSON)</a>
      <p class="suave mini">La copia completa sirve para entregar el registro a la Inspección o a la gestoría. El servidor guarda además una copia diaria de la base de datos.</p></div>
      <div class="tarjeta"><h3>Actividad reciente</h3><div class="lista">${act.slice(0, 60).map((a) => `<div class="mini"><span class="num">${a.cuando}</span> · ${esc(a.nombre || '—')} · ${esc(a.accion.replace(/_/g, ' '))} <span class="suave">${esc(a.detalle)}</span></div>`).join('')}</div></div>`;
  },

  async cuenta() { return vistaCuenta(); },
};

// ---------- Acciones (botones con data-a) ----------
const post = (ruta, cuerpo, metodo = 'POST') => api(ruta, { metodo, cuerpo });
const TIPOS_SEL = Object.entries(NOMBRE);
const campoMotivo = { n: 'motivo', e: 'Motivo (obligatorio)', t: 'textarea' };

const ACCIONES = {
  ir: (d) => { G.vista = d.v; pintar(); },
  ajuste: (d) => { G.ajuste = d.k; pintar(); },
  mes: (d) => { G.mes = moverMes(G.mes, Number(d.n)); pintar(); },
  fichar: (d, boton) => { boton.disabled = true; return fichar(d.t); },
  nfc: leerNfc,
  olvidarRechazados: () => { guardado('rechazados', []); pintar(); },
  verRegistro: (d) => { G.adminUsuario = Number(d.id); G.vista = 'registro'; pintar(); },
  salirSesion: async () => { await hacer(() => post('/salir', {})); G.est.sesion = null; guardado('sit', null); pintar(); },
  copiar: async (d) => { await hacer(() => navigator.clipboard.writeText(d.txt), 'Dirección copiada'); },

  async pedirAnadir() {
    const v = await formulario('Pedir corrección', [
      { n: 'tipo', e: 'Fichaje que falta', t: 'select', o: TIPOS_SEL },
      { n: 'fecha', e: 'Día', t: 'date', v: hoyEmpresa(), extra: `max="${hoyEmpresa()}"` },
      { n: 'hora', e: 'Hora', t: 'time' }, campoMotivo], 'Enviar solicitud', 'La empresa revisará tu solicitud. El registro original no se borra.');
    if (v && await hacer(() => post('/mi/solicitudes', { accion: 'anadir', tipo: v.tipo, momento: `${v.fecha}T${v.hora}`, motivo: v.motivo }), 'Solicitud enviada')) pintar();
  },
  async pedirAnular(d) {
    const v = await formulario('Pedir anulación de un fichaje', [campoMotivo], 'Enviar solicitud');
    if (v && await hacer(() => post('/mi/solicitudes', { accion: 'anular', evento_id: d.id, motivo: v.motivo }), 'Solicitud enviada')) pintar();
  },
  async pedirAusencia() {
    const v = await formulario('Solicitar ausencia', [
      { n: 'tipo', e: 'Tipo', t: 'select', o: [['vacaciones', 'Vacaciones'], ['permiso', 'Permiso'], ['otro', 'Otro']] },
      { n: 'desde', e: 'Desde', t: 'date' }, { n: 'hasta', e: 'Hasta (incluido)', t: 'date' },
      { n: 'nota', e: 'Nota (opcional)', req: false }], 'Solicitar');
    if (v && await hacer(() => post('/mi/ausencias', v), 'Solicitud enviada')) pintar();
  },

  async manual() {
    const v = await formulario('Añadir fichaje manual', [
      { n: 'tipo', e: 'Tipo', t: 'select', o: TIPOS_SEL },
      { n: 'fecha', e: 'Día', t: 'date', v: hoyEmpresa(), extra: `max="${hoyEmpresa()}"` },
      { n: 'hora', e: `Hora (${zona()})`, t: 'time' }, campoMotivo], 'Añadir', 'Quedará marcado como corrección, con tu nombre y el motivo.');
    if (v && await hacer(() => post('/admin/eventos', { usuario_id: G.adminUsuario, tipo: v.tipo, momento: `${v.fecha}T${v.hora}`, motivo: v.motivo }), 'Fichaje añadido')) pintar();
  },
  async anular(d) {
    const v = await formulario('Anular fichaje', [campoMotivo], 'Anular', 'El fichaje original se conserva en el registro, marcado como anulado.');
    if (v && await hacer(() => post(`/admin/eventos/${d.id}/anular`, v), 'Fichaje anulado')) pintar();
  },
  async resolver(d) {
    const v = await formulario(d.ok ? 'Aprobar corrección' : 'Rechazar corrección', [{ n: 'respuesta', e: 'Respuesta para el trabajador (opcional)', req: false }], d.ok ? 'Aprobar' : 'Rechazar');
    if (v && await hacer(() => post('/admin/solicitudes/' + d.id, { aprobar: !!d.ok, respuesta: v.respuesta }), 'Hecho')) { G.pend = null; pintar(); }
  },
  async nuevaAusencia() {
    const us = (await api('/admin/usuarios')).filter((u) => u.rol === 'empleado' && u.activo);
    const v = await formulario('Añadir ausencia', [
      { n: 'usuario_id', e: 'Trabajador', t: 'select', o: us.map((u) => [u.id, u.nombre]) },
      { n: 'tipo', e: 'Tipo', t: 'select', o: Object.entries(AUSENCIA) },
      { n: 'desde', e: 'Desde', t: 'date' }, { n: 'hasta', e: 'Hasta (incluido)', t: 'date' },
      { n: 'nota', e: 'Nota (opcional)', req: false }], 'Añadir');
    if (v && await hacer(() => post('/admin/ausencias', v), 'Ausencia añadida')) pintar();
  },
  async ausenciaEstado(d) { if (await hacer(() => post('/admin/ausencias/' + d.id, { estado: d.e }), 'Hecho')) { G.pend = null; pintar(); } },

  async nuevoUsuario() {
    const v = await formulario('Nuevo usuario', [
      { n: 'nombre', e: 'Nombre y apellidos' }, { n: 'dni', e: 'DNI/NIE (sale en los informes)', req: false },
      { n: 'usuario', e: 'Usuario para entrar (sin espacios)', extra: 'autocapitalize="none" pattern="[A-Za-z0-9._\\-]{3,40}"' },
      { n: 'clave', e: 'Contraseña provisional (mín. 6; 10 si es administrador)', extra: 'minlength="6"' },
      { n: 'horas_semana', e: 'Horas semanales de contrato', t: 'number', v: 40, extra: 'min="1" max="60" step="0.5"' },
      { n: 'rol', e: 'Tipo', t: 'select', o: [['empleado', 'Trabajador'], ['admin', 'Administrador']] }], 'Crear', 'Tendrá que cambiar la contraseña la primera vez que entre.');
    if (v && await hacer(() => post('/admin/usuarios', v), 'Usuario creado')) pintar();
  },
  async editarUsuario(d) {
    const v = await formulario('Editar usuario', [{ n: 'nombre', e: 'Nombre y apellidos', v: d.nombre }, { n: 'dni', e: 'DNI/NIE', v: d.dni, req: false },
      { n: 'horas_semana', e: 'Horas semanales', t: 'number', v: d.horas, extra: 'min="1" max="60" step="0.5"' }]);
    if (v && await hacer(() => post('/admin/usuarios/' + d.id, v, 'PATCH'), 'Guardado')) pintar();
  },
  async claveUsuario(d) {
    const v = await formulario(`Nueva contraseña para ${d.nombre}`, [{ n: 'clave', e: 'Contraseña provisional', extra: 'minlength="6"' }], 'Cambiar', 'Se cerrarán sus sesiones y tendrá que elegir otra al entrar.');
    if (v && await hacer(() => post('/admin/usuarios/' + d.id, v, 'PATCH'), 'Contraseña cambiada')) pintar();
  },
  async activoUsuario(d) { if (await hacer(() => post('/admin/usuarios/' + d.id, { activo: !!d.activo }, 'PATCH'), 'Hecho')) pintar(); },

  async nuevoLugar() {
    const v = await formulario('Nuevo lugar de trabajo', [{ n: 'nombre', e: 'Nombre (p. ej. Oficina, Almacén)' }], 'Crear');
    if (v && await hacer(() => post('/admin/lugares', v), 'Lugar creado')) pintar();
  },
  async activoLugar(d) { if (await hacer(() => post('/admin/lugares/' + d.id, { activo: !!d.activo }, 'PATCH'), 'Hecho')) pintar(); },
  async grabarNfc(d) {
    tostada('Acerca la etiqueta al móvil…');
    await hacer(() => new NDEFReader().write({ records: [{ recordType: 'url', data: d.url }] }), 'Etiqueta grabada');
  },

  async nuevoFestivo() {
    const v = await formulario('Añadir festivo', [{ n: 'fecha', e: 'Fecha', t: 'date' }, { n: 'nombre', e: 'Nombre' }], 'Añadir');
    if (v && await hacer(() => post('/admin/festivos', v), 'Festivo añadido')) pintar();
  },
  async borrarFestivo(d) { if (await hacer(() => post('/admin/festivos/' + d.f, undefined, 'DELETE'))) pintar(); },
  async festivosNacionales(d) { if (await hacer(() => post('/admin/festivos/nacionales', { anio: Number(d.anio) }), 'Festivos cargados')) pintar(); },
};

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-a]');
  if (b && ACCIONES[b.dataset.a]) ACCIONES[b.dataset.a](b.dataset, b);
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.c === 'adminUsuario') { G.adminUsuario = Number(t.value); pintar(); }
  if (t.dataset.o) { await hacer(() => post('/admin/opciones', { [t.dataset.o]: t.checked }), 'Guardado'); G.est = await api('/estado'); }
});

// Formularios de acceso (data-f)
document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-f]');
  if (!f) return;
  ev.preventDefault();
  const datos = Object.fromEntries(new FormData(f)), error = $('.error', f);
  try {
    await post({ configurar: '/configurar', entrar: '/entrar', clave: '/clave' }[f.dataset.f], datos);
    if (f.dataset.f === 'clave') tostada('Contraseña cambiada');
    await arrancar();
  } catch (e) { error.textContent = e.message; error.hidden = false; }
});

// Reloj, reconexión y vuelta a primer plano
setInterval(() => { const r = $('#reloj'); if (r) r.textContent = hora(new Date().toISOString()); }, 5000);
window.addEventListener('online', async () => { await sincronizar(); if (G.sinRed) arrancar(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && G.est?.sesion && !$('#dialogo').open) { sincronizar(); if (G.vista === 'fichar' || G.vista === 'panel') pintar(); }
});
setInterval(sincronizar, 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
arrancar().catch((e) => { $('#app').innerHTML = `<p class="cargando">${esc(e.message)}</p>`; });
