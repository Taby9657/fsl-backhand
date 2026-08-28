require('dotenv').config();

const { initSentry, Sentry } = require('./src/lib/sentry');
initSentry(); // musí být první, před express

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const prismaLib = require('./src/lib/prisma');

const { bankSync }       = require('./src/services/bankSync');
const authRoutes         = require('./src/routes/auth');
const teamRoutes         = require('./src/routes/teams');
const leagueRoutes       = require('./src/routes/leagues');
const playerRoutes       = require('./src/routes/players');
const matchRoutes        = require('./src/routes/matches');
const refereeRoutes      = require('./src/routes/referees');
const paymentRoutes      = require('./src/routes/payments');
const statsRoutes        = require('./src/routes/stats');
const supervisorRoutes   = require('./src/routes/supervisor');
const notifRoutes        = require('./src/routes/notifications');
const highlightRoutes    = require('./src/routes/highlights');
const seasonRoutes = require('./src/routes/seasons');
const licenceRoutes = require('./src/routes/licence');
const draftRoutes        = require('./src/routes/draft');
const { processExpiredWindows } = require('./src/routes/draft');
const searchRoutes       = require('./src/routes/search');
const { requireAuth }    = require('./src/middleware/auth');
const errorHandler       = require('./src/middleware/errorHandler');

const app    = express();
const prisma = prismaLib;
const PORT   = process.env.PORT || 3000;

// ==================== BEZPEČNOST ====================

app.set('trust proxy', 1); // Potřebné pro Railway (proxy)

app.use(helmet());
// SEC-02: CORS — v produkci vyžaduje CLIENT_URL, v dev povolí vše
const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map(s => s.trim())
  : null; // null = žádný webový klient (mobile app komunikuje přes HTTPS přímo)

app.use(cors({
  origin: allowedOrigins ?? (process.env.NODE_ENV !== 'production' ? '*' : false),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Globální rate limiter
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max:      200,
  message:  { error: 'Příliš mnoho požadavků, zkuste to za chvíli' },
}));

// Přísnější limiter pro auth endpointy
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hodina
  max:      20,
  message:  { error: 'Příliš mnoho pokusů o přihlášení' },
});

// ==================== PARSOVÁNÍ ====================

// Stripe webhook MUSÍ dostat raw body – mount PŘED express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ==================== NAVRAT ZE STRIPE ====================
// Stripe umi presmerovat jen na http(s), ne na fsl:// – proto tyhle dve
// stranky. Az bude nasazeny web na fslleague.cz, staci prepnout PUBLIC_WEB_URL
// na nej a tyhle routy uz se nepouziji.

function returnPage({ title, message, tone }) {
  const color = tone === 'ok' ? '#3FBF7F' : '#C9A140';
  return `<!doctype html>
<html lang="cs"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · FSL</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0D0120; color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { max-width:340px; padding:32px 24px; text-align:center; }
  .dot { width:64px; height:64px; margin:0 auto 20px; border-radius:50%;
         background:${color}22; border:2px solid ${color}; display:flex; align-items:center; justify-content:center;
         font-size:30px; color:${color}; }
  h1 { font-size:22px; margin:0 0 10px; }
  p  { font-size:15px; line-height:1.5; color:#A79EB5; margin:0 0 28px; }
  a  { display:block; padding:14px 20px; border-radius:12px; background:${color}; color:#0D0120;
       font-weight:700; text-decoration:none; }
</style>
</head><body>
  <div class="card">
    <div class="dot">${tone === 'ok' ? '&#10003;' : '&#8635;'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="fsl://payments">Zpět do aplikace</a>
  </div>
  <script>setTimeout(function(){ location.href = 'fsl://payments'; }, 1200);</script>
</body></html>`;
}

app.get('/payment-success', (req, res) => {
  res.type('html').send(returnPage({
    tone: 'ok',
    title: 'Zaplaceno',
    message: 'Díky! Platbu jsme přijali. V aplikaci se stav aktualizuje během chvilky.',
  }));
});

app.get('/platby', (req, res) => {
  res.type('html').send(returnPage({
    tone: 'warn',
    title: 'Platba zrušena',
    message: 'Nic jsme ti nestrhli. Zkusit to můžeš znovu v aplikaci – kartou, přes peněženku nebo převodem.',
  }));
});

// ==================== API ROUTES ====================

app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/teams',       teamRoutes);
app.use('/api/leagues',     leagueRoutes);
app.use('/api/players',     playerRoutes);
app.use('/api/matches',     matchRoutes);
app.use('/api/referees',    refereeRoutes);
app.use('/api/payments',    paymentRoutes);
app.use('/api/stats',       statsRoutes);
app.use('/api/supervisor',  supervisorRoutes);
app.use('/api/notifications', notifRoutes);
app.use('/api/highlights',   highlightRoutes);
app.use('/api/seasons',      seasonRoutes);
app.use('/api/licence',      licenceRoutes);
app.use('/api/draft',        draftRoutes);
app.use('/api/search',       searchRoutes);

