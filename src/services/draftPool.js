/**
 * Draft pool — jedno místo, kde hráč bez týmu vzniká jako nabídnutý.
 *
 * Do 15. 9. 2026 byly hráčský profil a draft profil dva kroky: registrace
 * založila `Player` s `teamId: null` a slíbila „po vyplnění se nabídneš
 * v draftu“, ale `DraftProfile` nikdo nezaložil. Hráč skončil na seznamu
 * cizích lidí, v poolu nebyl a nic mu neřeklo proč. Slib se plní tady —
 * registrace volá `zapisDoPoolu()` rovnou, `POST /draft/profile` už jen
 * doplňuje, co o sobě hráč napíše.
 *
 * **Kdo tuhle funkci obejde a napíše si vlastní `draftProfile.create`,
 * rozdělí ten krok zpátky na dva** — a notifikace vedoucím se buď ztratí,
 * nebo přijde dvakrát.
 */

const prisma = require('../lib/prisma');
const { createNotifications } = require('../routes/notifications');

/**
 * Zapíše hráče do draft poolu (nebo ho tam vrátí) a upozorní vedoucí.
 *
 * @param {object} player  hráč — musí mít `id`, `firstName`, `lastName`
 * @param {object} [data]  `bio`, `pubSkill`, `position` z formuláře
 * @returns {Promise<object>} draft profil včetně videí
 */
async function zapisDoPoolu(player, data = {}) {
  const { bio, pubSkill, position } = data;

  // Pozice se bere z přihlášky, když ji formulář draftu neposlal. Bez toho
  // se brankář z registrace nabízí jako hráč do pole a vedoucí to pozná
  // až u zápasu.
  const post = position ?? player.position ?? null;

  const existujici = await prisma.draftProfile.findUnique({
    where: { playerId: player.id },
  });

  const profil = await prisma.draftProfile.upsert({
    where:  { playerId: player.id },
    create: {
      playerId: player.id,
      bio:      bio || null,
      pubSkill: pubSkill || null,
      position: post,
      isActive: true,
    },
    update: {
      // `undefined` = pole se nemění. Registrace posílá jen pozici a nesmí
      // přepsat text, který si hráč napsal dřív.
      ...(bio      !== undefined && { bio: bio || null }),
      ...(pubSkill !== undefined && { pubSkill: pubSkill || null }),
      ...(post     !== null      && { position: post }),
      isActive:  true,
      updatedAt: new Date(),
    },
    include: { videos: true },
  });

  // Vedoucí se dozví o každém vstupu do poolu, ne jen o prvním v životě
  // profilu. Řádek `DraftProfile` existuje navždy, takže původní podmínka
  // „jen při vzniku“ znamenala, že vracející se hráč byl v poolu potichu.
  const vracejiciSe = !!existujici;
  if (!existujici || existujici.isActive === false) {
    const managers = await prisma.manager.findMany({ select: { userId: true } });
    if (managers.length) {
      const jmeno = `${player.firstName} ${player.lastName}`;
      await createNotifications(managers.map(m => ({
        userId: m.userId,
        title:  vracejiciSe ? 'Volný hráč je zpátky v draftu' : 'Nový hráč v draftu',
        body:   vracejiciSe
          ? `${jmeno} je znovu k dispozici v draft poolu`
          : `${jmeno} se přidal(a) do draft poolu`,
        screen: 'draft',
      })));
    }
  }

  return profil;
}

/**
 * Odebere hráče z poolu a zruší jeho čekající nabídky.
 *
 * **Pořadí není libovolné** — nabídky se ruší první. Kdyby se profil jen
 * deaktivoval, cron by po vypršení okna hráče stejně někam zařadil.
 */
async function odeberZPoolu(playerId) {
  const profil = await prisma.draftProfile.findUnique({ where: { playerId } });
  if (!profil) return null;

  await prisma.draftOffer.updateMany({
    where: { profileId: profil.id, status: 'PENDING' },
    data:  { status: 'EXPIRED' },
  });
  return prisma.draftProfile.update({
    where: { id: profil.id },
    data:  { isActive: false },
  });
}

module.exports = { zapisDoPoolu, odeberZPoolu };
