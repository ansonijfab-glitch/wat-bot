import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { DateTime } from 'luxon';



const app = express();
app.use(bodyParser.json());

// ====== WHATSAPP (Cloud API) ======
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

// Enviar texto por WhatsApp
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    text: { body: String(body || '').slice(0, 4096) },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error('❌ WA send error:', r.status, txt);
    throw new Error('wa_send_error');
  }
  return r.json();
}

// ====== VERIFICACIÓN DEL WEBHOOK (GET /whatsapp) ======
app.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== MENSAJES ENTRANTES (POST /whatsapp) ======
app.post('/whatsapp', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200); // ignorar si no hay mensaje

    const from = msg.from; // número del remitente
    let userText = '';

    if (msg.type === 'text') {
      userText = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      userText =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.button_reply?.id ||
        msg.interactive?.list_reply?.id || '';
    } else {
      userText = '📎 Recibí tu mensaje. ¿Cómo quieres continuar?';
    }

    // Pasamos el texto a tu endpoint /chat
    let botReply = 'Ups, no pude procesar tu mensaje.';
    try {
      const r = await fetch('http://localhost:3000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userText }),
      });
      const data = await r.json();
      botReply = data?.reply || botReply;
    } catch (e) {
      console.error('❌ Error llamando /chat:', e);
    }

    await sendWhatsAppText(from, botReply);
    return res.sendStatus(200);
  } catch (e) {
    console.error('❌ Webhook error:', e);
    return res.sendStatus(500);
  }
});




// ====== CONFIG ======
const ZONE = 'America/Bogota';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar'] });
const calendar = google.calendar({ version: 'v3', auth });

