NightInk clean Cloudflare project

Structure:
- public/index.html  -> website
- src/index.js       -> Cloudflare Worker/API
- wrangler.toml      -> Cloudflare configuration
- package.json       -> Wrangler dependency/deploy script

Cloudflare build settings:
- Build command: None
- Deploy command: npx wrangler deploy
- Root directory: /

Expected test after deploy:
https://YOUR-WORKER.workers.dev/api/health

Expected response:
{"ok":true,"app":"nightink-app","worker":true}

Do not add D1, R2 or ADMIN_TOKEN yet. First confirm this clean deployment works.
vt
