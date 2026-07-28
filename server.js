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
const playerRoutes       = require('./src/routes/players');
const matchRoutes        = require('./src/routes/matches');
const refereeRoutes      = require('./src/routes/referees');
const paymentRoutes      = require('./src/routes/payments');
const statsRoutes        = require('./src/routes/stats');
const supervisorRoutes   = require('./src/routes/supervisor');
const notifRoutes        = require('./src/routes/notifications');
const highlightRoutes    = require('./src/routes/highlights');
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

// ==================== API ROUTES ====================

app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/teams',       teamRoutes);
app.use('/api/players',     playerRoutes);
app.use('/api/matches',     matchRoutes);
app.use('/api/referees',    refereeRoutes);
app.use('/api/payments',    paymentRoutes);
app.use('/api/stats',       statsRoutes);
app.use('/api/supervisor',  supervisorRoutes);
app.use('/api/notifications', notifRoutes);
app.use('/api/highlights',   highlightRoutes);
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

start();