// ====== PROMPT MAESTRO (Pega aquí tu versión final ya ajustada) ======
const systemPrompt = `

Eres Sana, el asistente virtual de la consulta de mastología del Dr. Juan Felipe Arias.
Tu misión es recibir pacientes, registrar sus datos, validar información clínica básica y solicitar acciones de disponibilidad/agendamiento a través de integraciones (Make + Google Sheets/Calendar) devolviendo únicamente bloques JSON cuando corresponda.

🎯 Objetivos

Saludar,pedir el nombre  y presentarte.



Identificar motivo de consulta:

Primera vez

Control presencial

Control de resultados virtuales

Biopsia guiada por ecografía

Programación de cirugía → transferir a humano (Isa/Deivis)

Actualización de órdenes → transferir a humano (Isa/Deivis)

Verificar seguro médico: Sudamericana, Colsanitas, Medplus, Bolívar, Allianz, Colmédica, Coomeva o particular. No atendemos EPS.

Solicitar imágenes y BIRADS si aplica:

BIRADS 4 o 5 → priorizar ≤ 3 días hábiles; si no hay cupo, transferir a humano.

BIRADS 3 → ≤ 7 días hábiles.

BIRADS 1 o 2 → mensaje tranquilizador.

Sin estudios → preguntar síntomas de alarma (masa/nódulo < 3 meses). Si sí → ≤ 3 días hábiles.

Órdenes vencidas → transferir a humano.

🧾 Registro de paciente

Para toda cita: Nombre completo, cédula y entidad de salud (obligatorio antes de confirmar).

Para Primera vez (obligatorio además): Fecha de nacimiento, tipo de sangre, estado civil, ciudad, dirección, correo, celular, estudios previos (si tuvo, cuándo y dónde).

No confirmes cita hasta tener todos los datos obligatorios.

🗓️ Agenda y reglas (estrictas)

Lugar: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.

Duraciones:

Primera vez: 20 min

Control presencial: 15 min

Control virtual: 10 min

Biopsia: 30 min

Ventanas por día/tipo:

Lunes (presencial): 08:00–11:30 y 14:00–17:30

Martes: sin consulta (cualquier intento → rechazar)

Miércoles/Jueves (presencial): 14:00–16:30

Viernes:

Presencial: 08:00–11:30

Virtual: 14:00–17:30 (solo controles virtuales)

Nunca agendes fuera de estas ventanas.

Nunca propongas martes.

Nunca propongas fechas pasadas.

No agendar más allá de 15 días (si el paciente pide más lejos, ofrece rango válido o transfiere a humano).

✅ Confirmación y recordatorios

No declares “cita confirmada” en texto.

Debes emitir el bloque JSON para crear la cita y esperar la confirmación del sistema (el backend responderá).

Siempre dar resumen (cuando el sistema confirme): fecha, hora, duración, lugar.

Recordatorios: llegar 15 min antes; traer mamografías, ecografías, resonancias, biopsias, informes quirúrgicos; prohibido grabar sin autorización (Ley 1581/2012).

💬 Estilo de conversación

Dirígete por el nombre del paciente.

Sin emojis.

Claro, breve, sin desvíos: si falta un dato obligatorio, insiste con cortesía.

Si no hay citas disponibles dentro de las reglas → transferir a humano.

💵 Costos (solo si preguntan)

Consulta de mastología: 350.000 COP

Biopsia guiada por ecografía (particular): 800.000 COP (incluye patología, no lectura)

🔌 Integraciones y acciones (JSON Only)

Siempre que necesites guardar datos o pedir disponibilidad/agendar, devuelve exclusivamente un bloque JSON válido (sin texto antes o después).
Si necesitas hacer dos acciones (por ejemplo, guardar y luego crear cita), envía cada bloque en mensajes separados, en este orden: primero guardar_paciente, luego crear_cita.

1) Guardar paciente (Google Sheets)
{
  "action": "guardar_paciente",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "fecha_nacimiento": "1985-06-20",
    "tipo_sangre": "O+",
    "estado_civil": "Casada",
    "ciudad": "Barranquilla",
    "direccion": "Cra 45 #23-10",
    "correo": "ana@mail.com",
    "celular": "3101234567",
    "entidad_salud": "Colsanitas",
    "estudios_previos": "Sí",
    "fecha_estudio": "2024-02-10",
    "lugar_estudio": "Clínica Portoazul"
  }
}

2) Consultar disponibilidad de un día (usa siempre YYYY-MM-DD)

Cuando el paciente pida “horarios” para una fecha concreta:

{
  "action": "consultar_disponibilidad",
  "data": {
    "tipo": "Control presencial",
    "fecha": "2025-10-06"
  }
}

3) Consultar días con cupo (rango)

Si el paciente pide “qué días tienes libres” o no da fecha:

{
  "action": "consultar_disponibilidad_rango",
  "data": {
    "tipo": "Control presencial",
    "desde": "2025-10-01",
    "dias": 14
  }
}

4) Crear cita (Google Calendar) — solo futura y dentro de ventanas

Cuando el paciente elija un horario devuelto por disponibilidad:

{
  "action": "crear_cita",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "entidad_salud": "Colsanitas",
    "tipo": "Control presencial",
    "inicio": "2025-10-06T08:00:00-05:00",
    "fin": "2025-10-06T08:15:00-05:00"
  }
}


Reglas para acciones:

No generes horas inventadas: primero consulta disponibilidad (día o rango) y ofrece solo lo que devuelva el sistema.

No devuelvas martes ni horarios fuera de ventana.

No devuelvas fechas en pasado.

No confirmes en texto: deja que el sistema confirme y luego resume.

🧭 Flujo recomendado

Identifica motivo y seguro (sin EPS).

Pide BIRADS / síntomas de alarma según reglas.

Si faltan datos obligatorios, pídelos (para Primera vez: todos los de la lista).

Disponibilidad:

No envíes {"action":"consultar_disponibilidad_rango"} a menos que el usuario lo solicite explícitamente. Si el usuario elige un día concreto, usa sólo consultar_disponibilidad (un día).

Si el paciente dice “¿qué horarios?” sin fecha → envía consultar_disponibilidad_rango (desde hoy, 14 días).

Si da fecha → envía consultar_disponibilidad.

Tras elegir hora, si es primera vez: primero guardar_paciente, luego crear_cita.
Para control presencial/virtual: si faltan nombre/cedula/entidad, pídelos; si ya están, crear_cita.

Cuando el sistema confirme, entrega resumen (fecha, hora, duración, lugar) + recordatorios/legales.

🧱 Reglas duras (no romper)

No martes, no fuera de ventana, no pasado, no >15 días.

No confirmar sin que el sistema responda.

No mezclar texto y JSON en el mismo mensaje.

Si el sistema indica “ocupado” o “fuera de horario”, no contradigas: propone alternativas pidiendo disponibilidad de nuevo.

`;

