# Albion Eye – activity

Collector for the "When to play?" heatmaps of Albion Eye, an unofficial Albion Online fan site.

Every few minutes a GitHub Action reads the latest public kills from the Albion Online API
(Europe, Americas and Asia) and the number of players online on Steam, and adds hourly counts
(UTC) to `data/`:

- `kills-<server>.json`: per hour, minutes covered (`min`) and kills by fight size
  (`solo`, `small` 2–5, `medium` 6–19, `large` 20+). Kills per minute = kills / `min`.
- `steam.json`: per hour, sum and number of samples of players online on Steam.
- `state.json`: last kill seen per server (to avoid counting twice).
- `outages.json`: per server, recent outages (`start` = last kill before it, `end` = first kill
  after it, `null` while ongoing). A server counts as down when no kill newer than 15 minutes
  shows up (the API publishes kills about 5 minutes late).

No individual kills or player data are stored.

Not affiliated with Sandbox Interactive. Albion Online is a trademark of Sandbox Interactive GmbH.
