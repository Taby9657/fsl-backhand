/**
 * Vytáhne ze `schema.prisma` názvy polí jednotlivých modelů.
 *
 * Vzniklo 21. 9. 2026 po tom, co první reálná platba ligy (800 Kč) spadla na
 * `Unknown argument \`method\`` — PlayerPayment ten sloupec nemá, licence má
 * `licMethod`. `test:kosik` prošel, protože mock databáze bere jakýkoli
 * název pole. Mock si teď přes tenhle modul ověří, že zapisuje do sloupců,
 * které ve schématu opravdu jsou.
 *
 * Čte se text schématu, ne vygenerovaný klient — kontrola tím funguje
 * i bez `prisma generate` a bez enginů, stejně jako `check-schema.js`.
 */
const fs   = require('fs');
const path = require('path');

function poleModelu(cesta = path.join(__dirname, '..', '..', 'prisma', 'schema.prisma')) {
  const text   = fs.readFileSync(cesta, 'utf8');
  const modely = {};
  let aktualni = null;

  for (const radek of text.split('\n')) {
    const s = radek.trim();
    if (s.startsWith('//')) continue;

    const zacatek = s.match(/^model\s+(\w+)\s*\{/);
    if (zacatek) { aktualni = zacatek[1]; modely[aktualni] = new Set(); continue; }

    if (!aktualni) continue;
    if (s === '}') { aktualni = null; continue; }
    if (s.startsWith('@@') || s === '') continue;

    const pole = s.match(/^(\w+)\s+\S/);
    if (pole) modely[aktualni].add(pole[1]);
  }

  return modely;
}

/**
 * Hlídač pro mock databáze: vrátí funkci, která shodí test, jakmile zápis
 * míří na pole, které model nemá. Hlášku drží co nejblíž té Prismině, aby
 * se podle testu dala chyba poznat i v produkčním logu.
 */
function hlidacPoli(cesta) {
  const modely = poleModelu(cesta);

  return function over(model, data = {}) {
    const nazev = model.charAt(0).toUpperCase() + model.slice(1);
    const zname = modely[nazev];
    if (!zname) return; // model, který se ve schématu nejmenuje stejně — nehlídáme

    for (const klic of Object.keys(data)) {
      if (!zname.has(klic)) {
        throw new Error(
          `Unknown argument \`${klic}\` na modelu ${nazev}. ` +
          `Pole ve schématu: ${[...zname].join(', ')}`
        );
      }
    }
  };
}

module.exports = { poleModelu, hlidacPoli };
