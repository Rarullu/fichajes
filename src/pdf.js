// Informe mensual en PDF: el extracto legible del registro de jornada de un trabajador.
import PDFDocument from 'pdfkit';
import crypto from 'node:crypto';
import { EMPRESA, TZ } from './config.js';
import { ultimoHash, ahoraISO } from './db.js';
import { datosMes } from './datos.js';
import { hhmm, localStr } from './jornada.js';

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const marca = (e) => e.hora + (e.origen === 'manual' ? '*' : e.origen === 'sin_conexion' ? '°' : '');

export function informePdf(res, u, mes, emitidoPor) {
  const d = datosMes(u, mes);
  const [anio, m] = mes.split('-').map(Number);
  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `Registro de jornada ${u.nombre} ${mes}`, Author: EMPRESA.nombre } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="registro-jornada-${u.usuario}-${mes}.pdf"`);
  doc.pipe(res);

  const X = 36, ANCHO = doc.page.width - 72;
  doc.font('Helvetica-Bold').fontSize(14).text('Registro diario de jornada', X, 36);
  doc.font('Helvetica').fontSize(8).fillColor('#555').text('Artículo 34.9 del Estatuto de los Trabajadores', X, 54).fillColor('#000');

  doc.fontSize(9);
  const y0 = 72;
  doc.font('Helvetica-Bold').text('Empresa: ', X, y0, { continued: true }).font('Helvetica')
    .text(`${EMPRESA.nombre}${EMPRESA.cif ? `  ·  CIF ${EMPRESA.cif}` : ''}`);
  if (EMPRESA.direccion) doc.text(EMPRESA.direccion, X);
  doc.font('Helvetica-Bold').text('Trabajador/a: ', X, doc.y + 2, { continued: true }).font('Helvetica')
    .text(`${u.nombre}${u.dni ? `  ·  DNI/NIE ${u.dni}` : ''}`);
  doc.font('Helvetica-Bold').text('Periodo: ', { continued: true }).font('Helvetica')
    .text(`${MESES[m - 1]} de ${anio}   ·   Horas en zona horaria ${TZ}`);

  // ---- Tabla ----
  const cols = [
    { t: 'Día', w: 52 }, { t: 'Entrada – Salida', w: 150 }, { t: 'Pausas', w: 120 },
    { t: 'Pausa', w: 38 }, { t: 'Trabajado', w: 48 }, { t: 'Observaciones', w: ANCHO - 408 },
  ];
  let y = doc.y + 10;
  const cabecera = () => {
    doc.rect(X, y, ANCHO, 15).fill('#e8ecf1').fillColor('#000').font('Helvetica-Bold').fontSize(8);
    let x = X;
    for (const c of cols) { doc.text(c.t, x + 3, y + 4, { width: c.w - 6 }); x += c.w; }
    y += 15; doc.font('Helvetica').fontSize(8);
  };
  cabecera();

  for (const dia of d.dias) {
    const tramos = dia.jornadas.map((j) =>
      `${marca(j.entrada)} – ${j.salida ? marca(j.salida) : j.estado === 'en_curso' ? 'en curso' : 'sin salida'}`).join('\n');
    const pausas = dia.jornadas.flatMap((j) => j.pausas.map((p) => `${marca(p.inicio)}–${p.fin ? marca(p.fin) : '…'}`)).join('  ');
    const obs = [dia.festivo && `Festivo: ${dia.festivo}`, dia.ausencia && `Ausencia: ${dia.ausencia}`, ...dia.incidencias].filter(Boolean).join('. ');
    const celdas = [
      `${DIAS[dia.diaSemana]} ${dia.fecha.slice(8)}`, tramos, pausas,
      dia.pausaMs ? hhmm(dia.pausaMs) : '', dia.jornadas.length ? hhmm(dia.trabajadoMs) : '', obs,
    ];
    const alto = Math.max(13, ...celdas.map((t, i) => doc.heightOfString(t || ' ', { width: cols[i].w - 6 }) + 5));
    if (y + alto > doc.page.height - 150) { doc.addPage(); y = 36; cabecera(); }
    if (dia.diaSemana === 0 || dia.diaSemana === 6 || dia.festivo) doc.rect(X, y, ANCHO, alto).fill('#f6f7f9').fillColor('#000');
    let x = X;
    celdas.forEach((t, i) => { doc.text(t, x + 3, y + 3, { width: cols[i].w - 6 }); x += cols[i].w; });
    doc.moveTo(X, y + alto).lineTo(X + ANCHO, y + alto).strokeColor('#d5d9df').lineWidth(0.5).stroke();
    y += alto;
  }

  // ---- Totales ----
  const t = d.totales;
  y += 8;
  doc.font('Helvetica-Bold').fontSize(9).text(
    `Total trabajado: ${hhmm(t.trabajadoMs)} h     Pausas: ${hhmm(t.pausaMs)} h     Previsto (orientativo): ${hhmm(t.previstoMs)} h     Saldo: ${hhmm(t.saldoMs)} h`,
    X, y, { width: ANCHO });
  doc.font('Helvetica').fontSize(7.5).fillColor('#444');
  doc.text('* fichaje añadido manualmente (corrección con autor y motivo)    ° fichaje hecho sin conexión y sincronizado después', X, doc.y + 4, { width: ANCHO });
  if (d.correcciones.length) {
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(8).text('Correcciones del periodo', X, doc.y + 6);
    doc.font('Helvetica').fontSize(7.5);
    for (const c of d.correcciones) doc.text(`· ${c}`, X, doc.y + 1, { width: ANCHO });
  }

  // ---- Firmas y huella ----
  if (doc.y > doc.page.height - 135) doc.addPage();
  const yf = doc.page.height - 125;
  doc.fillColor('#000').fontSize(8);
  doc.text('Firma del trabajador/a', X, yf).text('Firma de la empresa', X + ANCHO / 2 + 10, yf);
  doc.moveTo(X, yf + 42).lineTo(X + ANCHO / 2 - 20, yf + 42).moveTo(X + ANCHO / 2 + 10, yf + 42).lineTo(X + ANCHO, yf + 42).strokeColor('#000').stroke();

  const emitido = ahoraISO();
  const huellaDatos = crypto.createHash('sha256').update(JSON.stringify([u.id, mes, d.dias, d.correcciones])).digest('hex');
  doc.fontSize(6.5).fillColor('#555').text(
    `Emitido el ${localStr(emitido)} por ${emitidoPor}. Huella de este informe (SHA-256): ${huellaDatos}\n` +
    `Huella del registro completo en el momento de emitir: ${ultimoHash()}\n` +
    'Los fichajes se guardan en un registro que solo admite añadidos, encadenado por huellas; ninguna corrección borra el dato original.',
    X, yf + 50, { width: ANCHO });
  doc.end();
}
