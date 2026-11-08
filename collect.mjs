// Recolector de actividad de Albion Eye.
// Cada pocos minutos (GitHub Actions) lee las kills nuevas de los tres servidores y los
// jugadores conectados en Steam, y suma recuentos por hora (UTC). No guarda kills sueltas.
// También apunta las caídas de cada servidor (cuando dejan de llegar kills).
//
// Las tareas programadas de GitHub no son puntuales y la API a veces falla, así que no se
// cuentan "kills por hora" a secas: se guarda, por hora, cuántas kills se vieron y cuántos
// minutos de esa hora se cubrieron. Kills por minuto = kills / minutos, aunque falten trozos.
//
// Uso: node collect.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DATA = path.join(import.meta.dirname, "data");
const SERVERS = {
  europe: "https://gameinfo-ams.albiononline.com/api/gameinfo",
  americas: "https://gameinfo.albiononline.com/api/gameinfo",
  asia: "https://gameinfo-sgp.albiononline.com/api/gameinfo",
};
const STEAM = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=761890";

const PAGE = 51; // máximo de la API por petición
const MAX_PAGES = 20; // ~1000 kills: cubre retrasos de 40–50 minutos
const MAX_GAP = 20 * 60_000; // un hueco así entre dos kills seguidas = la API saltó a kills antiguas
const KEEP_DAYS = 120; // horas guardadas
// Caídas: la API publica las kills con ~5 min de retraso; si la última kill es de hace más de
// esto, el servidor está caído o en mantenimiento (hay decenas de kills por minuto siempre).
const DOWN_AFTER = 15 * 60_000;
const KEEP_OUTAGES = 60; // caídas guardadas por servidor

const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13); // "2026-11-07T11"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, file), "utf8"));
  } catch {
    return fallback;
  }
}
const writeJson = (file, value) => writeFile(path.join(DATA, file), JSON.stringify(value));

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "AlbionEye activity collector" } });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`sin respuesta: ${url}`);
}

// Tamaño de pelea, como en la web: 1 = solo, 2–5 = grupo pequeño, 6–19 = mediano, 20+ = ZvZ.
const sizeOf = (e) => {
  const n = Math.max(e.numberOfParticipants ?? 1, e.groupMemberCount ?? 1);
  return n <= 1 ? "solo" : n <= 5 ? "small" : n < 20 ? "medium" : "large";
};

// Reparte los minutos de un tramo [from, to] entre las horas que toca.
function addCoverage(hours, from, to) {
  for (let t = from; t < to; ) {
    const next = Math.min(to, (Math.floor(t / 3600_000) + 1) * 3600_000);
    const h = (hours[hourKey(t)] ??= { min: 0, solo: 0, small: 0, medium: 0, large: 0 });
    h.min = Math.round((h.min + (next - t) / 60_000) * 100) / 100;
    t = next;
  }
}

async function collectServer(server, base, state) {
  const st = (state[server] ??= { lastTime: 0 });
  const kills = [];
  let reached = false;
  for (let page = 0; page < MAX_PAGES && !reached; page++) {
    const list = await getJson(`${base}/events?limit=${PAGE}&offset=${page * PAGE}&_=${Date.now()}`);
    if (!Array.isArray(list) || list.length === 0) break;
    for (const e of list) {
      const time = Date.parse(e.TimeStamp);
      if (!Number.isFinite(time)) continue;
      // La API a veces salta a kills de hace horas en las últimas páginas: se corta ahí.
      const prev = kills.at(-1);
      if (prev && prev.time - time > MAX_GAP) {
        page = MAX_PAGES;
        break;
      }
      if (st.lastTime && time <= st.lastTime) reached = true;
      kills.push({ time, size: sizeOf(e) });
    }
    if (page < MAX_PAGES - 1 && !reached) await sleep(300);
  }
  if (kills.length === 0) return { server, kills: 0, minutes: 0 };

  const newest = Math.max(...kills.map((k) => k.time));
  const oldest = Math.min(...kills.map((k) => k.time));
  await trackOutage(server, newest, kills);
  // Tramo cubierto sin huecos: desde la última vez si se llegó a ella; si no, desde la kill
  // más antigua leída (lo de en medio se perdió y no cuenta).
  const from = reached ? st.lastTime : oldest;
  const hours = await readJson(`kills-${server}.json`, {});
  if (newest > from) addCoverage(hours, from, newest);
  let added = 0;
  for (const k of kills) {
    // Solo las posteriores a la última vez: así ninguna se cuenta dos veces.
    if (k.time <= from) continue;
    const h = (hours[hourKey(k.time)] ??= { min: 0, solo: 0, small: 0, medium: 0, large: 0 });
    h[k.size]++;
    added++;
  }
  prune(hours);
  await writeJson(`kills-${server}.json`, hours);
  st.lastTime = Math.max(st.lastTime, newest);
  return { server, kills: added, minutes: Math.round((newest - from) / 60_000), gap: !reached };
}

// Historial de caídas (data/outages.json): { servidor: [{ start, end }] }. Empieza en la
// última kill antes de la caída y termina en la primera kill de después (end: null = en curso).
async function trackOutage(server, newest, kills) {
  const all = await readJson("outages.json", {});
  const list = (all[server] ??= []);
  const open = list.at(-1)?.end === null ? list.at(-1) : null;
  const down = Date.now() - newest > DOWN_AFTER;
  if (down && !open) list.push({ start: new Date(newest).toISOString(), end: null });
  if (!down && open) {
    const start = Date.parse(open.start);
    const after = kills.map((k) => k.time).filter((t) => t > start);
    open.end = new Date(after.length ? Math.min(...after) : newest).toISOString();
  }
  all[server] = list.slice(-KEEP_OUTAGES);
  await writeJson("outages.json", all);
}

async function collectSteam(now) {
  const data = await getJson(STEAM);
  const players = data?.response?.player_count;
  if (!Number.isFinite(players)) throw new Error("Steam sin dato");
  // Por hora: suma y número de muestras, para sacar la media.
  const hours = await readJson("steam.json", {});
  const h = (hours[hourKey(now)] ??= { sum: 0, n: 0 });
  h.sum += players;
  h.n++;
  prune(hours);
  await writeJson("steam.json", hours);
  return players;
}

function prune(hours) {
  const limit = hourKey(Date.now() - KEEP_DAYS * 86400_000);
  for (const k of Object.keys(hours)) if (k < limit) delete hours[k];
}

await mkdir(DATA, { recursive: true });
const state = await readJson("state.json", {});
const now = Date.now();
let failures = 0;
for (const [server, base] of Object.entries(SERVERS)) {
  try {
    const r = await collectServer(server, base, state);
    console.log(`${server}: ${r.kills} kills nuevas, ${r.minutes} min cubiertos${r.gap ? " (con hueco)" : ""}`);
  } catch (e) {
    failures++;
    console.error(`${server}: ${e.message}`);
  }
}
try {
  console.log(`steam: ${await collectSteam(now)} conectados`);
} catch (e) {
  failures++;
  console.error(`steam: ${e.message}`);
}
state.updated = new Date(now).toISOString();
await writeJson("state.json", state);
// Solo falla la tarea si no ha salido nada (así GitHub avisa por correo).
if (failures === Object.keys(SERVERS).length + 1) process.exit(1);
