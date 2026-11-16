// Pickoff: Cloudflare Worker
// Serves the app in /public and the JSON API under /api/*.
// Data lives in the D1 database bound as DB. NFL schedule and scores come from ESPN's public scoreboard feed.
//
// Rules: pick the winner of every game (or a tie). Right winner = 1 point, wrong = 0,
// picked a tie and the game ties = 10 points. Each game's pick locks 24 hours before that
// game kicks off. Other players' picks stay hidden until that game is final, then they're revealed
// and the points count toward the standings right away.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_STATS = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam';
const POINTS_WIN = 1, POINTS_TIE = 10;
const DAY = 86400000;
const LOCK_BEFORE = 24 * 3600000;   // picks close this long before each kickoff

// ---------- season layout ----------
// Regular season weeks 1-18 (ESPN seasontype 2), then the playoffs (seasontype 3).
// ESPN playoff week 4 is the Pro Bowl, so it's skipped.
const POST_WEEKS = [[1, 'Wild Card'], [2, 'Divisional'], [3, 'Conference Champ.'], [5, 'Super Bowl']];
function seasonWeeks(season) {
  const out = [];
  for (let w = 1; w <= 18; w++) out.push({ key: `${season}-2-${w}`, season, stype: 2, week: w, label: `Week ${w}`, short: `W${w}`, idx: w });
  POST_WEEKS.forEach(([w, label], i) => out.push({ key: `${season}-3-${w}`, season, stype: 3, week: w, label, short: ['WC', 'DIV', 'CONF', 'SB'][i], idx: 19 + i }));
  return out;
}
function parseKey(key) {
  const m = /^(\d{4})-([23])-(\d{1,2})$/.exec(String(key || ''));
  if (!m) return null;
  const season = +m[1];
  return seasonWeeks(season).find(w => w.key === key) || null;
}

// ---------- helpers ----------
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const now = () => Date.now();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
function randomToken(bytes = 32) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }
function randomCode(len = 6) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return [...a].map(x => abc[x % abc.length]).join('');
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: hex(bits), salt: hex(salt) };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function body(req) { try { return await req.json(); } catch { return {}; } }
function cleanName(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); }

// ---------- database ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leagues (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL, season INTEGER NOT NULL, start_idx INTEGER NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (league_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined INTEGER NOT NULL, PRIMARY KEY (league_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS weeks (key TEXT PRIMARY KEY, season INTEGER, stype INTEGER, week INTEGER, first_kick INTEGER, last_kick INTEGER, all_final INTEGER DEFAULT 0, game_count INTEGER DEFAULT 0, fetched INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, week_key TEXT NOT NULL, kickoff INTEGER, state TEXT, completed INTEGER DEFAULT 0, detail TEXT, winner TEXT,
     home_id TEXT, home_abbr TEXT, home_name TEXT, home_logo TEXT, home_color TEXT, home_score INTEGER, home_record TEXT,
     away_id TEXT, away_abbr TEXT, away_name TEXT, away_logo TEXT, away_color TEXT, away_score INTEGER, away_record TEXT, updated INTEGER,
     home_ml TEXT, away_ml TEXT, odds_provider TEXT, home_spread TEXT, away_spread TEXT, over_under TEXT)`,
  `CREATE INDEX IF NOT EXISTS games_week ON games (week_key)`,
  `CREATE TABLE IF NOT EXISTS picks (user_id INTEGER NOT NULL, game_id TEXT NOT NULL, week_key TEXT NOT NULL, pick TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, game_id))`,
  `CREATE INDEX IF NOT EXISTS picks_week ON picks (week_key, user_id)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  // columns added after the first release
  try { await env.DB.prepare(`ALTER TABLE members ADD COLUMN carry INTEGER DEFAULT 0`).run(); } catch { /* already there */ }
  for (const col of ['home_ml TEXT', 'away_ml TEXT', 'odds_provider TEXT', 'home_spread TEXT', 'away_spread TEXT', 'over_under TEXT']) {
    try { await env.DB.prepare(`ALTER TABLE games ADD COLUMN ${col}`).run(); } catch { /* already there */ }
  }
  schemaReady = true;
}

// ---------- ESPN sync ----------
async function espn(env, path) {
  const r = await fetch((env.ESPN_BASE || ESPN) + path, { headers: { 'user-agent': 'Pickoff/1.0' }, cf: { cacheTtl: 30 } });
  if (!r.ok) throw new Error('ESPN ' + r.status);
  return r.json();
}

