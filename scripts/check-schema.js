#!/usr/bin/env node
/**
 * Rychlá kontrola prisma/schema.prisma bez stahování Prisma enginů.
 *
 * Vzniklo poté, co tři nasazení po sobě spadla na `prisma generate` a chyba
 * se ukázala až v build logu na Railway. Tohle je pojistka, která ty dvě
 * třídy chyb odchytí dřív, než se něco pushne:
 *
 *   1. Blokové komentáře. Prisma zná jen `//` a `///` — `/* ... *\/` je
 *      syntaktická chyba, i když v editoru vypadá nevinně.
 *   2. Relace bez protistrany. Každé relační pole musí mít odpovídající
 *      pole na druhém modelu, jinak `prisma generate` skončí chybou.
 *
 * Použití: node scripts/check-schema.js [cesta]
 */

const fs   = require('fs');
const path = require('path');

const cesta = process.argv[2] ?? path.join(__dirname, '..', 'prisma', 'schema.prisma');
const text  = fs.readFileSync(cesta, 'utf8');
const radky = text.split('\n');

const chyby = [];

// ── 1. Blokové komentáře ────────────────────────────────────────────────────
radky.forEach((r, i) => {
  const s = r.trim();
  if (s.startsWith('/*') || (s.startsWith('*') && !s.startsWith('*/') === false)) {
    chyby.push(`řádek ${i + 1}: blokový komentář — Prisma zná jen // a ///`);
  } else if (s.startsWith('*') && !s.startsWith('**')) {
    chyby.push(`řádek ${i + 1}: pokračování blokového komentáře — použij ///`);
  } else if (s.includes('*/')) {
    chyby.push(`řádek ${i + 1}: konec blokového komentáře — použij ///`);
  }
});

// ── 2. Relace bez protistrany ───────────────────────────────────────────────
const modely = {};
let aktualni = null;

for (let i = 0; i < radky.length; i += 1) {
  const s = radky[i].trim();
  if (s === '' || s.startsWith('//')) continue;

  let m = s.match(/^model\s+(\w+)\s*\{/);
  if (m) { aktualni = m[1]; modely[aktualni] = { name: aktualni, radek: i + 1, pole: [] }; continue; }
  if (/^enum\s+\w+\s*\{/.test(s)) { aktualni = null; continue; }
  if (s === '}') { aktualni = null; continue; }
  if (!aktualni || s.startsWith('@@')) continue;

  const f = s.match(/^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/);
  if (!f) continue;
  modely[aktualni].pole.push({
    jmeno: f[1], typ: f[2], list: !!f[3], zbytek: f[5] ?? '', radek: i + 1,
  });
}

const jmena = new Set(Object.keys(modely));

for (const model of Object.values(modely)) {
  const videna = new Set();

  for (const p of model.pole) {
    if (videna.has(p.jmeno)) {
      chyby.push(`řádek ${p.radek}: ${model.name}.${p.jmeno} je definované dvakrát`);
    }
    videna.add(p.jmeno);

    if (!jmena.has(p.typ)) continue; // skalár nebo enum

    const nazev = (p.zbytek.match(/@relation\(\s*"([^"]+)"/) || [])[1] ?? null;
    const protejsi = modely[p.typ].pole.filter(q => {
      if (q.typ !== model.name) return false;
      const jeho = (q.zbytek.match(/@relation\(\s*"([^"]+)"/) || [])[1] ?? null;
      return jeho === nazev;
    });

    if (protejsi.length === 0) {
      chyby.push(
        `řádek ${p.radek}: ${model.name}.${p.jmeno} (${p.typ}${p.list ? '[]' : ''})`
        + ` nemá protistranu na modelu ${p.typ}`
        + (nazev ? ` pro relaci "${nazev}"` : ''),
      );
    } else if (protejsi.length > 1 && !nazev) {
      chyby.push(
        `řádek ${p.radek}: ${model.name}.${p.jmeno} — na ${p.typ} je víc možných protistran,`
        + ' relace potřebuje pojmenování',
      );
    }
  }
}

// ── Výsledek ────────────────────────────────────────────────────────────────
if (chyby.length === 0) {
  console.log(`OK – schema.prisma: ${Object.keys(modely).length} modelů, žádné nálezy`);
  process.exit(0);
}

console.error(`Schéma má ${chyby.length} ${chyby.length === 1 ? 'problém' : 'problémů'}:`);
for (const c of chyby) console.error('  ✘ ' + c);
console.error('\nTohle by shodilo `prisma generate` při nasazení.');
process.exit(1);
