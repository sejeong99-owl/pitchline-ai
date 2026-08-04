exports.handler = async function (event) {
  const API_KEY = process.env.FOOTBALL_DATA_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing FOOTBALL_DATA_API_KEY environment variable" }),
    };
  }

  const competitions = ["PL", "PD", "SA"];

  try {
    const results = await Promise.all(
      competitions.map(async (code) => {
        const res = await fetch(
          `https://api.football-data.org/v4/competitions/${code}/matches?status=SCHEDULED`,
          { headers: { "X-Auth-Token": API_KEY } }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return (data.matches || []).slice(0, 5).map((m) => ({
          id: m.id,
          league: data.competition?.name || code,
          home: m.homeTeam?.name,
          away: m.awayTeam?.name,
          homeShort: (m.homeTeam?.tla || m.homeTeam?.shortName || "").slice(0, 3).toUpperCase(),
          awayShort: (m.awayTeam?.tla || m.awayTeam?.shortName || "").slice(0, 3).toUpperCase(),
          kickoff: m.utcDate,
        }));
      })
    );

    const fixtures = results.flat();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