// Which week is "now", per ESPN. Cached for 20 minutes.
async function getCurrent(env, force = false) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k='current'`).first();
  const cached = row ? JSON.parse(row.v) : null;
  if (cached && !force && now() - cached.at < 20 * 60000) return cached;
  try {
    const d = await espn(env, '/scoreboard');
    let season = d.season?.year, stype = d.season?.type, week = d.week?.number;
    if (stype === 1 || !week) { stype = 2; week = 1; }             // preseason -> show Week 1
    if (stype === 4) { stype = 3; week = 5; }                       // offseason -> last season's Super Bowl
    if (stype === 3 && week === 4) week = 5;                        // Pro Bowl week -> Super Bowl
    const cur = { key: `${season}-${stype}-${week}`, season, at: now() };
    await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('current', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(JSON.stringify(cur)).run();
    return cur;
  } catch (e) {
    if (cached) return cached;
    const y = new Date().getUTCFullYear(), m = new Date().getUTCMonth();
    const season = m < 6 ? y - 1 : y;
    return { key: `${season}-2-1`, season, at: 0 };
  }
}

function parseEvent(ev, weekKey) {
  const c = ev.competitions?.[0] || {};
  const st = ev.status?.type || c.status?.type || {};
  const side = ha => {
    const t = (c.competitors || []).find(x => x.homeAway === ha) || {};
    const team = t.team || {};
    const rec = (t.records || []).find(r => r.type === 'total' || r.name === 'overall') || (t.records || [])[0];
    return {
      id: String(team.id || t.id || ''), abbr: team.abbreviation || 'TBD', name: team.displayName || team.name || 'TBD',
      logo: team.logo || team.logos?.[0]?.href || '', color: team.color || '', score: t.score === undefined || t.score === '' ? null : parseInt(t.score, 10),
      record: rec?.summary || '',
    };
  };
  const home = side('home'), away = side('away');
  // Moneyline from the sportsbook ESPN lists first (DraftKings at the moment). Shapes differ by season, so try a few.
  const o = (c.odds || [])[0] || {};
  const fmtML = v => {
    if (v === undefined || v === null || v === '') return null;
    const t = String(v).trim().toUpperCase();
    if (t === 'EVEN' || t === 'EV') return '+100';
    const n = parseInt(t.replace(/[^\d+-]/g, ''), 10);
    return isNaN(n) ? null : (n > 0 ? '+' + n : String(n));
  };
  const ml = ha => fmtML(o.moneyline?.[ha]?.close?.odds ?? o.moneyline?.[ha]?.current?.odds ?? o.moneyline?.[ha]?.open?.odds ?? o[ha + 'TeamOdds']?.moneyLine);
  home.ml = ml('home'); away.ml = ml('away');
  // Point spread (how many points a team is favored by) and the over/under total.
  const num = v => { if (v === undefined || v === null || v === '') return null; const n = parseFloat(String(v).replace(/^[ou]/i, '')); return isNaN(n) ? null : n; };
  const fmtLine = n => n === null ? null : n === 0 ? 'PK' : (n > 0 ? '+' : '') + n;
  let hs = num(o.pointSpread?.home?.close?.line ?? o.pointSpread?.home?.current?.line ?? o.pointSpread?.home?.open?.line);
  let as = num(o.pointSpread?.away?.close?.line ?? o.pointSpread?.away?.current?.line ?? o.pointSpread?.away?.open?.line);
  if (hs === null && as === null && typeof o.spread === 'number') { hs = o.spread; as = -o.spread; }   // ESPN's spread is the home team's line
  if (hs === null && as !== null) hs = -as;
  if (as === null && hs !== null) as = -hs;
  home.spread = fmtLine(hs); away.spread = fmtLine(as);
  const ou = num(o.overUnder ?? o.total?.over?.close?.line ?? o.total?.over?.current?.line);
  const overUnder = ou === null ? null : String(ou);
  const completed = st.completed ? 1 : 0;
  let winner = null;
  if (completed && home.score !== null && away.score !== null) winner = home.score > away.score ? home.id : away.score > home.score ? away.id : 'TIE';
  return {
    id: String(ev.id), week_key: weekKey, kickoff: Date.parse(ev.date || c.date), state: st.state || 'pre', completed,
    detail: st.shortDetail || st.detail || '', winner, home, away,
    oddsProvider: home.ml || away.ml || home.spread ? (o.provider?.displayName || o.provider?.name || '') : null, overUnder,
  };
}

// Make sure the games for a week are loaded and reasonably fresh. Returns the weeks row.
async function ensureWeek(env, key, { force = false } = {}) {
  const meta = parseKey(key);
  if (!meta) return null;
  let row = await env.DB.prepare(`SELECT * FROM weeks WHERE key=?`).bind(key).first();
  const t = now();
  let maxAge;
  if (!row) maxAge = 0;
  else if (row.all_final) maxAge = row.last_kick > t - 3 * DAY ? 6 * 3600000 : Infinity;   // allow late stat corrections
  else if (row.game_count && t >= row.first_kick - 15 * 60000 && t <= row.last_kick + 6 * 3600000) maxAge = 60000; // games are on
  else if (row.game_count && row.last_kick > t) maxAge = 5 * 60000;   // upcoming games: keep lines fresh
  else maxAge = 30 * 60000;
  if (!force && row && t - row.fetched < maxAge) return row;
  try {
    const d = await espn(env, `/scoreboard?dates=${meta.season}&seasontype=${meta.stype}&week=${meta.week}&limit=100`);
    const games = (d.events || []).map(ev => parseEvent(ev, key)).filter(g => g.id && !isNaN(g.kickoff));
    const stmts = games.map(g => env.DB.prepare(
      `INSERT INTO games (id, week_key, kickoff, state, completed, detail, winner,
         home_id, home_abbr, home_name, home_logo, home_color, home_score, home_record,
         away_id, away_abbr, away_name, away_logo, away_color, away_score, away_record, updated, home_ml, away_ml, odds_provider, home_spread, away_spread, over_under)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?, ?,?,?, ?,?,?)
       ON CONFLICT(id) DO UPDATE SET week_key=excluded.week_key, kickoff=excluded.kickoff, state=excluded.state, completed=excluded.completed,
         detail=excluded.detail, winner=excluded.winner, home_id=excluded.home_id, home_abbr=excluded.home_abbr, home_name=excluded.home_name,
         home_logo=excluded.home_logo, home_color=excluded.home_color, home_score=excluded.home_score, home_record=excluded.home_record,
         away_id=excluded.away_id, away_abbr=excluded.away_abbr, away_name=excluded.away_name, away_logo=excluded.away_logo,
         away_color=excluded.away_color, away_score=excluded.away_score, away_record=excluded.away_record, updated=excluded.updated,
         home_ml=COALESCE(excluded.home_ml, games.home_ml), away_ml=COALESCE(excluded.away_ml, games.away_ml),
         odds_provider=COALESCE(excluded.odds_provider, games.odds_provider),
         home_spread=COALESCE(excluded.home_spread, games.home_spread), away_spread=COALESCE(excluded.away_spread, games.away_spread),
         over_under=COALESCE(excluded.over_under, games.over_under)`
    ).bind(g.id, g.week_key, g.kickoff, g.state, g.completed, g.detail, g.winner,
      g.home.id, g.home.abbr, g.home.name, g.home.logo, g.home.color, g.home.score, g.home.record,
      g.away.id, g.away.abbr, g.away.name, g.away.logo, g.away.color, g.away.score, g.away.record, t,
      g.home.ml, g.away.ml, g.oddsProvider, g.home.spread, g.away.spread, g.overUnder));
    const kicks = games.map(g => g.kickoff);
    const allFinal = games.length > 0 && games.every(g => g.state === 'post') ? 1 : 0;
    stmts.push(env.DB.prepare(
      `INSERT INTO weeks (key, season, stype, week, first_kick, last_kick, all_final, game_count, fetched) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET first_kick=excluded.first_kick, last_kick=excluded.last_kick, all_final=excluded.all_final,
         game_count=excluded.game_count, fetched=excluded.fetched`
    ).bind(key, meta.season, meta.stype, meta.week, kicks.length ? Math.min(...kicks) : null, kicks.length ? Math.max(...kicks) : null, allFinal, games.length, t));
    await env.DB.batch(stmts);
    row = await env.DB.prepare(`SELECT * FROM weeks WHERE key=?`).bind(key).first();
  } catch (e) {
    if (!row) throw e;      // no data at all: surface the error
  }
  return row;
}

// A game locks 24h before its kickoff. A week is fully locked once its last game has locked.
const gameLocked = g => !!(g && g.kickoff && now() >= g.kickoff - LOCK_BEFORE);
// ---------- team stats ----------
// One request returns every team's season stats (theirs and their opponents'). We work out the league ranks ourselves.
const STAT_DEFS = [
  // key, label, category, split ('0' = team, '900' = opponents), stat name, higher is better?, decimals
  ['ppg',   'Points / game',          'passing',       '0',   'totalPointsPerGame',     true,  1],
  ['ypg',   'Total yards / game',     'passing',       '0',   'yardsPerGame',           true,  1],
  ['pass',  'Pass yards / game',   'passing',       '0',   'netPassingYardsPerGame', true,  1],
  ['rush',  'Rush yards / game',   'rushing',       '0',   'rushingYardsPerGame',    true,  1],
  ['third', '3rd down %',    'miscellaneous', '0',   'thirdDownConvPct',       true,  1],
  ['papg',  'Points allowed / game',  'passing',       '900', 'totalPointsPerGame',     false, 1],
  ['yapg',  'Yards allowed / game',   'passing',       '900', 'yardsPerGame',           false, 1],
  ['sacks', 'Sacks (defense)',         'passing',       '900', 'sacks',                  true,  0],
  ['to',    'Turnover margin',    'miscellaneous', '0',   'turnOverDifferential',   true,  0],
];
async function getTeamStats(env, season, force = false) {
  const k = `stats-${season}`;
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k=?`).bind(k).first();
  const cached = row ? JSON.parse(row.v) : null;
  if (cached && !force && now() - cached.fetched < (cached.partial ? 5 : 30) * 60000) return cached;
  try {
    const d = await fetchStatsFeed(env, season);
    const names = {}; (d.categories || []).forEach(c => { names[c.name] = c.names || []; });
    const raw = {};   // teamId -> key -> value
    for (const t of d.teams || []) {
      const id = String(t.team?.id || ''); if (!id) continue;
      raw[id] = {};
      for (const [key, , cat, split, stat] of STAT_DEFS) {
        const c = (t.categories || []).find(x => x.name === cat && String(x.splitId) === split);
        const i = (names[cat] || []).indexOf(stat);
        const v = c && i >= 0 ? Number(c.values?.[i]) : NaN;
        if (!isNaN(v)) raw[id][key] = v;
      }
    }
    const teams = {}; Object.keys(raw).forEach(id => teams[id] = {});
    for (const [key, , , , , higher, dp] of STAT_DEFS) {
      const vals = Object.keys(raw).filter(id => raw[id][key] !== undefined).map(id => [id, raw[id][key]]);
      vals.sort((a, b) => higher ? b[1] - a[1] : a[1] - b[1]);
      vals.forEach(([id, v]) => {
        const rank = 1 + vals.filter(x => higher ? x[1] > v : x[1] < v).length;
        const tied = vals.filter(x => x[1] === v).length > 1;
        teams[id][key] = { v: Math.round(v * 10 ** dp) / 10 ** dp, rank, tied };
      });
    }
    const out = { season, fetched: now(), count: vals_count(teams), labels: STAT_DEFS.map(([key, label, , , , higher, dp]) => ({ key, label, higher, dp })), teams };
    await env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(k, JSON.stringify(out)).run();
    return out;
  } catch (e) {
    if (cached && !cached.partial) return cached;
    try {
      const out = await statsFromStandings(env, season);
      out.note = 'Full stats are temporarily unavailable, showing scoring only.';
      out.error = String(e.message || e);
      await env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(k, JSON.stringify(out)).run();
      return out;
    } catch (e2) {
      if (cached) return cached;
      throw new Error(`${e.message || e}; ${e2.message || e2}`);
    }
  }
}
const vals_count = teams => Object.keys(teams).length;

