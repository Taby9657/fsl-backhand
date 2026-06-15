# FSL Backend – Railway Deployment

## Prerekvizity

- Účet na [railway.app](https://railway.app)
- GitHub repo s tímto projektem
- Účet na [Cloudinary](https://cloudinary.com) (upload fotek)
- Stripe účet (platby)
- Google Cloud Console projekt (OAuth)

---

## 1. Databáze (PostgreSQL)

V Railway dashboardu:
1. **New Project → Add Service → Database → PostgreSQL**
2. Po vytvoření klikni na databázi → záložka **Connect**
3. Zkopíruj `DATABASE_URL` (formát: `postgresql://user:pass@host:port/db`)

---

## 2. Backend service

1. **New Service → GitHub Repo** → vyber tento repozitář
2. Railway automaticky detekuje `railway.toml` a použije nixpacks
3. Start command je nastaven na: `npm run db:migrate && npm start`

---

## 3. Environment Variables

V Railway dashboardu → tvůj service → záložka **Variables**. Přidej:

```
# Databáze (zkopíruj z PostgreSQL service)
DATABASE_URL=postgresql://...

# JWT
JWT_SECRET=vygeneruj-nahodny-string-min-32-znaku
JWT_EXPIRES_IN=30d

# Google OAuth
# → console.cloud.google.com → APIs → Credentials → OAuth 2.0 Client ID
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx

# Apple Sign In
# → developer.apple.com → Certificates → Keys
APPLE_CLIENT_ID=cz.fsl.app
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_KEY_ID=XXXXXXXXXX
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# Cloudinary
CLOUDINARY_CLOUD_NAME=xxx
CLOUDINARY_API_KEY=xxx
CLOUDINARY_API_SECRET=xxx

# Stripe
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# App
PORT=3000
NODE_ENV=production
CLIENT_URL=https://tvoje-domena.com

# Supervisoři (comma-separated user IDs)
SUPERVISOR_USER_IDS=user-mv
```

### Rychlé vygenerování JWT_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 4. Google OAuth nastavení

1. [console.cloud.google.com](https://console.cloud.google.com)
2. APIs & Services → Credentials → **Create OAuth 2.0 Client ID**
3. Application type: **iOS** (pro mobilní app) nebo **Web** (pro testování)
4. Authorized origins: `https://tvuj-railway-domain.railway.app`
5. Zkopíruj Client ID a Client Secret do Railway variables

---

## 5. Stripe Webhook

Po deployi:
1. [dashboard.stripe.com](https://dashboard.stripe.com) → Developers → Webhooks
2. **Add endpoint**: `https://tvuj-railway-domain.railway.app/api/payments/webhook`
3. Events: `checkout.session.completed`
4. Zkopíruj **Signing secret** do `STRIPE_WEBHOOK_SECRET`

---

## 6. Po deploymentu

```bash
# Seed dat (volitelné – jen pro první spuštění)
railway run npm run db:seed

# Prisma Studio (správa databáze přes UI)
railway run npm run db:studio
```

---

## 7. Lokální vývoj

```bash
cd backend
cp .env.example .env
# Vyplň .env

npm install
npm run db:generate    # generuj Prisma client
npm run db:migrate     # vytvoř tabulky (potřebuješ lokální Postgres)
npm run db:seed        # seed demo data
npm run dev            # spustí server s nodemon
```

### Rychlý lokální Postgres přes Docker:
```bash
docker run -d \
  --name fsl-db \
  -e POSTGRES_PASSWORD=fsl123 \
  -e POSTGRES_DB=fsl \
  -p 5432:5432 \
  postgres:16-alpine

# DATABASE_URL pro .env:
# postgresql://postgres:fsl123@localhost:5432/fsl
```

---

## API Endpointy

| Metoda | Endpoint | Popis |
|--------|----------|-------|
| POST | `/api/auth/google` | Google Sign-In |
| POST | `/api/auth/apple` | Apple Sign-In |
| GET | `/api/auth/me` | Aktuální uživatel |
| GET | `/api/teams` | Seznam týmů |
| POST | `/api/teams` | Registrace týmu |
| POST | `/api/teams/join/:code` | Připojení přes kód |
| GET | `/api/players` | Seznam hráčů |
| POST | `/api/players` | Registrace hráče |
| GET | `/api/matches` | Zápasy (filtrovatelné) |
| POST | `/api/matches/:id/events` | Přidání gólu/trestu |
| GET | `/api/referees` | Rozhodčí |
| POST | `/api/referees` | Onboarding rozhodčího |
| PUT | `/api/referees/:id/approve` | Schválení (supervisor) |
| POST | `/api/payments/player-license` | Platba licence (Stripe) |
| POST | `/api/payments/home-fee` | Poplatek za domácí zápas |
| POST | `/api/payments/webhook` | Stripe webhook |
| GET | `/api/stats/table` | Ligová tabulka |
| GET | `/api/stats/scorers` | Střelci |
| GET | `/api/stats/mvp` | MVP tabulka |
| GET | `/api/supervisor/dashboard` | Supervisor přehled |
| GET | `/api/supervisor/referees` | Čekající rozhodčí |
| GET | `/health` | Health check |