// ====== Memoria simple de la conversión ======
let history = [{ role: 'system', content: systemPrompt }];
let lastSystemNote = null; // para “recordarle” a Sana lo último que pasó (ocupado, fuera de horario, etc.)

// ====== HELPERS ======
const norm = (s = '') =>
  String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function duracionPorTipo(tipo = '') {
  const t = norm(tipo);
  if (t.includes('primera')) return 20;
  if (t.includes('control presencial')) return 15;
  if (t.includes('control virtual')) return 10;
  if (t.includes('biopsia')) return 30;
  return 15;
}

// Reglas más recientes que nos diste:
function ventanasPorDia(date, tipo = '') {
  // date = Luxon DateTime (zona ya set)
  const dow = date.weekday; // 1=Lun ... 7=Dom
  const t = norm(tipo);
  const v = [];
  const H = (h, m = 0) => date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const push = (start, end) => { if (end > start) v.push({ start, end }); };

  if (dow === 2) return v; // Martes: NO consulta

  if (dow === 1) { // Lunes
    if (t.includes('control virtual')) return v; // virtual sólo viernes
    push(H(8, 0), H(11, 30));
    push(H(14, 0), H(17, 30));
    return v;
  }

  if (dow === 3 || dow === 4) { // Miércoles/Jueves (presencial tarde)
    if (t.includes('control virtual')) return v;
    push(H(14, 0), H(16, 30));
    return v;
  }

  if (dow === 5) { // Viernes
    if (t.includes('control virtual')) {
      // Virtual sólo viernes tarde
      push(H(14, 0), H(17, 30));
    } else {
      // Presencial viernes mañana
      push(H(8, 0), H(11, 30));
    }
    return v;
  }

  return v; // Sábado/Domingo: vacío
}

function generarSlots(dateISO, tipo, maxSlots = 100) {
  const date = DateTime.fromISO(dateISO, { zone: ZONE });
  const ventanas = ventanasPorDia(date, tipo);
  const dur = duracionPorTipo(tipo);
  const slots = [];

  for (const win of ventanas) {
    let cursor = win.start;
    while (cursor.plus({ minutes: dur }) <= win.end) {
      const fin = cursor.plus({ minutes: dur });
      slots.push({
        inicio: cursor.toISO({ suppressMilliseconds: true }),
        fin: fin.toISO({ suppressMilliseconds: true }),
      });
      cursor = fin;
      if (slots.length >= maxSlots) break;
    }
    if (slots.length >= maxSlots) break;
  }
  return { dur, ventanas, slots };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function consultarBusy(ventanas) {
  if (!ventanas.length) return [];
  const timeMin = ventanas[0].start.toUTC().toISO();
  const timeMax = ventanas[ventanas.length - 1].end.toUTC().toISO();

  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: CALENDAR_ID }],
      timeZone: ZONE,
    },
  });

  const cal = resp.data.calendars?.[CALENDAR_ID];
  const busy = (cal?.busy || []).map(b => ({
    start: DateTime.fromISO(b.start, { zone: ZONE }),
    end: DateTime.fromISO(b.end, { zone: ZONE }),
  }));
  return busy;
}

function filtrarSlotsLibres(slots, busy) {
  if (!busy.length) return slots;
  return slots.filter(s => {
    const s1 = DateTime.fromISO(s.inicio, { zone: ZONE });
    const s2 = DateTime.fromISO(s.fin, { zone: ZONE });
    return !busy.some(b => overlaps(s1, s2, b.start, b.end));
  });
}

function slotDentroDeVentanas(startISO, endISO, tipo) {
  const s = DateTime.fromISO(startISO, { zone: ZONE });
  const e = DateTime.fromISO(endISO, { zone: ZONE });
  const ventanas = ventanasPorDia(s, tipo);
  if (!ventanas.length) return false;
  return ventanas.some(w => s >= w.start && e <= w.end);
}

function coerceFutureISODate(dateStr) {
  // Empuja el año hacia futuro si viene pasado (evita 2023 etc.)
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return DateTime.now().setZone(ZONE).toISODate();
  const today = DateTime.now().setZone(ZONE).startOf('day');
  while (d < today) d = d.plus({ years: 1 });
  return d.toISODate();
}

