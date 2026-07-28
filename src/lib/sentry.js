/**
 * Sentry error monitoring – inicializace
 * DSN nastavit v Railway env: SENTRY_DSN=https://xxx@oXXX.ingest.sentry.io/XXX
 */
const Sentry = require('@sentry/node');

function initSentry() {
  if (!process.env.SENTRY_DSN) return; // Sentry vypnuto pokud není DSN

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    // Ignoruj běžné 4xx chyby (nejsou to bugy serveru)
    ignoreErrors: [
      'Not found',
      'Unauthorized',
      'Forbidden',
    ],
    beforeSend(event, hint) {
      const status = hint?.originalException?.status || hint?.originalException?.statusCode;
      if (status && status < 500) return null; // nevysílat 4xx
      return event;
    },
  });

  console.log('[Sentry] Inicializováno –', process.env.NODE_ENV);
}

module.exports = { Sentry, initSentry };
