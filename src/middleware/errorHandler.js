// Centrální error handler – musí být posledním middleware v Express
function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err);

  // Prisma known errors
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Záznam již existuje (porušení unikátního klíče)' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Záznam nenalezen' });
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Soubor je příliš velký (max. 5 MB)' });
  }

  // Stripe errors
  if (err.type && err.type.startsWith('Stripe')) {
    return res.status(402).json({ error: err.message });
  }

  // Default
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Interní chyba serveru' });
}

module.exports = errorHandler;