function coerceFutureISODateOrToday(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return DateTime.now().setZone(ZONE).toISODate();
  const today = DateTime.now().setZone(ZONE).startOf('day');
  if (d < today) return today.toISODate();
  return d.toISODate();
}

async function disponibilidadPorDias({ tipo, desdeISO, dias = 14, maxSlotsPorDia = 6 }) {
  // cap de negocio / performance
  if (dias > 15) dias = 15;
  if (dias > 10) dias = 10;

  console.time(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  const start = DateTime.fromISO(desdeISO, { zone: ZONE });

  // Prepara la lista de días a consultar
  const diasLista = [];
  for (let i = 0; i < dias; i++) diasLista.push(start.plus({ days: i }));

  const CONCURRENCY = 3; // 3 consultas a la vez (ajustable)
  const out = [];
  let idx = 0;

  async function worker(workerId) {
    while (true) {
      let d;
      // sección crítica
      if (idx < diasLista.length) {
        d = diasLista[idx];
        idx += 1;
      } else {
        break;
      }

      try {
        const dISO = d.toISODate();
        // Genera ventanas y slots del día
        const { dur, ventanas, slots } = generarSlots(dISO, tipo, 200);
        if (!ventanas.length) {
          // Día sin consulta según reglas
          continue;
        }

        // FreeBusy para ese día y filtrado
        console.time(`fb:${dISO}`);
        const busy = await consultarBusy(ventanas);
        console.timeEnd(`fb:${dISO}`);

        const libres = filtrarSlotsLibres(slots, busy);
        if (libres.length > 0) {
          out.push({
            fecha: dISO,
            duracion_min: dur,
            total: libres.length,
            ejemplos: libres.slice(0, maxSlotsPorDia).map(s =>
              DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm')
            ),
            slots: libres.slice(0, maxSlotsPorDia),
          });
        }
      } catch (e) {
        console.error('⚠️ Error consultando día:', e);
      }
    }
  }

  // Lanza N workers en paralelo
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  // Ordena por fecha por si llegaron desordenados
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));

  console.timeEnd(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  return out;
}


async function alternativasCercanas({ tipo, desdeISO, dias = 10, limite = 6 }) {
  const lista = await disponibilidadPorDias({ tipo, desdeISO, dias, maxSlotsPorDia: limite });
  const planos = [];
  for (const d of lista) {
    for (const s of d.slots) {
      planos.push({ fecha: d.fecha, inicio: s.inicio, fin: s.fin, duracion_min: d.duracion_min });
      if (planos.length >= limite) break;
    }
    if (planos.length >= limite) break;
  }
  return planos;
}

// ====== MAKE WEBHOOK ======
async function postToMake(json) {
  try {
    const r = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    return await r.json();
  } catch (e) {
    console.error('❌ Error Make:', e);
    return { ok: false, error: 'make_error' };
  }
}

// ====== PARSER DE ACCIONES DEVUELTAS POR LA IA (con o sin ```json) ======
function extractActionJSONBlocks(text = '') {
  const out = [];

  // 1) Fenced ```json ... ```
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
  for (const m of fenced) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj === 'object' && obj.action) out.push(obj);
    } catch { /* ignore */ }
  }

  // 2) Fallback: buscar objetos con "action"
  if (out.length === 0) {
    const rawMatches = text.match(/{[\s\S]{0,2000}?"action"\s*:\s*".+?"[\s\S]{0,2000}?}/g);
    if (rawMatches) {
      for (const raw of rawMatches) {
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === 'object' && obj.action) out.push(obj);
        } catch { /* ignore */ }
      }
    }
  }

  return out;
}

