// Netlify serverless function — server-side only, API key never reaches the browser.
//
// Model v2 improvements:
//  - Uses HOME-specific stats for the home team and AWAY-specific stats for
//    the away team (not just season totals) where enough games exist.
//  - Applies a recent-form momentum multiplier (last-5 W/D/L) to attack strength.
//  - Adds per-team "goal threat" (P(score >=1), P(score >=2)).
//  - Adds a plain-language verdict comparing the two sides.
//  - Covers 9 free-tier competitions instead of 3.

const COMPETITIONS = ["PL", "PD", "SA", "BL1", "FL1", "DED", "PPL", "ELC", "CL"];
const MAX_GOALS = 7;
const HOME_ADVANTAGE = 1.15;
const AWAY_PENALTY = 0.95;
const MIN_GAMES_FOR_SPLIT = 3; // below this, fall back to TOTAL table stats

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
function poissonPmf(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}
function poissonAtLeast(k, lambda) {
  let cum = 0;
  for (let i = 0; i < k; i++) cum += poissonPmf(i, lambda);
  return Math.max(0, Math.min(1, 1 - cum));
}

async function fetchJson(url, apiKey) {
  const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
  if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`);
  return res.json();
}

function rowsToMap(table) {
  const map = {};
  table.forEach((row) => {
    map[row.team.id] = {
      played: row.playedGames || 0,
      points: row.points,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      form: (row.form || "").split(",").filter(Boolean).map((r) => r.trim()[0]),
    };
  });
  return map;
}

function buildStatsMaps(standingsData) {
  const groups = standingsData.standings || [];
  const totalTable = groups.find((s) => s.type === "TOTAL")?.table || [];
  const homeTable = groups.find((s) => s.type === "HOME")?.table || [];
  const awayTable = groups.find((s) => s.type === "AWAY")?.table || [];

  const totalMap = rowsToMap(totalTable);
  const homeMap = rowsToMap(homeTable);
  const awayMap = rowsToMap(awayTable);

  let totalGoals = 0, totalGames = 0;
  totalTable.forEach((row) => {
    totalGoals += row.goalsFor;
    totalGames += row.playedGames || 0;
  });
  const leagueAvgGoals = totalGames > 0 ? totalGoals / totalGames : 1.3;

  return { totalMap, homeMap, awayMap, leagueAvgGoals };
}

function pickStats(teamId, splitMap, totalMap) {
  const split = splitMap[teamId];
  if (split && split.played >= MIN_GAMES_FOR_SPLIT) return split;
  return totalMap[teamId];
}

function formMultiplier(form) {
  if (!form || form.length === 0) return 1;
  const points = form.reduce((sum, r) => sum + (r === "W" ? 3 : r === "D" ? 1 : 0), 0);
  const avg = points / (form.length * 3); // 0..1
  return 0.85 + avg * 0.3; // 0.85..1.15
}

function verdictText(home, away, probs, expHome, expAway) {
  const gap = probs.home - probs.away;
  let lean;
  if (Math.abs(gap) < 6) lean = `${home} and ${away} are closely matched on current form`;
  else if (gap > 0)
    lean = gap > 20 ? `${home} are strongly favored at home` : `${home} hold a moderate edge`;
  else
    lean = gap < -20 ? `${away} are strongly favored despite playing away` : `${away} hold a slight edge on the road`;
  const goalNote =
    expHome + expAway > 2.6
      ? "Both sides project enough attacking output for a high-scoring game."
      : "Expected goals are modest, pointing to a tighter, lower-scoring game.";
  return `${lean}. ${goalNote}`;
}

function predictFixture(fixture, homeStats, awayStats, leagueAvgGoals) {
  const homeAttack = (homeStats.goalsFor / homeStats.played / leagueAvgGoals) * formMultiplier(homeStats.form);
  const homeDefense = homeStats.goalsAgainst / homeStats.played / leagueAvgGoals;
  const awayAttack = (awayStats.goalsFor / awayStats.played / leagueAvgGoals) * formMultiplier(awayStats.form);
  const awayDefense = awayStats.goalsAgainst / awayStats.played / leagueAvgGoals;

  const expHome = Math.max(0.25, homeAttack * awayDefense * leagueAvgGoals * HOME_ADVANTAGE);
  const expAway = Math.max(0.25, awayAttack * homeDefense * leagueAvgGoals * AWAY_PENALTY);

  const matrix = [];
  let pHome = 0, pDraw = 0, pAway = 0, pOver25 = 0, pOver15 = 0, pOver35 = 0, pBtts = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    matrix[i] = [];
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poissonPmf(i, expHome) * poissonPmf(j, expAway);
      matrix[i][j] = p;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
      if (i + j >= 2) pOver15 += p;
      if (i + j >= 3) pOver25 += p;
      if (i + j >= 4) pOver35 += p;
      if (i >= 1 && j >= 1) pBtts += p;
    }
  }

  const scores = [];
  for (let i = 0; i <= MAX_GOALS; i++)
    for (let j = 0; j <= MAX_GOALS; j++)
      scores.push({ s: `${i}-${j}`, p: +(matrix[i][j] * 100).toFixed(1) });
  scores.sort((a, b) => b.p - a.p);

  const total = pHome + pDraw + pAway;
  const probs = {
    home: Math.round((pHome / total) * 100),
    draw: Math.round((pDraw / total) * 100),
    away: Math.round((pAway / total) * 100),
  };
  probs.home += 100 - (probs.home + probs.draw + probs.away);

  const topProb = Math.max(pHome, pDraw, pAway) / total;
  const sampleSize = Math.min(homeStats.played, awayStats.played);
  const confidence = Math.round(Math.min(92, Math.max(38, topProb * 100 * 0.8 + Math.min(sampleSize, 20))));
  const risk = confidence > 70 ? "Low" : confidence > 55 ? "Medium" : "High";

  const homePpg = (homeStats.points / homeStats.played).toFixed(2);
  const awayPpg = (awayStats.points / awayStats.played).toFixed(2);

  return {
    ...fixture,
    probs,
    confidence,
    risk,
    xg: { home: +expHome.toFixed(2), away: +expAway.toFixed(2) },
    scores: scores.slice(0, 5),
    goals: {
      o15: Math.round(pOver15 * 100),
      o25: Math.round(pOver25 * 100),
      o35: Math.round(pOver35 * 100),
      btts: Math.round(pBtts * 100),
    },
    goalThreat: {
      home: { atLeast1: Math.round(poissonAtLeast(1, expHome) * 100), atLeast2: Math.round(poissonAtLeast(2, expHome) * 100) },
      away: { atLeast1: Math.round(poissonAtLeast(1, expAway) * 100), atLeast2: Math.round(poissonAtLeast(2, expAway) * 100) },
    },
    form: {
      home: homeStats.form.length ? homeStats.form : ["-", "-", "-", "-", "-"],
      away: awayStats.form.length ? awayStats.form : ["-", "-", "-", "-", "-"],
    },
    keyPlayers: ["Player-level data requires a paid data tier"],
    verdict: verdictText(fixture.home, fixture.away, probs, expHome, expAway),
    explanation: `${fixture.home} average ${homePpg} points per game (home form weighted) versus ${fixture.away}'s ${awayPpg} (away form weighted). Expected goals: ${expHome.toFixed(1)}–${expAway.toFixed(1)}. Statistical (Poisson) estimate from home/away-split league-table data — not a trained ML model.`,
  };
}

