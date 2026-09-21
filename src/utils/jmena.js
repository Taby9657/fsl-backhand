/**
 * Oslovení jménem — velké písmeno a pátý pád.
 *
 * Jméno se do databáze ukládá tak, jak ho člověk napsal do přihlášky, takže
 * tam běžně leží „jan". Šablony e-mailů ho braly rovnou, a chodilo „Ahoj jan,"
 * — dvakrát špatně: malé písmeno a první pád místo pátého.
 *
 * **Pravidla nejsou úplná a ani být nemůžou** — čeština má u jmen výjimky,
 * které se z tvaru nepoznají (Dagmar je žena, Alexandr muž, obojí končí na
 * souhlásku). Proto platí: **co si pravidla nejsou jistá, nechají v prvním
 * pádě**. „Ahoj Dagmar," je nepěkné, „Ahoj Dagmaro," je chyba.
 */

/** Jména, která se v pátém pádě nemění — jinak by z nich pravidla udělala mužský tvar. */
const NEMENIT = new Set([
  'dagmar', 'ester', 'miriam', 'karin', 'ingrid', 'nikol', 'rút', 'ruth',
  'ráchel', 'rachel', 'abigail', 'sarah', 'carmen', 'doris', 'jasmin',
]);

/** Co pravidla netrefí. */
const VYJIMKY = {
  'lev':   'Lve',
  'pavol': 'Pavle',
  'karol': 'Karle',
};

const SAMOHLASKY = 'aeiouyáéíóúůýě';

/** „jan" → „Jan", „JAN" → „Jan", „anna-marie" → „Anna-Marie". */
function velkePismeno(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, pred, znak) => pred + znak.toUpperCase());
}

/**
 * Pátý pád křestního jména. Když si pravidlo není jisté, vrací první pád —
 * viz komentář nahoře.
 */
function vokativ(jmeno) {
  const j = velkePismeno(jmeno);
  if (!j) return '';

  const male = j.toLowerCase();
  if (NEMENIT.has(male)) return j;
  if (VYJIMKY[male]) return VYJIMKY[male];

  // Zakončení na samohlásku: -a se mění na -o (Jana → Jano, Honza → Honzo),
  // ostatní samohlásky se nemění (Lucie, Jiří, Ivo, René).
  if (/a$/i.test(j)) return `${j.slice(0, -1)}o`;
  if (new RegExp(`[${SAMOHLASKY}]$`, 'i').test(j)) return j;

  // -ek: vypadává e (Marek → Marku), u -něk měkne n (Zdeněk → Zdeňku).
  if (/něk$/i.test(j)) return `${j.slice(0, -3)}ňku`;
  if (/ek$/i.test(j))  return `${j.slice(0, -2)}ku`;

  // -el: po samohlásce se přidá i (Daniel → Danieli), po souhlásce vypadne
  // e (Pavel → Pavle).
  if (/el$/i.test(j)) {
    return new RegExp(`[${SAMOHLASKY}]el$`, 'i').test(j)
      ? `${j}i`
      : `${j.slice(0, -2)}le`;
  }

  // Měkké souhlásky a x: Tomáš → Tomáši, Ondřej → Ondřeji, Alex → Alexi.
  if (/[jšžčřcďťňx]$/i.test(j)) return `${j}i`;

  // k, g, h, ch: Dominik → Dominiku, Vojtěch → Vojtěchu.
  if (/(ch|[kgh])$/i.test(j)) return `${j}u`;

  // -r po souhlásce měkne (Petr → Petře), po samohlásce ne (Dalibor → Dalibore).
  if (/r$/i.test(j)) {
    return new RegExp(`[${SAMOHLASKY}]r$`, 'i').test(j)
      ? `${j}e`
      : `${j.slice(0, -1)}ře`;
  }

  // Ostatní tvrdé souhlásky: Jan → Jane, Jakub → Jakube.
  if (/[bdflmnpstvz]$/i.test(j)) return `${j}e`;

  return j;
}

/**
 * Celé oslovení do e-mailu. Bere **první slovo** — do políčka se občas napíše
 * i příjmení a „Ahoj Jane Nováku," by bylo divné.
 */
function osloveni(jmeno) {
  const prvni = String(jmeno ?? '').trim().split(/\s+/)[0];
  const tvar = vokativ(prvni);
  return tvar ? `Ahoj ${tvar},` : 'Ahoj,';
}

module.exports = { velkePismeno, vokativ, osloveni };