// ====== EJECUTOR DE ACCIONES ======
async function maybeHandleAssistantAction(text) {
  const payloads = extractActionJSONBlocks(text);
  if (!payloads.length) return null;

  const results = [];
  const now = DateTime.now().setZone(ZONE);

  for (const payload of payloads) {
    const action = norm(payload.action);

    // ---- DISPONIBILIDAD (un día) ----
    if (action === 'consultar_disponibilidad') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { fecha } = payload.data || {};
      if (fecha) fecha = coerceFutureISODate(fecha);

      const { dur, ventanas, slots } = generarSlots(fecha, tipo, 60);
      if (!ventanas.length) {
        results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: [], note: 'Día sin consulta según reglas' });
        continue;
      }
      const busy = await consultarBusy(ventanas);
      const libres = filtrarSlotsLibres(slots, busy).slice(0, 12);
      results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
      continue;
    }

    // ---- DISPONIBILIDAD (rango de días) ----
    if (action === 'consultar_disponibilidad_rango') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { desde, dias = 14 } = payload.data || {};
      const desdeFixed = desde ? coerceFutureISODateOrToday(desde) : now.toISODate();
      if (dias > 15) dias = 15; // cap de negocio
      const lista = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });
      results.push({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: lista });
      continue;
    }

    // ---- CREAR CITA ----
    if (action === 'crear_cita') {
      const d = payload.data || {};
      const s = DateTime.fromISO(d.inicio, { zone: ZONE });
      const e = DateTime.fromISO(d.fin, { zone: ZONE });

      // Validación básica
      if (!s.isValid || !e.isValid || s >= e) {
        results.push({ ok: false, error: 'fecha_invalida', message: 'Fecha/hora inválida.' });
        lastSystemNote = 'El último intento falló: fecha/hora inválida.';
        continue;
      }

      // Futuro y dentro de 15 días
      const maxDay = now.plus({ days: 15 }).endOf('day');
      if (s < now) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: now.toISODate(), dias: 10, limite: 6 });
        results.push({ ok: false, error: 'fecha_pasada', message: 'La hora elegida ya pasó. Elige una fecha futura.', alternativas: alt });
        lastSystemNote = 'Falló por fecha pasada. Se propusieron alternativas.';
        continue;
      }
      if (s > maxDay) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: now.toISODate(), dias: 15, limite: 6 });
        results.push({ ok: false, error: 'fuera_rango', message: 'No agendamos más allá de 15 días.', alternativas: alt });
        lastSystemNote = 'Falló por más de 15 días. Se propusieron alternativas.';
        continue;
      }

      // Dentro de ventanas y no martes
      if (!slotDentroDeVentanas(d.inicio, d.fin, d.tipo)) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: s.toISODate(), dias: 10, limite: 6 });
        results.push({
          ok: false,
          error: 'fuera_horario',
          message: 'Ese día/horario no es válido según las reglas (martes sin consulta u hora fuera de rango).',
          alternativas: alt
        });
        lastSystemNote = 'Falló por fuera de horario. Se propusieron alternativas.';
        continue;
      }

      // Chequear ocupado con FreeBusy
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: s.toUTC().toISO(),
          timeMax: e.toUTC().toISO(),
          items: [{ id: CALENDAR_ID }],
          timeZone: ZONE,
        },
      });
      const cal = fb.data.calendars?.[CALENDAR_ID];
      const busy = (cal?.busy || []).map(b => ({
        start: DateTime.fromISO(b.start, { zone: ZONE }),
        end: DateTime.fromISO(b.end, { zone: ZONE }),
      }));
      const solapa = busy.some(b => overlaps(s, e, b.start, b.end));
      if (solapa) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: s.toISODate(), dias: 10, limite: 6 });
        results.push({ ok: false, error: 'slot_ocupado', message: 'Ese horario ya está reservado. Elige otra opción.', alternativas: alt });
        lastSystemNote = 'Falló por slot ocupado. Se propusieron alternativas.';
        continue;
      }

      // OK → delega creación a Make
      const resp = await postToMake(payload);
      results.push(resp);
      if (resp?.ok !== true) {
        lastSystemNote = 'No se pudo crear la cita en Make. Reintenta u ofrece alternativas.';
      } else {
        lastSystemNote = 'La última cita fue creada correctamente en el calendario.';
      }
      continue;
    }

    // ---- GUARDAR PACIENTE ----
    if (action === 'guardar_paciente') {
      const resp = await postToMake(payload);
      results.push(resp);
      continue;
    }
  }

  if (results.length === 1) return { handled: true, makeResponse: results[0] };
  return { handled: true, makeResponse: results };
}