exports.handler = async function () {
  const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: "Missing FOOTBALL_DATA_API_KEY" }) };

  try {
    const fixtures = [];
    for (const code of COMPETITIONS) {
      let standingsData, matchesData;
      try {
        [standingsData, matchesData] = await Promise.all([
          fetchJson(`https://api.football-data.org/v4/competitions/${code}/standings`, API_KEY),
          fetchJson(`https://api.football-data.org/v4/competitions/${code}/matches?status=SCHEDULED`, API_KEY),
        ]);
      } catch (e) {
        continue; // competition not accessible on this API tier — skip quietly
      }

      const { totalMap, homeMap, awayMap, leagueAvgGoals } = buildStatsMaps(standingsData);
      const leagueName = standingsData.competition?.name || code;

      (matchesData.matches || []).slice(0, 8).forEach((m) => {
        const homeStats = pickStats(m.homeTeam?.id, homeMap, totalMap);
        const awayStats = pickStats(m.awayTeam?.id, awayMap, totalMap);
        if (!homeStats || !awayStats || !homeStats.played || !awayStats.played) return;
        const fixture = {
          id: m.id,
          league: leagueName,
          home: m.homeTeam?.name,
          away: m.awayTeam?.name,
          homeShort: (m.homeTeam?.tla || m.homeTeam?.shortName || "").slice(0, 3).toUpperCase(),
          awayShort: (m.awayTeam?.tla || m.awayTeam?.shortName || "").slice(0, 3).toUpperCase(),
          kickoff: m.utcDate,
        };
        fixtures.push(predictFixture(fixture, homeStats, awayStats, leagueAvgGoals));
      });
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixtures }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