// POST /api/requests – žádosti od běžných uživatelů (vedoucí, hráči) supervisorovi
// POZOR: musí být mimo /api/supervisor/* který vyžaduje supervisor roli
app.post('/api/requests', requireAuth, async (req, res, next) => {
  try {
    const { type, teamId, matchId, body } = req.body;
    if (!type || !body) return res.status(400).json({ error: 'Chybí typ nebo popis žádosti' });

    const request = await prisma.supervisorRequest.create({
      data: { type, userId: req.user.id, teamId: teamId || null, matchId: matchId || null, body },
      include: { user: { select: { id: true, email: true } } },
    });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

// ==================== 404 ====================

app.use((req, res) => res.status(404).json({ error: 'Endpoint nenalezen' }));

// ==================== ERROR HANDLER ====================

// Sentry zachytí 5xx před naším handlerem
if (process.env.SENTRY_DSN) app.use(Sentry.expressErrorHandler());
app.use(errorHandler);

// ==================== START ====================

async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Databáze připojena');

    app.listen(PORT, () => {
      console.log(`🚀 FSL API běží na portu ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });
  } catch (err) {
    console.error('❌ Chyba při startu:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

// ==================== DRAFT EXPIRED WINDOWS CRON ====================
// PERF-01: Spouští se každých 15 minut místo lazy volání při každém requestu
const { processDueTransitions } = require('./src/services/seasonTransition');

const DRAFT_CRON_INTERVAL = 15 * 60 * 1000; // 15 minut
async function runDraftExpiry() {
  try {
    await processExpiredWindows();
  } catch (err) {
    console.error('[Draft] Chyba při expiraci oken:', err.message);
  }
}
runDraftExpiry(); // hned při startu
setInterval(runDraftExpiry, DRAFT_CRON_INTERVAL);

// ==================== NAPLÁNOVANÝ PŘECHOD SEZÓNY ====================
// Kontroluje se každých 15 minut i hned po startu — přesnost na čtvrthodinu
// je pro přechod sezóny víc než dost.
const SEASON_CRON_INTERVAL = 15 * 60 * 1000;
async function runSeasonTransitions() {
  try {
    await processDueTransitions();
  } catch (err) {
    console.error('[Sezóna] Chyba při zpracování přechodů:', err.message);
  }
}
runSeasonTransitions();
setInterval(runSeasonTransitions, SEASON_CRON_INTERVAL);

// ==================== AUTOMATICKÉ PÁROVÁNÍ PLATEB ====================
// Spustí se každou noc ve 2:00 (pokud je FIO_API_TOKEN nastaven)
if (process.env.FIO_API_TOKEN && process.env.NODE_ENV === 'production') {
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hodin

  async function runBankSync() {
    try {
      console.log('[BankSync] Spouštím párování plateb...');
      const results = await bankSync(2); // posledních 48 hodin
      console.log(`[BankSync] Hotovo – spárováno: ${results.matched.length}, přeskočeno: ${results.skipped.length}, chyby: ${results.errors.length}`);
    } catch (err) {
      console.error('[BankSync] Chyba:', err.message);
    }
  }

  // První sync 2 minuty po startu, pak každých 24 hodin
  setTimeout(() => {
    runBankSync();
    setInterval(runBankSync, SYNC_INTERVAL_MS);
  }, 2 * 60 * 1000);
}

// ============ UPOMÍNKY NA POPLATEK ZA DOMÁCÍ ZÁPAS ============
// Poplatek je splatný do 48 h před výkopem. Bez upomínky se na to zapomíná
// a rozhodčí pak stojí na hale se zápasem, který nejde zahájit.
if (process.env.NODE_ENV === 'production') {
  const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hodin

  async function runHomeFeeReminders() {
    try {
      const now    = new Date();
      const in48h  = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const matches = await prismaLib.match.findMany({
        where: {
          status:            'UPCOMING',
          homeFeePaid:       false,
          homeFeeReminderAt: null,
          date:              { gte: now, lte: in48h },
        },
        include: {
          homeTeam: { select: { id: true, abbr: true } },
          awayTeam: { select: { abbr: true } },
        },
      });

      for (const match of matches) {
        const managers = await prismaLib.manager.findMany({
          where:  { teamId: match.homeTeamId },
          select: { userId: true },
        });
        const dateStr = new Date(match.date).toLocaleDateString('cs-CZ');
        for (const m of managers) {
          await notifRoutes.createNotification(
            m.userId,
            'Neuhrazený poplatek za domácí zápas',
            `${match.homeTeam.abbr} vs ${match.awayTeam.abbr} (${dateStr}) — poplatek 2 200 Kč je splatný do 48 h před výkopem. Bez úhrady nelze zápas zahájit.`,
            'payments',
          );
        }
        await prismaLib.match.update({
          where: { id: match.id },
          data:  { homeFeeReminderAt: new Date() },
        });
      }

      if (matches.length > 0) {
        console.log(`[HomeFee] Odesláno ${matches.length} upomínek na poplatek za domácí zápas.`);
      }
    } catch (err) {
      console.error('[HomeFee] Chyba při odesílání upomínek:', err.message);
    }
  }

  setTimeout(() => {
    runHomeFeeReminders();
    setInterval(runHomeFeeReminders, REMINDER_INTERVAL_MS);
  }, 4 * 60 * 1000);
}

// ==================== REKONCILIACE STRIPE ====================
// Doplněk k webhooku: kdyby některý nedorazil (deploy, výpadek sítě), tahle
// úloha se Stripe doptá na platby, které u nás visí jako nezaplacené.
if (process.env.NODE_ENV === 'production') {
  const { reconcileStripePayments } = require('./src/services/stripeSync');
  const STRIPE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hodin

  async function runStripeSync() {
    try {
      const results = await reconcileStripePayments();
      if (results.skipped) return;
      if (results.fixed.length > 0) {
        console.log(`[StripeSync] Dorovnáno ${results.fixed.length} plateb, které webhook minul:`, results.fixed);
      }
    } catch (err) {
      console.error('[StripeSync] Chyba:', err.message);
    }
  }

  setTimeout(() => {
    runStripeSync();
    setInterval(runStripeSync, STRIPE_SYNC_INTERVAL_MS);
  }, 3 * 60 * 1000);
}

start();
