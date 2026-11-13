# Pick'em Club

An NFL pick'em app for you and your friends. Make a league, invite people with a code, and pick the winner of every game each week.

## Rules
- Pick the winner of every game, or pick a **tie**.
- Right winner: **1 point**. Wrong: **0**. Picked a tie and the game ties: **10 points**. No pick: 0.
- You can pick each game until **24 hours before it kicks off**. Then that game locks.
- Each game shows both teams' **moneylines** (from the sportsbook ESPN lists, currently DraftKings) to help you pick.
- Nobody can see anyone else's picks until **every game that week is final**. Then the whole pick sheet is revealed.
- Each week has a weekly winner. The season champion has the most points after the Super Bowl. Playoff games count.
- A player's picks count in every league they belong to.

## What's in here
- `worker.js`: the Cloudflare Worker. It runs the API (accounts, leagues, picks, scoring and stats) and pulls the NFL schedule and live scores from ESPN's public scoreboard feed. A scheduled job refreshes scores every 10 minutes.
- `public/`: the app itself (`index.html`), icons and home-screen settings.
- `wrangler.jsonc`: Cloudflare settings, including the **D1 database** (named `pickem-club`, bound as `DB`) that stores accounts, leagues and picks.

The database tables create themselves the first time the app runs, so there's no setup script to run.

## Publishing (Cloudflare + GitHub)
Same as WhereInTheWord: Cloudflare Workers is connected to this repo, so every push to `main` publishes automatically.

First-time setup:
1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and choose `pickem-club`.
2. Leave the build command empty and keep the deploy command `npx wrangler deploy`. Click **Deploy**.
3. On the first deploy Cloudflare creates the `pickem-club` D1 database automatically.
   *If the deploy log instead complains about the database*, go to **Storage & Databases → D1 → Create**, name it `pickem-club`, copy its **Database ID**, and add it to `wrangler.jsonc` as `"database_id": "<the id>"` next to `"database_name"`. Then push again.
4. The app will be live at `https://pickem-club.<your-subdomain>.workers.dev`.

## Forgotten passwords
There's no email, so the league's commissioner resets passwords: **League → Manage (next to the player) → Reset password**. It shows a temporary password to send them, and they change it under **Account**.

## Testing locally
`npx wrangler dev` runs the app at http://localhost:8787 with a local database. To test without the real NFL schedule, point it at a fake feed with `--var ESPN_BASE:http://127.0.0.1:8788`.
