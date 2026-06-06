# Run TourSensi Scout locally

You can iterate on the **frontend** (HTML/CSS/JS) without redeploying. The
backend stays on Firebase (no need to run functions locally — they already work).

## One-time setup
```bash
cd "/Users/navy/Documents/TourSensi Scout"
npm install -g serve
```

## Run the frontend locally
```bash
cd "/Users/navy/Documents/TourSensi Scout/public"
serve -p 5173
```

Open: **http://localhost:5173**

The page automatically calls the live backend at
`https://api-bvb33x56gq-el.a.run.app/api/*`, so the AI agent, Apify, Google
Maps, Firestore — everything works as if you were on the deployed URL.

## Iterate
- Edit `public/index.html`, `public/styles.css`, or `public/app.js`
- **Hard-reload the browser** (Cmd-Shift-R on Mac) — changes appear instantly.
- No rebuild, no deploy.

## When you want backend changes live
```bash
cd "/Users/navy/Documents/TourSensi Scout"
firebase deploy --only functions     # backend
firebase deploy --only hosting       # frontend (push your local edits live)
```
