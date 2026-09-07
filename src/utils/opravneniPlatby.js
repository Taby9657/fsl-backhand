/**
 * Kdo se smí ptát na QR kód a variabilní symbol konkrétní platby.
 *
 * Endpointy `/payments/qr/:type/:id` a `/payments/vs/...` měly jen
 * `requireAuth`, tedy stačilo být přihlášený jako kdokoli. Kdo znal cizí
 * playerId nebo teamId — a ta jsou vidět ve veřejném API — vytáhl si k němu
 * VS i částku. Ve výsledku šlo cizím jménem poslat platbu na cizí licenci,
 * nebo si jen zmapovat, kdo co dluží.
 *
 * Pravidlo je jednoduché: k platbě se dostane její vlastník a supervisor.
 *   - licence a superlicence → vlastní hráčský profil
 *   - registrace týmu        → vedoucí toho týmu
 *   - poplatek za zápas      → vedoucí domácího týmu
 */

const prisma = require('../lib/prisma');
const { isSupervisorUser } = require('../middleware/auth');

const TYPY_HRAC = ['player-license', 'super-license'];
const TYPY_TYM  = ['team-reg'];
const TYPY_ZAPAS = ['home-fee'];

/**
 * @returns {Promise<boolean|null>} true = smí, false = nesmí, null = neznámý typ
 */
async function smiKPlatbe(user, type, id) {
  if (!user || !id) return false;
  if (isSupervisorUser(user)) return true;

  if (TYPY_HRAC.includes(type)) {
    return user.player?.id === id;
  }

  if (TYPY_TYM.includes(type)) {
    return (user.manager ?? []).some(m => m.teamId === id);
  }

  if (TYPY_ZAPAS.includes(type)) {
    const teamIds = (user.manager ?? []).map(m => m.teamId);
    if (teamIds.length === 0) return false;
    const match = await prisma.match.findUnique({
      where:  { id },
      select: { homeTeamId: true },
    });
    // Poplatek platí domácí tým. Hostům ho ukazovat nemá smysl.
    return !!match && teamIds.includes(match.homeTeamId);
  }

  return null;
}

/**
 * Obal pro routy: odpoví 403/400 a vrátí false, když se nesmí pokračovat.
 */
async function overPlatbu(req, res, type, id) {
  const smi = await smiKPlatbe(req.user, type, id);
  if (smi === null) {
    res.status(400).json({ error: 'Neznámý typ platby' });
    return false;
  }
  if (!smi) {
    res.status(403).json({ error: 'K téhle platbě nemáš přístup' });
    return false;
  }
  return true;
}

module.exports = { smiKPlatbe, overPlatbu, TYPY_HRAC, TYPY_TYM, TYPY_ZAPAS };
