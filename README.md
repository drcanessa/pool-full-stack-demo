# Pool Full Stack Demo

A presentation-ready, mobile-first 8-ball score tracker demo. It showcases multiple series, round results, locations, prizes, history, player stats, and the custom win celebrations.

This repository is deliberately static and local-only: it uses canned data, has no passcode flow, and does not connect to the production Supabase scorebook.

## Preview locally

Run a static server from this folder, then open `index.html` for the app itself.

```sh
python3 -m http.server 4174
```

## Deploy

This project is configured as a static site and includes `vercel.json` for deployment on Vercel.
