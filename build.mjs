#!/usr/bin/env node
/* ============================================================================
 * build.mjs — refresh the FIFA World Cup 2026 dashboard from football-data.org
 * ----------------------------------------------------------------------------
 * What it does, once per run:
 *   1. Fetches the latest World Cup match results from football-data.org.
 *   2. Overlays them onto the fixed knockout bracket (winners advance).
 *   3. Writes a compact results patch into index.html (inside <script id="wc-data">).
 * The dashboard's own JavaScript then fills the bracket, updates every team's
 * status, and recomputes the win / champion probabilities in the browser.
 *
 * Requirements: Node 20+ (uses the built-in global fetch).
 * Env vars:
 *   FOOTBALL_DATA_TOKEN   your free football-data.org API key   (required)
 *   WC_COMPETITION        competition code (default "WC")
 *   WC_HTML               path to the dashboard file (default "index.html")
 * Usage:
 *   node build.mjs              # updates index.html in place
 *   node build.mjs --dry-run    # prints what it would change, writes nothing
 * ==========================================================================*/
import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMP  = process.env.WC_COMPETITION || "WC";
const FILE  = process.env.WC_HTML || "index.html";
const DRY   = process.argv.includes("--dry-run");

/* ---- 1. If these ever mismatch, fix them after the first --dry-run --------
 * TEAM_ALIAS: only list football-data 3-letter codes that DIFFER from ours.
 * STAGE_MAP : football-data stage names -> our stage keys.                  */
const TEAM_ALIAS = {
  // "NLD":"NED", "KVX":"KOS", "GER":"GER"   // add real mismatches here
};
const STAGE_MAP = {
  LAST_32:"R32", LAST_16:"R16", QUARTER_FINALS:"QF",
  SEMI_FINALS:"SF", THIRD_PLACE:"3RD", FINAL:"FINAL"
};

/* ---- 2. Fixed knockout bracket skeleton -----------------------------------
 * R32 pairings are fixed (set when the groups finished); later rounds link to
 * their feeder matches so winners can be propagated forward. Keep in sync with
 * the dashboard's own match list if the draw ever changes.                  */
const SKELETON = [
  {id:"r32a",st:"R32",a:"CAN",b:"RSA"},{id:"r32b",st:"R32",a:"BRA",b:"JPN"},
  {id:"r32c",st:"R32",a:"GER",b:"PAR"},{id:"r32d",st:"R32",a:"NED",b:"MAR"},
  {id:"r32e",st:"R32",a:"CIV",b:"NOR"},{id:"r32f",st:"R32",a:"FRA",b:"SWE"},
  {id:"r32g",st:"R32",a:"MEX",b:"ECU"},{id:"r32h",st:"R32",a:"ENG",b:"COD"},
  {id:"r32i",st:"R32",a:"BEL",b:"SEN"},{id:"r32j",st:"R32",a:"USA",b:"BIH"},
  {id:"r32k",st:"R32",a:"ESP",b:"AUT"},{id:"r32l",st:"R32",a:"POR",b:"CRO"},
  {id:"r32m",st:"R32",a:"SUI",b:"ALG"},{id:"r32n",st:"R32",a:"AUS",b:"EGY"},
  {id:"r32o",st:"R32",a:"ARG",b:"CPV"},{id:"r32p",st:"R32",a:"COL",b:"GHA"},
  {id:"r16_89",st:"R16",feed:["r32c","r32f"]}, // Paraguay/Germany slot vs France/Sweden slot -> per official bracket
  {id:"r16_90",st:"R16",feed:["r32a","r32d"]},
  {id:"r16_91",st:"R16",feed:["r32b","r32e"]},
  {id:"r16_92",st:"R16",feed:["r32g","r32h"]},
  {id:"r16_93",st:"R16",feed:["r32l","r32k"]},
  {id:"r16_94",st:"R16",feed:["r32j","r32i"]},
  {id:"r16_95",st:"R16",feed:["r32o","r32n"]},
  {id:"r16_96",st:"R16",feed:["r32m","r32p"]},
  {id:"qf1",st:"QF",feed:["r16_89","r16_90"]},
  {id:"qf2",st:"QF",feed:["r16_93","r16_94"]},
  {id:"qf3",st:"QF",feed:["r16_91","r16_92"]},
  {id:"qf4",st:"QF",feed:["r16_95","r16_96"]},
  {id:"sf1",st:"SF",feed:["qf1","qf2"]},
  {id:"sf2",st:"SF",feed:["qf3","qf4"]},
  {id:"final",st:"FINAL",feed:["sf1","sf2"]}
];

const ourCode = tla => tla ? (TEAM_ALIAS[tla] || tla) : null;
const pairKey  = (a,b) => [a,b].sort().join("|");
const isoMinute = s => s ? (s.slice(0,16) + "Z") : undefined;
const winnerOf = m => { if(m.status!=="FT"||!m.sc) return null; let aw=m.sc[0]>m.sc[1]; if(m.pens) aw=m.pens[0]>m.pens[1]; return aw?m.a:m.b; };

