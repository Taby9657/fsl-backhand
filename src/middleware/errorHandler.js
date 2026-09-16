const { LIMIT_OBRAZEK, LIMIT_VIDEO } = require('../utils/fileUpload');

const MB = (bajtu) => Math.round(bajtu / 1024 / 1024);

/**
 * Hláška o moc velkém souboru — psaná pro člověka, ne pro vývojáře.
 *
 * Do 16. 9. 2026 tu stálo natvrdo „Soubor je příliš velký (max. 5 MB)".
 * Pět megabajtů ale platí jen pro obrázky; video smí být mnohem větší.
 * Hráč, který chtěl do draftu poslat sestřih, si tak přečetl limit, který
 * se ho vůbec netýkal, a rozumně z toho usoudil, že video nahrát nejde.
 *
 * Proto se hláška **skládá z limitu, který doopravdy platil**, pozná se
 * podle názvu pole (`video` × `photo` / `logo`) a **říká, co s tím udělat**.
 * Samotné číslo nikomu nepomůže: kdo neví, kolik má jeho video megabajtů,
 * se z „max. 500 MB" nedozví nic použitelného.
 */
function hlaskaOVelikosti(pole) {
  if (pole === 'video') {
    return `Tohle video je moc velké. Zkrať ho v telefonu na pár nejlepších `
      + `vteřin a zkus to znovu — kratší sestřih si stejně spíš někdo pustí. `
      + `Vejde se video zhruba do ${MB(LIMIT_VIDEO)} MB.`;
  }
  return `Tenhle obrázek je moc velký. Zkus ho v telefonu zmenšit nebo vyber `
    + `jiný — vejde se zhruba do ${MB(LIMIT_OBRAZEK)} MB.`;
}

/** Odmítl soubor Cloudinary sám? Jejich hláška je anglicky a pro laika nečitelná. */
function jeVelikostOdCloudinary(err) {
  return /file size too large|maximum is/i.test(String(err?.message ?? ''));
}

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
    return res.status(413).json({ error: hlaskaOVelikosti(err.field) });
  }

  // Cloudinary má vlastní strop, na který náš limit nedosáhne — na bezplatném
  // tarifu odmítne video nad 100 MB sám. Bez tohohle překladu by se uživateli
  // ukázalo anglické „File size too large. Got 250000000. Maximum is 104857600."
  if (jeVelikostOdCloudinary(err)) {
    return res.status(413).json({
      error: 'Tohle video se nepodařilo uložit, je moc velké. Zkrať ho v telefonu '
           + 'na pár nejlepších vteřin a zkus to znovu.',
    });
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
