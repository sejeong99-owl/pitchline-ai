// Netlify serverless function — runs on the server, never in the browser.
// Fetches real standings (form, goals for/against, points) and scheduled
// fixtures from football-data.org, then derives win/draw/loss and score
// probabilities using a Poisson goal-expectancy model (attack/defense
// strength vs league average — the standard statistical approach used
// widely in football analytics before adding ML on top).

const COMPETITIONS = ["PL", "PD", "SA"]; // Premier League, La Liga, Serie A
const MAX_GOALS = 6;
const HOME_ADVANTAGE = 1.15;
const AWAY_PENALTY = 0.95;

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
function poissonPmf(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

async function fetchJson(url, apiKey) {
  const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
  if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`);
  return res.json();
}

function buildTeamStatsMap(standingsData) {
  const map = {};
  let totalGoals = 0;
  let totalGames = 0;
  const table = standingsData.standings?.find((s) => s.type === "TOTAL")?.table || [];
  table.forEach((row) => {
    map[row.team.id] = {
      played: row.playedGames || 1,
      points: row.points,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      form: (row.form || "").split(",").filter(Boolean).map((r) => r.trim()[0]),
    };
    totalGoals += row.goalsFor;
    totalGames += row.playedGames || 0;
  });
  const leagueAvgGoals = totalGames > 0 ? totalGoals / totalGames : 1.3;
  return { map, leagueAvgGoals };
}

function predictFixture(fixture, homeStats, awayStats, leagueAvgGoals) {
  const homeAttack = homeStats.goalsFor / homeStats.played / leagueAvgGoals;
  const homeDefense = homeStats.goalsAgainst / homeStats.played / leagueAvgGoals;
  const awayAttack = awayStats.goalsFor / awayStats.played / leagueAvgGoals;
  const awayDefense = awayStats.goalsAgainst / awayStats.played / leagueAvgGoals;

  const expHome = Math.max(0.3, homeAttack * awayDefense * leagueAvgGoals * HOME_ADVANTAGE);
  const expAway = Math.max(0.3, awayAttack * homeDefense * leagueAvgGoals * AWAY_PENALTY);

  const matrix = [];
  let pHome = 0, pDraw = 0, pAway = 0, pOver25 = 0, pBtts = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    matrix[i] = [];
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poissonPmf(i, expHome) * poissonPmf(j, expAway);
      matrix[i][j] = p;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
      if (i + j >= 3) pOver25 += p;
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
  const diff = 100 - (probs.home + probs.draw + probs.away);
  probs.home += diff;

  const topProb = Math.max(pHome, pDraw, pAway) / total;
  const sampleSize = Math.min(homeStats.played, awayStats.played);
  const confidence = Math.round(
    Math.min(90, Math.max(40, topProb * 100 * 0.8 + Math.min(sampleSize, 20)))
  );
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
    goals: { o25: Math.round(pOver25 * 100), btts: Math.round(pBtts * 100) },
    form: {
      home: homeStats.form.length ? homeStats.form : ["-", "-", "-", "-", "-"],
      away: awayStats.form.length ? awayStats.form : ["-", "-", "-", "-", "-"],
    },
    keyPlayers: ["Player-level data requires a paid data tier"],
    explanation: `${fixture.home} average ${homePpg} points per game this season versus ${fixture.away}'s ${awayPpg}. Based on each side's goals-for/against relative to the league average, the model expects roughly ${expHome.toFixed(1)}–${expAway.toFixed(1)} goals. This is a statistical (Poisson) estimate from league-table data, not a trained machine-learning model.`,
  };
}

exports.handler = async function () {
  const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing FOOTBALL_DATA_API_KEY" }) };
  }

  try {
    const fixtures = [];
    for (const code of COMPETITIONS) {
      const [standingsData, matchesData] = await Promise.all([
        fetchJson(`https://api.football-data.org/v4/competitions/${code}/standings`, API_KEY),
        fetchJson(`https://api.football-data.org/v4/competitions/${code}/matches?status=SCHEDULED`, API_KEY),
      ]);
      const { map, leagueAvgGoals } = buildTeamStatsMap(standingsData);
      const leagueName = standingsData.competition?.name || code;

      (matchesData.matches || []).slice(0, 6).forEach((m) => {
        const homeStats = map[m.homeTeam?.id];
        const awayStats = map[m.awayTeam?.id];
        if (!homeStats || !awayStats) return;
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