async function fetchApiMatches(){
  if(!TOKEN) throw new Error("FOOTBALL_DATA_TOKEN is not set");
  const res = await fetch(`https://api.football-data.org/v4/competitions/${COMP}/matches`,
    { headers:{ "X-Auth-Token": TOKEN } });
  if(!res.ok) throw new Error(`football-data API ${res.status} ${res.statusText}`);
  const json = await res.json();
  return json.matches || [];
}

function indexByPair(apiMatches){
  const byPair = {}, seenStages = new Set(), unknown = [];
  for(const am of apiMatches){
    if(am.stage) seenStages.add(am.stage);
    const a = ourCode(am.homeTeam && am.homeTeam.tla);
    const b = ourCode(am.awayTeam && am.awayTeam.tla);
    if(!a || !b){ continue; }
    byPair[pairKey(a,b)] = am;
  }
  return { byPair, seenStages, unknown };
}

function apiResult(am){
  const ft = am.score && am.score.fullTime || {};
  const pen = am.score && am.score.penalties;
  return {
    finished: am.status === "FINISHED",
    live: am.status === "IN_PLAY" || am.status === "PAUSED",
    home: ft.home, away: ft.away,
    pens: pen && pen.home != null ? [pen.home, pen.away] : null,
    utc: isoMinute(am.utcDate), homeCode: ourCode(am.homeTeam && am.homeTeam.tla)
  };
}

function mergeBracket(byPair){
  const M = SKELETON.map(m => ({ ...m }));
  const byId = Object.fromEntries(M.map(m => [m.id, m]));
  for(let pass = 0; pass < 8; pass++){
    for(const m of M){
      if(m.feed){
        if(!m.a && byId[m.feed[0]]) m.a = winnerOf(byId[m.feed[0]]) || m.a;
        if(!m.b && byId[m.feed[1]]) m.b = winnerOf(byId[m.feed[1]]) || m.b;
      }
      if(m.a && m.b){
        const am = byPair[pairKey(m.a, m.b)];
        if(am){
          const r = apiResult(am);
          if(r.utc) m.koUTC = r.utc;
          const homeIsA = r.homeCode === m.a;
          if(r.finished && r.home != null && r.away != null){
            m.status = "FT";
            m.sc = homeIsA ? [r.home, r.away] : [r.away, r.home];
            if(r.pens) m.pens = homeIsA ? [r.pens[0], r.pens[1]] : [r.pens[1], r.pens[0]];
            m.src = ["footballdata"];
          } else if(r.live){
            m.status = "LIVE";
            if(r.home != null) m.sc = homeIsA ? [r.home, r.away] : [r.away, r.home];
            m.src = ["footballdata"];
          }
        }
      }
    }
  }
  return M;
}

function toResultsPatch(M){
  // compact patch keyed by id: only the fields the dashboard needs to overlay
  return M.map(m => {
    const p = { id: m.id };
    if(m.a) p.a = m.a; if(m.b) p.b = m.b;
    if(m.status && m.status !== "SCHED") p.status = m.status;
    if(m.sc) p.sc = m.sc; if(m.pens) p.pens = m.pens;
    if(m.koUTC) p.koUTC = m.koUTC; if(m.src) p.src = m.src;
    return p;
  }).filter(p => p.a || p.b || p.status || p.sc);
}

function nowIso(){ return new Date().toISOString().slice(0,16) + "Z"; }

async function main(){
  let patch = [], api = [];
  try{
    api = await fetchApiMatches();
    const { byPair, seenStages } = indexByPair(api);
    const merged = mergeBracket(byPair);
    patch = toResultsPatch(merged);
    console.log(`Fetched ${api.length} matches. Stages seen: ${[...seenStages].join(", ") || "(none)"}`);
    const finished = patch.filter(p => p.status === "FT").length;
    console.log(`Mapped ${patch.length} bracket matches (${finished} finished).`);
  }catch(err){
    console.error("Data fetch/merge failed:", err.message);
    console.error("Leaving the dashboard on its last-good data (no change).");
    process.exitCode = 0; // don't fail the whole workflow — keep the site live
    if(!DRY) return;
  }

  const payload = {
    results: patch,
    updatedAt: nowIso(),
    sources: { footballdata: nowIso() }
  };
  const json = JSON.stringify(payload);

  if(DRY){
    console.log("\n--- DRY RUN: payload that would be injected ---");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const html = await readFile(FILE, "utf8");
  const re = /(<script id="wc-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  if(!re.test(html)){
    throw new Error(`Could not find <script id="wc-data"> in ${FILE}. Is it the dashboard file?`);
  }
  const out = html.replace(re, `$1${json}$3`);
  if(out === html){ console.log("No change — index.html already current."); return; }
  await writeFile(FILE, out);
  console.log(`Updated ${FILE} at ${payload.updatedAt}.`);
}

const isEntry = process.argv[1] && process.argv[1].endsWith("build.mjs");
if(isEntry) main().catch(err => { console.error(err); process.exit(1); });

export { SKELETON, indexByPair, mergeBracket, toResultsPatch, ourCode, winnerOf, apiResult };
