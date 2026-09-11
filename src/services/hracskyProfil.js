/**
 * Hráčský profil vedoucího.
 *
 * Vedoucí zakládá tým, ale peníze tečou odjinud: registrace týmu je jediná
 * položka, která visí na týmu. Licence i balíčky startů visí na **hráčském
 * profilu**. Dokud ho vedoucí neměl, končila každá jeho platba balíčku na
 * „Hráčský profil nenalezen" a jedinou cestou ven bylo zaregistrovat se
 * vlastním pozvánkovým kódem do vlastního týmu — což nikdo neuhodne.
 *
 * Proto profil vzniká rovnou s týmem. Vedoucí je v naprosté většině případů
 * taky hráč, takže je to i věcně správně: na soupisce být má.
 *
 * Údaje se berou z registračního formuláře (`manager` v těle požadavku).
 * Starší verze aplikace je neposílají, proto je tu záložní odvození z e-mailu
 * — profil se založí vždycky, jméno si vedoucí opraví v profilu.
 */

const prisma = require('../lib/prisma');
const vekSvc = require('../utils/vek');

const VYCHOZI_POST = 'Útočník';

/**
 * Pokus o jméno z e-mailu: `j.novak96@…` → „J. Novák" se nedá uhodnout,
 * ale „J Novak" je pořád k poznání líp než „Vedoucí".
 *
 * @returns {{firstName: string, lastName: string}|null}
 */
function jmenoZEmailu(email) {
  const local = String(email ?? '').split('@')[0] ?? '';
  // Číslice a tečky ven; „j.novak96" → ["j", "novak"].
  const casti = local.split(/[^A-Za-zÁ-Žá-ž]+/).filter(Boolean);
  if (casti.length < 2) return null;

  const velke = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return {
    firstName: velke(casti[0]),
    lastName:  velke(casti[casti.length - 1]),
  };
}

/** Nejnižší volné číslo dresu v týmu. Nula je platný dres, začínáme od ní. */
async function volneCislo(tx, teamId, preferovane) {
  const obsazena = new Set(
    (await tx.player.findMany({ where: { teamId }, select: { jersey: true } })).map(p => p.jersey),
  );
  const chtene = Number(preferovane);
  if (Number.isInteger(chtene) && chtene >= 0 && chtene <= 99 && !obsazena.has(chtene)) {
    return chtene;
  }
  for (let i = 0; i <= 99; i++) if (!obsazena.has(i)) return i;
  return null; // 100 hráčů v týmu; ať se to raději ozve, než aby to spadlo na unikátu
}

/**
 * Založí (nebo dorovná) hráčský profil vedoucího.
 *
 * Nikdy nepřepisuje profil, který už existuje — jen ho, když nemá tým,
 * připojí k nově založenému. Vrací `{ player, vytvoren, duvod }`;
 * `player === null` znamená, že profil vzniknout nemohl, a je na volajícím,
 * jestli to shodí celou registraci (nemělo by).
 *
 * @param {object} tx      Prisma klient nebo transakce
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.email
 * @param {string} p.teamId
 * @param {string} p.teamName  Do záložního jména, když e-mail nic nedá
 * @param {string} p.season    Sezóna pro PlayerPayment (licenci)
 * @param {object} [p.udaje]   { firstName, lastName, jersey, position, birthdate, phone }
 */
async function zalozProfilVedouciho(tx, { userId, email, teamId, teamName, season, udaje = {} }) {
  const stavajici = await tx.player.findUnique({ where: { userId } });

  if (stavajici) {
    // Profil bez týmu je typicky hráč, který tým opustil a teď si zakládá
    // vlastní. Připojíme ho, ať nemá dva životy.
    if (!stavajici.teamId) {
      const jersey = await volneCislo(tx, teamId, stavajici.jersey);
      if (jersey === null) return { player: stavajici, vytvoren: false, duvod: 'NO_JERSEY' };
      const player = await tx.player.update({
        where: { id: stavajici.id },
        data:  { teamId, jersey },
      });
      return { player, vytvoren: false, duvod: 'PRIPOJEN' };
    }
    return { player: stavajici, vytvoren: false, duvod: 'UZ_EXISTUJE' };
  }

  const jmeno = {
    firstName: String(udaje.firstName ?? '').trim(),
    lastName:  String(udaje.lastName ?? '').trim(),
  };
  if (!jmeno.firstName || !jmeno.lastName) {
    const zEmailu = jmenoZEmailu(email);
    // Poslední záchrana: profil musí vzniknout, i když se jméno odvodit nedá.
    // „Vedoucí <tým>" je na soupisce vidět a říká si o opravu.
    jmeno.firstName = zEmailu?.firstName || 'Vedoucí';
    jmeno.lastName  = zEmailu?.lastName  || (teamName || 'FSL');
  }

  const jersey = await volneCislo(tx, teamId, udaje.jersey);
  if (jersey === null) return { player: null, vytvoren: false, duvod: 'NO_JERSEY' };

  const player = await tx.player.create({
    data: {
      userId,
      teamId,
      firstName: jmeno.firstName,
      lastName:  jmeno.lastName,
      jersey,
      position:  String(udaje.position ?? '').trim() || VYCHOZI_POST,
      // Plnoletost si ohlídala routa (`POST /teams`), tady se jen uloží, co
      // projde kontrolou. Bez data se sem dostane jen dodatečné doplňování
      // profilů (`scripts/doplnit-profily-vedoucich.js`) — tam je prázdné
      // datum lepší než žádný profil.
      birthdate: vekSvc.zkontrolujDatumNarozeni(udaje.birthdate).datum,
      phone:     udaje.phone ? String(udaje.phone).trim() : null,
      // Licence na sezónu, do které se tým hlásí — stejně jako u běžného hráče
      payment:   { create: season ? { season } : {} },
    },
  });

  return { player, vytvoren: true, duvod: 'VYTVOREN' };
}

module.exports = { zalozProfilVedouciho, jmenoZEmailu, volneCislo, VYCHOZI_POST };