// ESPN serves the same stats feed from a couple of hosts; try each, with browser-like headers.
async function fetchStatsFeed(env, season) {
  const qs = `?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=40&category=offense&sort=offense.totalYards:desc&season=${season}&seasontype=2`;
  const hosts = env.ESPN_STATS ? [env.ESPN_STATS] : [
    ESPN_STATS,
    'https://site.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam',
  ];
  const errors = [];
  for (const h of hosts) {
    try {
      const r = await fetch(h + qs, { headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'accept': 'application/json, text/plain, */*', 'referer': 'https://www.espn.com/', 'origin': 'https://www.espn.com',
      } });
      if (!r.ok) { errors.push(`${new URL(h).host} ${r.status}`); continue; }
      const d = await r.json();
      if (!Array.isArray(d.teams) || !d.teams.length) { errors.push(`${new URL(h).host} no teams`); continue; }
      if (!Array.isArray(d.categories) || !d.categories.length) { errors.push(`${new URL(h).host} no labels`); continue; }
      return d;
    } catch (e) { errors.push(`${new URL(h).host} ${e.message}`); }
  }
  throw new Error(errors.join('; '));
}

// Backup: points scored and allowed per game from the standings, if the full stats feed can't be reached.
async function statsFromStandings(env, season) {
  const r = await fetch(env.ESPN_STANDINGS || `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${season}`, { headers: { 'user-agent': 'Pickoff/1.0' } });
  if (!r.ok) throw new Error('standings ' + r.status);
  const d = await r.json();
  const entries = [];
  (function walk(n) { if (!n) return; (n.standings?.entries || []).forEach(e => entries.push(e)); (n.children || []).forEach(walk); })(d);
  const raw = {};
  entries.forEach(e => {
    const st = Object.fromEntries((e.stats || []).map(x => [x.name, Number(x.value)]));
    const gp = (st.wins || 0) + (st.losses || 0) + (st.ties || 0);
    if (gp && e.team?.id) raw[String(e.team.id)] = { ppg: st.pointsFor / gp, papg: st.pointsAgainst / gp, diff: (st.pointsFor - st.pointsAgainst) / gp };
  });
  const defs = [['ppg', 'Points / game', true, 1], ['papg', 'Points allowed / game', false, 1], ['diff', 'Point margin / game', true, 1]];
  const teams = {}; Object.keys(raw).forEach(id => teams[id] = {});
  for (const [key, , higher, dp] of defs) {
    const vals = Object.keys(raw).map(id => [id, raw[id][key]]).filter(x => !isNaN(x[1]));
    vals.forEach(([id, v]) => {
      const rank = 1 + vals.filter(x => higher ? x[1] > v : x[1] < v).length;
      teams[id][key] = { v: Math.round(v * 10 ** dp) / 10 ** dp, rank, tied: vals.filter(x => x[1] === v).length > 1 };
    });
  }
  return { season, fetched: now(), count: entries.length, partial: true, labels: defs.map(([key, label, higher, dp]) => ({ key, label, higher, dp })), teams };
}

