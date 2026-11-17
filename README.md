# Pickoff

An NFL pick'em app for you and your friends. Make a league, invite people with a code, and pick the winner of every game each week.

## Rules
- Pick the winner of every game, or pick a **tie**.
- Right winner: **1 point**. Wrong: **0**. Picked a tie and the game ties: **10 points**. No pick: 0.
- You can pick each game until **24 hours before it kicks off**. Then that game locks.
- Each game shows the **point spread** (who's favored and by how much), the **over/under** and both **moneylines**, from the sportsbook ESPN lists (currently DraftKings). Lines refresh every few minutes, and the app picks up changes while you have it open.
- Tap **Team stats** on any game to compare the two teams (points, yards, passing, rushing, 3rd downs, points and yards allowed, sacks, turnover margin) with each team's NFL rank. Stats come from ESPN and refresh every 30 minutes.
- Nobody can see anyone else's pick for a game until **that game is over**. Then it shows up on Results, and the points count in the week leaderboard and season standings right away. The weekly winner is decided once every game that week is over.
- Each week has a weekly winner. The season champion has the most points after the Super Bowl. Playoff games count.
- A player's picks count in every league they belong to.

## What's in here
- `worker.js`: the Cloudflare Worker. It runs the API (accounts, leagues, picks, scoring and stats) and pulls the NFL schedule and live scores from ESPN's public scoreboard feed. A scheduled job refreshes scores every 10 minutes.
- `public/`: the app itself (`index.html`), icons and home-screen settings.
- `wrangler.jsonc`: Cloudflare settings, including the **D1 database** that stores accounts, leagues and picks. It's bound as `DB` and pinned by its ID; the database itself keeps its original name, `pickem-club`.

The database tables create themselves the first time the app runs, so there's no setup script to run.

## Publishing (Cloudflare + GitHub)
Same as WhereInTheWord: Cloudflare Workers is connected to this repo, so every push to `main` publishes automatically.

The Worker is named **pickoff** in Cloudflare, so the app lives at **https://pickoff.nathanmwiggy.workers.dev**. The `name` in `wrangler.jsonc` must match the Worker's name in the dashboard, or builds fail.

## Points from earlier in the season
If your group was already playing before you started using the app, the commissioner can enter each player's points so far under **League → Points from earlier**, and choose which weeks each player's total covers (for example Weeks 1–10, or later for someone who joins late). The app counts that player's picks starting the week after. Those points are added to the season standings, and every week picked in the app adds on top. Accuracy (W–L, %) only counts weeks picked in the app.

## First week that counts
Each league has its own first counted week (**League → Commissioner → First week that counts**). Weeks before it don't count in that league's standings. Picks are shared across leagues, so changing it never affects another league.

## Forgotten passwords
There's no email, so the league's commissioner resets passwords: **League → Manage (next to the player) → Reset password**. It shows a temporary password to send them, and they change it under **Account**.

## Testing locally
`npx wrangler dev` runs the app at http://localhost:8787 with a local database. To test without the real NFL schedule, point it at a fake feed with `--var ESPN_BASE:http://127.0.0.1:8788`.
