# hybra overchat relay — Vercel edition

Off-PC 24/7 relay so hybra's Cloudflare Worker can reach `api.overchat.ai`
without hitting the CF-egress WAF wall. Egresses from AWS-shaped IPs, with
your proxy pool rotating behind that for any request overchat still flags.

## Deploy

Two paths — pick one.

### A. GitHub + Vercel dashboard (5 min, no CLI)

1. Make a new empty GitHub repo (private is fine).
2. Push just this `vercel-relay/` folder as the repo root:
   ```
   git init && git add . && git commit -m "init" && git branch -M main
   git remote add origin git@github.com:<you>/hybra-relay.git && git push -u origin main
   ```
3. Go to https://vercel.com/new → import that repo.
4. **Before hitting deploy**, expand **Environment Variables** and add:
   - `PROXY_LIST` — paste your whole `ip:port:user:pass` list, one per line
5. Deploy. You'll get `https://<name>.vercel.app`.
6. Hit `https://<name>.vercel.app/api/healthz` — should return
   `{"service":"hybra-overchat-relay","proxies_total":N,"proxies_alive":N}`.

### B. Vercel CLI

```
npm i -g vercel
cd vercel-relay
vercel        # follow prompts, link to your account
vercel env add PROXY_LIST   # paste list, one per line
vercel --prod
```

## How hybra uses it

Set the worker env var:
```
OVERCHAT_BASE_URL = https://<name>.vercel.app/api
```
Note the trailing `/api` — Vercel serves the function under `/api/*`, and
the relay strips that prefix before forwarding to overchat.

## Limits

- Hobby plan: 100 GB-hours/mo compute, plenty for personal use.
- Each function invocation caps at 30s (`maxDuration`) — enough for any
  reasonable chat completion. Very long streams may get cut.
- Cold start ~1–2s after idle; warm calls ~50ms.