const isLocked = w => !!(w && w.last_kick && now() >= w.last_kick - LOCK_BEFORE);
const isFinal = w => !!(w && w.all_final);

function gameOut(g) {
  return {
    id: g.id, kickoff: g.kickoff, locksAt: g.kickoff - LOCK_BEFORE, locked: gameLocked(g), state: g.state, completed: !!g.completed, detail: g.detail, winner: g.winner,
    oddsProvider: g.odds_provider || null, overUnder: g.over_under || null,
    home: { id: g.home_id, abbr: g.home_abbr, name: g.home_name, logo: g.home_logo, color: g.home_color, score: g.home_score, record: g.home_record, ml: g.home_ml || null, spread: g.home_spread || null },
    away: { id: g.away_id, abbr: g.away_abbr, name: g.away_name, logo: g.away_logo, color: g.away_color, score: g.away_score, record: g.away_record, ml: g.away_ml || null, spread: g.away_spread || null },
  };
}
function scorePick(pick, g) {
  if (!pick || !g.completed || !g.winner) return null;
  if (pick === g.winner) return g.winner === 'TIE' ? POINTS_TIE : POINTS_WIN;
  return 0;
}

// ---------- auth ----------
async function currentUser(req, env) {
  const m = /(?:^|;\s*)pc_s=([a-f0-9]{64})/.exec(req.headers.get('cookie') || '');
  if (!m) return null;
  const row = await env.DB.prepare(`SELECT u.id, u.username, u.display, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).bind(m[1]).first();
  if (!row || row.expires < now()) return null;
  return { id: row.id, username: row.username, display: row.display, token: m[1] };
}
function sessionCookie(req, token, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `pc_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function startSession(req, env, userId) {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)`).bind(token, userId, now() + 180 * DAY).run();
  return sessionCookie(req, token, 180 * 86400);
}

// ---------- leagues & stats ----------
async function membership(env, leagueId, userId) {
  return env.DB.prepare(`SELECT l.* FROM leagues l JOIN members m ON m.league_id=l.id WHERE l.id=? AND m.user_id=?`).bind(leagueId, userId).first();
}
async function leagueMembers(env, leagueId) {
  const r = await env.DB.prepare(`SELECT u.id, u.display, u.username, m.joined, COALESCE(m.carry, 0) AS carry FROM members m JOIN users u ON u.id=m.user_id WHERE m.league_id=? ORDER BY m.joined`).bind(leagueId).all();
  return r.results;
}
function firstOpenIdx(weeks, weekRows, curKey) {
  const cur = weeks.find(w => w.key === curKey) || weeks[0];
  const row = weekRows[cur.key];
  if (row && isLocked(row)) return Math.min(cur.idx + 1, weeks[weeks.length - 1].idx);
  return cur.idx;
}

async function computeStandings(env, league, members, cur) {
  const weeks = seasonWeeks(league.season);
  const curIdx = (weeks.find(w => w.key === cur.key) || { idx: cur.season > league.season ? 99 : 0 }).idx;
  const inRange = weeks.filter(w => w.idx >= league.start_idx && w.idx <= curIdx);
  const rows = {};
  for (const w of inRange) {
    try { const r = await ensureWeek(env, w.key); if (r) rows[w.key] = r; } catch { /* ESPN hiccup: skip */ }
  }
  // Every week with games counts as soon as any of its games is final. Only finished games are scored.
  const withGames = inRange.filter(w => rows[w.key]?.game_count);
  const out = { weeks: [], players: [], weekWinners: [], champion: null, seasonOver: false, finalCount: 0 };
  if (!members.length) return out;

  let games = [], picks = [];
  if (withGames.length) {
    const keys = withGames.map(w => w.key), qs = keys.map(() => '?').join(',');
    games = (await env.DB.prepare(`SELECT * FROM games WHERE week_key IN (${qs}) ORDER BY kickoff`).bind(...keys).all()).results;
    picks = (await env.DB.prepare(`SELECT p.user_id, p.game_id, p.pick FROM picks p JOIN members m ON m.user_id=p.user_id AND m.league_id=? WHERE p.week_key IN (${qs})`).bind(league.id, ...keys).all()).results;
  }
  const pk = {}; picks.forEach(p => { (pk[p.user_id] ||= {})[p.game_id] = p.pick; });
  const byWeek = {}; games.forEach(g => (byWeek[g.week_key] ||= []).push(g));
  const active = withGames.filter(w => (byWeek[w.key] || []).some(g => g.completed));
  out.weeks = active.map(w => ({ key: w.key, label: w.label, short: w.short, live: !isFinal(rows[w.key]) }));
  out.finalCount = active.filter(w => isFinal(rows[w.key])).length;

  // carry = points from earlier in the season, entered by the commissioner (weeks before the league started here)
  const P = members.map(m => ({ id: m.id, display: m.display, carry: m.carry || 0, points: m.carry || 0, earned: 0, correct: 0, wrong: 0, missed: 0, tiesHit: 0, tiePicks: 0,
    weekly: [], weeksWon: 0, best: null, streak: 0, longest: 0, homePicks: 0, totalPicks: 0, favPicks: {} }));
  for (const w of active) {
    const gs = byWeek[w.key] || [];
    const weekDone = isFinal(rows[w.key]);
    const wk = P.map(p => {
      let pts = 0;
      for (const g of gs) {
        if (!g.completed) continue;               // postponed/cancelled games don't count
        const pick = pk[p.id]?.[g.id];
        if (!pick) { p.missed++; p.streak = 0; continue; }
        p.totalPicks++;
        if (pick === g.home_id) p.homePicks++;
        if (pick === 'TIE') p.tiePicks++;
        const team = pick === g.home_id ? g.home_abbr : pick === g.away_id ? g.away_abbr : null;
        if (team) p.favPicks[team] = (p.favPicks[team] || 0) + 1;
        const s = scorePick(pick, g);
        if (s > 0) { p.correct++; pts += s; p.streak++; p.longest = Math.max(p.longest, p.streak); if (g.winner === 'TIE') p.tiesHit++; }
        else { p.wrong++; p.streak = 0; }
      }
      p.points += pts; p.earned += pts; p.weekly.push(pts);
      if (weekDone && (!p.best || pts > p.best.points)) p.best = { points: pts, label: w.label };
      return pts;
    });
    if (!weekDone) continue;              // weekly winners are decided once every game that week is over
    const top = Math.max(...wk);
    const winners = P.filter((p, i) => wk[i] === top && top > 0);
    winners.forEach(p => p.weeksWon++);
    out.weekWinners.push({ key: w.key, label: w.label, points: top, names: winners.map(p => p.display) });
  }
  P.forEach(p => {
    const decided = p.correct + p.wrong;
    p.pct = decided ? p.correct / decided : null;
    p.avg = active.length ? p.earned / active.length : 0;
    p.homePct = p.totalPicks ? p.homePicks / p.totalPicks : null;
    const fav = Object.entries(p.favPicks).sort((a, b) => b[1] - a[1])[0];
    p.favTeam = fav ? { abbr: fav[0], count: fav[1] } : null;
    delete p.favPicks; delete p.homePicks;
  });
  P.sort((a, b) => b.points - a.points || (b.pct ?? -1) - (a.pct ?? -1) || b.weeksWon - a.weeksWon || a.display.localeCompare(b.display));
  P.forEach((p, i) => { p.rank = i && P[i - 1].points === p.points ? P[i - 1].rank : i + 1; });
  out.players = P;
  const last = weeks[weeks.length - 1];
  out.seasonOver = isFinal(rows[last.key]);
  if (out.seasonOver && P.length && P[0].points > 0) out.champion = P.filter(p => p.rank === 1).map(p => p.display);
  return out;
}

// ---------- API ----------
async function api(req, env, url) {
  await ensureSchema(env);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const user = await currentUser(req, env);
  const need = () => { if (!user) throw Object.assign(new Error('Please sign in'), { status: 401 }); };

  // --- accounts ---
  if (path === '/api/signup' && method === 'POST') {
    const b = await body(req);
    const username = String(b.username || '').trim();
    const display = cleanName(b.display || username, 24);
    if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) return bad('Username must be 3–20 letters, numbers, dots, dashes or underscores.');
    if (String(b.password || '').length < 6) return bad('Password must be at least 6 characters.');
    if (!display) return bad('Enter a display name.');
    const exists = await env.DB.prepare(`SELECT id FROM users WHERE username=?`).bind(username).first();
    if (exists) return bad('That username is taken.');
    const { hash, salt } = await hashPassword(String(b.password));
    const r = await env.DB.prepare(`INSERT INTO users (username, display, pass_hash, salt, created) VALUES (?,?,?,?,?)`).bind(username, display, hash, salt, now()).run();
    const cookie = await startSession(req, env, r.meta.last_row_id);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  if (path === '/api/login' && method === 'POST') {
    const b = await body(req);
    const u = await env.DB.prepare(`SELECT * FROM users WHERE username=?`).bind(String(b.username || '').trim()).first();
    if (!u) return bad('Wrong username or password.', 401);
    const { hash } = await hashPassword(String(b.password || ''), u.salt);
    if (!safeEqual(hash, u.pass_hash)) return bad('Wrong username or password.', 401);
    await env.DB.prepare(`DELETE FROM sessions WHERE expires < ?`).bind(now()).run();
    const cookie = await startSession(req, env, u.id);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  if (path === '/api/logout' && method === 'POST') {
    if (user) await env.DB.prepare(`DELETE FROM sessions WHERE token=?`).bind(user.token).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
  }
  if (path === '/api/account' && method === 'POST') {
    need();
    const b = await body(req);
    if (b.display !== undefined) {
      const d = cleanName(b.display, 24); if (!d) return bad('Enter a display name.');
      await env.DB.prepare(`UPDATE users SET display=? WHERE id=?`).bind(d, user.id).run();
    }
    if (b.newPassword !== undefined) {
      const u = await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(user.id).first();
      const { hash } = await hashPassword(String(b.oldPassword || ''), u.salt);
      if (!safeEqual(hash, u.pass_hash)) return bad('Your current password is wrong.');
      if (String(b.newPassword).length < 6) return bad('New password must be at least 6 characters.');
      const n = await hashPassword(String(b.newPassword));
      await env.DB.batch([
        env.DB.prepare(`UPDATE users SET pass_hash=?, salt=? WHERE id=?`).bind(n.hash, n.salt, user.id),
        env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND token<>?`).bind(user.id, user.token),
      ]);
    }
    return json({ ok: true });
  }
  if (path === '/api/me' && method === 'GET') {
    const cur = await getCurrent(env);
    const weeks = seasonWeeks(cur.season);
    if (!user) return json({ user: null, current: cur.key, season: cur.season });
    const leagues = (await env.DB.prepare(
      `SELECT l.id, l.name, l.code, l.owner_id, l.season, (SELECT COUNT(*) FROM members x WHERE x.league_id=l.id) AS size
       FROM leagues l JOIN members m ON m.league_id=l.id WHERE m.user_id=? ORDER BY m.joined`).bind(user.id).all()).results;
    let curRow = null; try { curRow = await ensureWeek(env, cur.key); } catch {}
    const startIdx = firstOpenIdx(weeks, { [cur.key]: curRow }, cur.key);
    return json({
      user: { id: user.id, username: user.username, display: user.display },
      leagues, current: cur.key, season: cur.season,
      startOptions: weeks.filter(w => w.idx >= startIdx).map(w => ({ key: w.key, label: w.label })),
    });
  }

  // --- leagues ---
  if (path === '/api/leagues' && method === 'POST') {
    need();
    const b = await body(req);
    const name = cleanName(b.name, 40);
    if (!name) return bad('Give your league a name.');
    const cur = await getCurrent(env);
    const weeks = seasonWeeks(cur.season);
    let curRow = null; try { curRow = await ensureWeek(env, cur.key); } catch {}
    const minIdx = firstOpenIdx(weeks, { [cur.key]: curRow }, cur.key);
    const chosen = weeks.find(w => w.key === b.startKey);
    const startIdx = chosen && chosen.idx >= minIdx ? chosen.idx : minIdx;
    let code, tries = 0;
    do { code = randomCode(); tries++; } while (tries < 8 && await env.DB.prepare(`SELECT 1 FROM leagues WHERE code=?`).bind(code).first());
    const r = await env.DB.prepare(`INSERT INTO leagues (name, code, owner_id, season, start_idx, created) VALUES (?,?,?,?,?,?)`).bind(name, code, user.id, cur.season, startIdx, now()).run();
    const id = r.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO members (league_id, user_id, joined) VALUES (?,?,?)`).bind(id, user.id, now()).run();
    return json({ ok: true, id, code });
  }
  if (path === '/api/leagues/preview' && method === 'GET') {
    const code = String(url.searchParams.get('code') || '').toUpperCase().trim();
    const l = await env.DB.prepare(`SELECT l.id, l.name, u.display AS owner, (SELECT COUNT(*) FROM members x WHERE x.league_id=l.id) AS size FROM leagues l JOIN users u ON u.id=l.owner_id WHERE l.code=?`).bind(code).first();
    if (!l) return bad('No league with that code.', 404);
    return json({ league: l });
  }
  if (path === '/api/leagues/join' && method === 'POST') {
    need();
    const b = await body(req);
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const l = await env.DB.prepare(`SELECT * FROM leagues WHERE code=?`).bind(code).first();
    if (!l) return bad('No league with that code. Check it and try again.', 404);
    const size = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE league_id=?`).bind(l.id).first();
    if (size.n >= 100) return bad('That league is full.');
    await env.DB.prepare(`INSERT OR IGNORE INTO members (league_id, user_id, joined) VALUES (?,?,?)`).bind(l.id, user.id, now()).run();
    return json({ ok: true, id: l.id });
  }
  let m;
  if ((m = /^\/api\/leagues\/(\d+)$/.exec(path)) && method === 'GET') {
    need();
    const league = await membership(env, +m[1], user.id);
    if (!league) return bad('League not found.', 404);
    const members = await leagueMembers(env, league.id);
    const cur = await getCurrent(env);
    const standings = await computeStandings(env, league, members, cur);
    const weeks = seasonWeeks(league.season);
    return json({
      league: { id: league.id, name: league.name, code: league.code, season: league.season, isOwner: league.owner_id === user.id, ownerId: league.owner_id,
        start: weeks.find(w => w.idx === league.start_idx) },
      members: members.map(x => ({ id: x.id, display: x.display, username: x.username, carry: x.carry || 0 })),
      standings, current: cur.key,
    });
  }
  if ((m = /^\/api\/leagues\/(\d+)\/(rename|leave|remove|reset|delete|carry)$/.exec(path)) && method === 'POST') {
    need();
    const league = await membership(env, +m[1], user.id);
    if (!league) return bad('League not found.', 404);
    const b = await body(req);
    const owner = league.owner_id === user.id;
    const action = m[2];
    if (action === 'leave') {
      if (owner) return bad('You run this league, so you can’t leave it. You can delete it instead.');
      await env.DB.prepare(`DELETE FROM members WHERE league_id=? AND user_id=?`).bind(league.id, user.id).run();
      return json({ ok: true });
    }
    if (!owner) return bad('Only the commissioner can do that.', 403);
    if (action === 'rename') {
      const name = cleanName(b.name, 40); if (!name) return bad('Give your league a name.');
      await env.DB.prepare(`UPDATE leagues SET name=? WHERE id=?`).bind(name, league.id).run();
      return json({ ok: true });
    }
    if (action === 'carry') {
      // { points: { "<userId>": 42, ... } }
      const pts = b.points && typeof b.points === 'object' ? b.points : {};
      const stmts = [];
      for (const [uid, val] of Object.entries(pts)) {
        const n = Math.round(Number(val));
        if (!Number.isFinite(n) || n < 0 || n > 100000) return bad('Points must be a whole number of 0 or more.');
        stmts.push(env.DB.prepare(`UPDATE members SET carry=? WHERE league_id=? AND user_id=?`).bind(n, league.id, +uid));
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json({ ok: true });
    }
    if (action === 'delete') {
      await env.DB.batch([env.DB.prepare(`DELETE FROM members WHERE league_id=?`).bind(league.id), env.DB.prepare(`DELETE FROM leagues WHERE id=?`).bind(league.id)]);
      return json({ ok: true });
    }
    const target = await env.DB.prepare(`SELECT u.* FROM users u JOIN members m ON m.user_id=u.id WHERE m.league_id=? AND u.id=?`).bind(league.id, +b.userId).first();
    if (!target) return bad('That player isn’t in this league.');
    if (target.id === user.id) return bad('Use Account to change your own password.');
    if (action === 'remove') {
      await env.DB.prepare(`DELETE FROM members WHERE league_id=? AND user_id=?`).bind(league.id, target.id).run();
      return json({ ok: true });
    }
    if (action === 'reset') {
      const temp = randomCode(8).toLowerCase();
      const n = await hashPassword(temp);
      await env.DB.batch([
        env.DB.prepare(`UPDATE users SET pass_hash=?, salt=? WHERE id=?`).bind(n.hash, n.salt, target.id),
        env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(target.id),
      ]);
      return json({ ok: true, username: target.username, tempPassword: temp });
    }
  }

  // --- weeks & picks ---
  if (path === '/api/week' && method === 'GET') {
    need();
    const cur = await getCurrent(env);
    const key = parseKey(url.searchParams.get('key')) ? url.searchParams.get('key') : cur.key;
    const meta = parseKey(key);
    let row;
    try { row = await ensureWeek(env, key); } catch (e) { return bad('Couldn’t reach the NFL schedule right now. Try again in a minute.', 502); }
    const games = (await env.DB.prepare(`SELECT * FROM games WHERE week_key=? ORDER BY kickoff, id`).bind(key).all()).results;
    const mine = (await env.DB.prepare(`SELECT game_id, pick FROM picks WHERE user_id=? AND week_key=?`).bind(user.id, key).all()).results;
    const myPicks = Object.fromEntries(mine.map(p => [p.game_id, p.pick]));
    const weeks = seasonWeeks(meta.season);
    const i = weeks.findIndex(w => w.key === key);
    const locked = isLocked(row), final = isFinal(row);
    const out = {
      week: { key, label: meta.label, season: meta.season, firstKick: row?.first_kick || null, firstLock: row?.first_kick ? row.first_kick - LOCK_BEFORE : null,
        lastLock: row?.last_kick ? row.last_kick - LOCK_BEFORE : null, locked, final, current: key === cur.key,
        prev: weeks[i - 1]?.key || null, next: weeks[i + 1]?.key || null, gameCount: games.length },
      games: games.map(gameOut), myPicks, now: now(),
    };
    out.myPoints = games.reduce((s, g) => s + (scorePick(myPicks[g.id], g) || 0), 0);

    const leagueId = +url.searchParams.get('league') || 0;
    if (leagueId) {
      const league = await membership(env, leagueId, user.id);
      if (league) {
        const members = await leagueMembers(env, league.id);
        const all = (await env.DB.prepare(`SELECT p.user_id, p.game_id, p.pick FROM picks p JOIN members m ON m.user_id=p.user_id AND m.league_id=? WHERE p.week_key=?`).bind(league.id, key).all()).results;
        const by = {}; all.forEach(p => (by[p.user_id] ||= {})[p.game_id] = p.pick);
        const counted = meta.idx >= league.start_idx && meta.season === league.season;
        // A game's picks are revealed once that game is over ('post' also covers postponed/cancelled games).
        const done = new Set(games.filter(g => g.state === 'post').map(g => g.id));
        const anyDone = done.size > 0;
        out.league = { id: league.id, name: league.name, counted, reveal: final, anyDone, doneCount: done.size };
        out.league.players = members.map(x => {
          const p = by[x.id] || {};
          const o = { id: x.id, display: x.display, picked: Object.keys(p).length };
          if (anyDone) {
            o.picks = Object.fromEntries(Object.entries(p).filter(([gid]) => done.has(gid)));
            let pts = 0, cor = 0, wr = 0;
            games.forEach(g => { const s = scorePick(p[g.id], g); if (s === null) return; if (s > 0) { cor++; pts += s; } else wr++; });
            o.points = pts; o.correct = cor; o.wrong = wr;
          }
          return o;
        });
        if (anyDone) {
          const P = out.league.players;
          P.sort((a, b) => b.points - a.points || b.correct - a.correct || a.display.localeCompare(b.display));
          P.forEach((p, j) => { p.rank = j && P[j - 1].points === p.points ? P[j - 1].rank : j + 1; });
          // per-game breakdown: how the league split, and lone-wolf correct picks
          out.league.split = {};
          games.filter(g => done.has(g.id)).forEach(g => {
            const s = { home: 0, away: 0, tie: 0, none: 0 };
            P.forEach(p => { const v = p.picks[g.id]; if (!v) s.none++; else if (v === 'TIE') s.tie++; else if (v === g.home_id) s.home++; else s.away++; });
            out.league.split[g.id] = s;
          });
        }
      }
    }
    return json(out);
  }
  if (path === '/api/stats' && method === 'GET') {
    need();
    const cur = await getCurrent(env);
    const season = +url.searchParams.get('season') || cur.season;
    try { return json(await getTeamStats(env, season)); }
    catch (e) { return bad('Team stats aren’t available right now (' + String(e.message || e).slice(0, 160) + ').', 502); }
  }
  if (path === '/api/picks' && method === 'POST') {
    need();
    const b = await body(req);
    const g = await env.DB.prepare(`SELECT * FROM games WHERE id=?`).bind(String(b.gameId || '')).first();
    if (!g) return bad('Game not found.');
    await ensureWeek(env, g.week_key);   // refresh in case the kickoff time moved
    const fresh = await env.DB.prepare(`SELECT * FROM games WHERE id=?`).bind(g.id).first();
    if (gameLocked(fresh)) return bad(`${fresh.away_abbr} @ ${fresh.home_abbr} is locked. Picks close 24 hours before kickoff.`, 409);
    const pick = b.pick === null || b.pick === '' ? null : String(b.pick);
    if (pick === null) {
      await env.DB.prepare(`DELETE FROM picks WHERE user_id=? AND game_id=?`).bind(user.id, g.id).run();
      return json({ ok: true });
    }
    if (pick !== 'TIE' && pick !== g.home_id && pick !== g.away_id) return bad('That team isn’t in this game.');
    if (!g.home_id || !g.away_id || g.home_abbr === 'TBD' || g.away_abbr === 'TBD') return bad('This matchup isn’t set yet.');
    await env.DB.prepare(`INSERT INTO picks (user_id, game_id, week_key, pick, updated) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, game_id) DO UPDATE SET pick=excluded.pick, week_key=excluded.week_key, updated=excluded.updated`).bind(user.id, g.id, g.week_key, pick, now()).run();
    return json({ ok: true });
  }

  return bad('Not found', 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { return bad(e.status ? e.message : 'Something went wrong: ' + (e.message || e), e.status || 500); }
    }
    return env.ASSETS.fetch(req);
  },
  // Every 10 minutes: keep the current week's scores fresh so standings update even if nobody opens the app.
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    const cur = await getCurrent(env, true);
    const weeks = seasonWeeks(cur.season);
    const i = weeks.findIndex(w => w.key === cur.key);
    for (const w of [weeks[i - 1], weeks[i], weeks[i + 1]].filter(Boolean)) {
      try { await ensureWeek(env, w.key); } catch {}
    }
    try { await getTeamStats(env, cur.season); } catch {}
  },
};
