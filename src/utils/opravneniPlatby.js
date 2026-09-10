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
 *   - balíček zápasů         → hráč, kterému balíček patří
 *   - pokuta za kontumaci    → vedoucí potrestaného týmu
 *   - košík                  → ten, kdo si ho složil
 *
 * Poplatek za domácí zápas (`home-fee`) tu byl do 9. 9. 2026. Zápasy dnes
 * platí hráči v balíčku, takže ten typ zmizel — a `smiKPlatbe` ho vrací jako
 * neznámý, což volajícímu skončí čistou čtyřstovkou místo pádu v QR kódu.
 */

const prisma = require('../lib/prisma');
const { isSupervisorUser } = require('../middleware/auth');

const TYPY_HRAC = ['player-license', 'super-license'];
const TYPY_TYM  = ['team-reg'];
const TYPY_BALICEK = ['match-pack'];
const TYPY_POKUTA  = ['fine'];
const TYPY_KOSIK   = ['cart'];

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

  if (TYPY_POKUTA.includes(type)) {
    const teamIds = (user.manager ?? []).map(m => m.teamId);
    if (teamIds.length === 0) return false;
    const pokuta = await prisma.fine.findUnique({
      where:  { id },
      select: { teamId: true },
    });
    // Pokutu platí vedoucí potrestaného týmu. Soupeři do ní nic není.
    return !!pokuta && teamIds.includes(pokuta.teamId);
  }

  if (TYPY_KOSIK.includes(type)) {
    // Košík patří tomu, kdo ho složil. I když jsou v něm položky za jiné
    // hráče, platí ho on — a jen on k němu smí dostat VS a QR kód.
    const cart = await prisma.cart.findUnique({ where: { id }, select: { userId: true } });
    return !!cart && cart.userId === user.id;
  }

  if (TYPY_BALICEK.includes(type)) {
    if (!user.player?.id) return false;
    const pack = await prisma.matchPack.findUnique({
      where:  { id },
      select: { playerId: true },
    });
    // Balíček patří hráči, ne týmu — cizí si ho nezobrazí ani vedoucí.
    return !!pack && pack.playerId === user.player.id;
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

module.exports = {
  smiKPlatbe, overPlatbu,
  TYPY_HRAC, TYPY_TYM, TYPY_BALICEK, TYPY_POKUTA, TYPY_KOSIK,
};