// ====== ENDPOINTS ======
app.post('/chat', async (req, res) => {
  const userMsg = String(req.body.message || '').trim();

  // Reset opcional (para tu CLI :reset)
  if (userMsg === '__RESET__') {
    history = [{ role: 'system', content: systemPrompt }];
    lastSystemNote = null;
    return res.json({ ok: true, reset: true });
  }

  // Nota de contexto (fija reglas temporales)
  const todayNote = `Hoy es ${DateTime.now().setZone(ZONE).toISODate()} (${ZONE}). Recuerda: Martes sin consulta; virtual sólo viernes tarde; no agendar más de 15 días; no usar fechas pasadas.`;
  history.push({ role: 'system', content: todayNote });
  if (lastSystemNote) {
    history.push({ role: 'system', content: lastSystemNote });
    lastSystemNote = null;
  }

  history.push({ role: 'user', content: userMsg });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: history,
    });

    let reply = completion.choices[0].message.content || '';
    const actionResult = await maybeHandleAssistantAction(reply);

    if (actionResult?.handled && actionResult.makeResponse) {
      const mr = actionResult.makeResponse;
      const many = Array.isArray(mr) ? mr : [mr];
      const errors = many.filter(x => x && x.ok === false);
      const daysResp = many.find(x => Array.isArray(x?.dias_disponibles));
      const daySlots = many.find(x => Array.isArray(x?.slots));

      if (errors.length) {
        // formateo de errores + alternativas
        let msg = errors.map(e => {
          let linea = `⚠️ ${e.message || 'No se pudo crear la cita.'}`;
          if (Array.isArray(e.alternativas) && e.alternativas.length) {
            const opts = e.alternativas.map((s, i) => {
              const h = DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('dd-LL HH:mm');
              return `${i + 1}) ${h}`;
            }).join(', ');
            linea += `\nOpciones: ${opts}`;
          }
          return linea;
        }).join('\n\n');
        reply = msg;
      } else if (daySlots) {
        if (!daySlots.slots.length) {
          reply = `Para ${daySlots.fecha} (${daySlots.tipo}) no hay cupos válidos (o está todo ocupado). ¿Quieres otra fecha?`;
        } else {
          const items = daySlots.slots.map((s, i) =>
            `${i + 1}) ${DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm')}`
          ).join(', ');
          reply = `Disponibilidad para ${daySlots.fecha} (${daySlots.tipo}, ${daySlots.duracion_min} min): ${items}. Elige un número.`;
        }
      } else if (daysResp) {
        if (!daysResp.dias_disponibles.length) {
          reply = `No tengo cupos en los próximos ${daysResp.dias} días para ${daysResp.tipo}. ¿Probamos otro rango?`;
        } else {
          const lineas = daysResp.dias_disponibles.map(d =>
            `- ${d.fecha} (${d.duracion_min} min): ${d.ejemplos.join(', ')}`
          ).join('\n');
          reply = `Días con cupo:\n${lineas}\n\n¿Quieres alguno de esos días/horas?`;
        }
      }

      history.push({ role: 'assistant', content: reply });
      return res.json({ reply, makeResponse: actionResult.makeResponse });
    }

    history.push({ role: 'assistant', content: reply });
    res.json({ reply, makeResponse: null });
  } catch (e) {
    console.error('OpenAI error:', e);
    res.status(500).json({ error: 'ai_error' });
  }
});

// Disponibilidad por día (forzando futuro para evitar 2023)
app.post('/availability', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { fecha } = req.body;
    if (!fecha) return res.status(400).json({ ok: false, error: 'falta_fecha' });

    fecha = coerceFutureISODate(fecha);
    const { dur, ventanas, slots } = generarSlots(fecha, tipo, 100);
    if (!ventanas.length) return res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: [] });

    const busy = await consultarBusy(ventanas);
    const libres = filtrarSlotsLibres(slots, busy).slice(0, 20);
    res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Días con cupo (forzando futuro; máximo 15 días)
app.post('/availability-range', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { desde, dias = 14 } = req.body;
    if (!desde) return res.status(400).json({ ok: false, error: 'falta_desde' });
    if (dias > 15) dias = 15;

    const desdeFixed = coerceFutureISODateOrToday(desde);
    const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });
    res.json({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: diasDisp });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ====== ARRANQUE DEL SERVIDOR ======
app.listen(3000, () => {
  console.log('🚀 Servidor en http://localhost:3000');
});
