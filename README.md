# carddeals

A deal finder for sports trading cards on Vinted. Every 10 minutes it scans new listings, works out which card each one is, compares the asking price with recent sales, and shows the results on a local dashboard.

I built it for my own card business (MB Slabs, Lithuania) with AI coding assistants.

## What it does

- **Scans** a filtered Vinted catalog (Topps and Panini trading cards) every 10 minutes with Playwright.
- **Parses** titles written in Lithuanian, Polish and English into player, set, card number, parallel and grade. It also detects graded slabs (a grader plus a grade number, because "psa" is Polish for "dog").
- **Prices** each card against recent sales from SportsCardsPro (per-grade sales tables) and the Card Hedge API, with FX conversion.
- **Judges** each listing as deal, offer or no deal, with a confidence level. When it cannot match a card with confidence, it refuses to price it.
- **Cert lookup** for slabs: a PSA cert number returns the exact card, grade, population and fair market value, so the title parser is skipped completely.
- **Dashboard** (`dashboard.js`, port 8484) with three tabs: Deals, Listings (a browser over every listing seen, with filters) and Market Watch, plus a player watchlist that notifies on new listings.

## What went wrong and what I fixed

The first three "deals" it found were all false. The causes:

1. **Stale comps.** Sales from 2023 and 2024 were being used. Comps are now capped at 365 days, and if every comp is too old it refuses.
2. **Numbered parallels vs base cards.** A /50 parallel was being compared with the base card. Serial-numbered parallels are now refused unless they are matched exactly.
3. **Brand counted as a set.** A bare "Topps" or "Panini" no longer counts as a specific set, and the confidence drops.

Afterwards I measured where it still fails. Graded slabs find comps about 4 times more often than raw cards, and most of the remaining failures come from titles that cannot be parsed, not from missing price data. So adding another price source would help less than better title parsing or cert lookups.

## Layout

```
scanner.js     10-minute scan loop
dashboard.js   local web dashboard
cli.js         price a single card from the command line
lib/
  vinted.js    listing collection
  parse.js     multilingual title parser and slab detection
  scp.js       SportsCardsPro comps
  cardhedger.js Card Hedge API (search, comps, cert lookup)
  comps.js     comp selection and recency rules
  verdict.js   deal / offer / no deal bands
  fx.js        currency conversion
  ebay.js, psa.js, ximilar.js  optional sources (need API access)
public/        dashboard front end
```

## Setup

```bash
npm install
npx playwright install chromium
cp config.example.json config.json   # add your own API keys
node scanner.js
node dashboard.js
```
