// cli.js
import 'dotenv/config';
import fetch from 'node-fetch';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

const BASE = process.env.CHAT_BASE_URL || 'http://localhost:3000';

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

function showMakeResponse(mr) {
  if (!mr) return;
  console.log('↩︎ makeResponse:');
  console.log(JSON.stringify(mr, null, 2));
}

// Estado en memoria (solo CLI)
let lastDispo = null; // { fecha, tipo, duracion_min, slots: [...] }

function fmtHora(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Bogota'
  });
}

async function main() {
  console.log('💬 CLI de Sana');
  console.log('Comandos:');
  console.log('  :dispo <YYYY-MM-DD> "<tipo>"     → horarios libres del día');
  console.log('     ej: :dispo 2025-10-06 "Control presencial"');
  console.log('  :dias  <YYYY-MM-DD> <N> "<tipo>" → días con cupo en N días desde la fecha');
  console.log('     ej: :dias  2025-10-06 10 "Control presencial"');
  console.log('  :elige <n> "<nombre>" <cedula> "<entidad>" "<tipo>" → agenda usando el slot n del último :dispo');
  console.log('     ej: :elige 1 "Ana Lopez" 12345678 "Colsanitas" "Control presencial"');
  console.log('  :reset                           → reinicia el historial de chat');
  console.log('  :exit                            → salir');
  console.log('Escribe tu mensaje para Sana (chat libre) o usa comandos…');

  const rl = readline.createInterface({ input, output, historySize: 200 });

  while (true) {
    const line = await new Promise((r) => rl.question('> ', r));
    if (!line) continue;
    const msg = line.trim();
    if (msg === ':exit') break;

    // Reset del historial de chat (simple)
    if (msg === ':reset') {
      await post('/chat', { message: '__RESET__' }); // opcional: si no lo manejas en backend, ignora
      lastDispo = null;
      console.log('✅ Historial reiniciado (CLI) y último :dispo limpiado.');
      continue;
    }

    // DISPONIBILIDAD DEL DÍA
    if (msg.startsWith(':dispo')) {
      const m = msg.match(/^:dispo\s+(\d{4}-\d{2}-\d{2})\s+(.*)$/);
      if (!m) {
        console.log('⚠️  Uso: :dispo <YYYY-MM-DD> "<tipo>"');
        continue;
      }
      const fecha = m[1];
      const tipo = m[2].trim().replace(/^"|"$/g, '');
      const r = await post('/availability', { fecha, tipo });
      if (!r.ok) { console.log('❌ Error:', r); continue; }

      if (!r.slots?.length) {
        console.log(`No hay horarios libres para ${fecha} (${tipo}).`);
        lastDispo = null;
      } else {
        console.log(`Disponibilidad para ${fecha} (${tipo}, ${r.duracion_min} min):`);
        r.slots.forEach((s, i) => console.log(`  ${i + 1}) ${fmtHora(s.inicio)}`));
        lastDispo = { fecha, tipo, duracion_min: r.duracion_min, slots: r.slots };
        console.log('Tip: usa :elige <n> "<nombre>" <cedula> "<entidad>" "<tipo>"');
      }
      continue;
    }

    // DIAS CON CUPO
    if (msg.startsWith(':dias')) {
      const m = msg.match(/^:dias\s+(\d{4}-\d{2}-\d{2})\s+(\d+)\s+(.*)$/);
      if (!m) {
        console.log('⚠️  Uso: :dias <YYYY-MM-DD> <N> "<tipo>"');
        continue;
      }
      const desde = m[1];
      const dias = Number(m[2]);
      const tipo = m[3].trim().replace(/^"|"$/g, '');
      const r = await post('/availability-range', { desde, dias, tipo });
      if (!r.ok) { console.log('❌ Error:', r); continue; }

      if (!r.dias_disponibles?.length) {
        console.log(`Sin cupos desde ${desde} por ${dias} días para ${tipo}.`);
      } else {
        console.log(`Días con cupo (${tipo}):`);
        r.dias_disponibles.forEach(d =>
          console.log(`  - ${d.fecha} (${d.duracion_min} min): ${d.ejemplos.join(', ')}`)
        );
        console.log('Tip: usa :dispo <fecha> "<tipo>" para ver horas y luego :elige.');
      }
      continue;
    }

    // ELIGE UN SLOT DEL ÚLTIMO :dispo Y PIDE AGENDARLO
    if (msg.startsWith(':elige')) {
      // :elige <n> "<nombre>" <cedula> "<entidad>" "<tipo>"
      const m = msg.match(/^:elige\s+(\d+)\s+"([^"]+)"\s+(\S+)\s+"([^"]+)"\s+"([^"]+)"$/);
      if (!m) {
        console.log('⚠️  Uso: :elige <n> "<nombre>" <cedula> "<entidad>" "<tipo>"');
        continue;
      }
      if (!lastDispo?.slots?.length) {
        console.log('⚠️  Primero usa :dispo para tener una lista de horarios.');
        continue;
      }
      const idx = Number(m[1]) - 1;
      const nombre = m[2];
      const cedula = m[3];
      const entidad = m[4];
      const tipo = m[5];
      if (idx < 0 || idx >= lastDispo.slots.length) {
        console.log('⚠️  Índice fuera de rango.');
        continue;
      }
      const slot = lastDispo.slots[idx];

      // Enviamos un mensaje a Sana para que genere el JSON (crear_cita)
      const texto = `Quiero agendar ${tipo} para ${nombre} (cédula ${cedula}, entidad ${entidad}) el ${lastDispo.fecha} a las ${fmtHora(slot.inicio)}.`;
      const r = await post('/chat', { message: texto });

      if (r.reply) console.log(`Sana: ${r.reply}`);
      if (r.makeResponse) showMakeResponse(r.makeResponse);
      continue;
    }

    // Chat normal con Sana
    const r = await post('/chat', { message: msg });
    if (r.reply) console.log(`Sana: ${r.reply}`);
    if (r.makeResponse) showMakeResponse(r.makeResponse);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('❌ CLI error:', e);
  process.exit(1);
});
