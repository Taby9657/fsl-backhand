require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

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
const { requireAuth }    = require('./src/middleware/auth');
const errorHandler       = require('./src/middleware/errorHandler');

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

// ==================== BEZPEČNOST ====================

app.set('trust proxy', 1); // Potřebné pro Railway (proxy)

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
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

// POST /api/supervisor/requests – žádosti od vedoucích/hráčů (bez supervisor role)
app.post('/api/supervisor/requests', requireAuth, async (req, res, next) => {
  try {
    const { type, teamId, matchId, body } = req.body;
    if (!type || !body) return res.status(400).json({ error: 'Chybí typ nebo popis žádosti' });

    const request = await prisma.supervisorRequest.create({
      data: { type, teamId: teamId || null, matchId: matchId || null, body },
    });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

// ==================== 404 ====================

app.use((req, res) => res.status(404).json({ error: 'Endpoint nenalezen' }));

// ==================== ERROR HANDLER ====================

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
