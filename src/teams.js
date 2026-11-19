// The season's teams (migrations/0016_teams.sql, 0018_team_modes.sql), as the dashboard and the admin
// page get them, in their order:
//   { id, name, short, color, color_dark,
//     bar      in the Combat scoreboard at all
//     middle   …as the team in the middle of the tug-of-war bar (show_bar = 2)
//     chart    its kills as their own series in the Combat chart
//     activity in the Activity page's by-team charts, as a series of its own
//     activity_with  the id of the team whose series its playtime counts in instead, or null }
// [] before the teams table exists.
export async function teamRows(db, seasonN) {
  const read = (extra) => db.prepare(
    `SELECT id, name, short, color, color_dark, show_bar, show_chart, show_activity${extra}
     FROM teams WHERE season = ? ORDER BY sort, id`
  ).bind(seasonN).all();
  let results;
  try {
    ({ results } = await read(', activity_with'));
  } catch {
    try { ({ results } = await read('')); } catch { return []; } // before 0018, or before 0016
  }
  return results.map((t) => ({
    id: t.id, name: t.name, short: t.short, color: t.color, color_dark: t.color_dark,
    bar: t.show_bar > 0, middle: t.show_bar === 2, chart: !!t.show_chart,
    activity: !!t.show_activity, activity_with: t.activity_with || null,
  }));
}
