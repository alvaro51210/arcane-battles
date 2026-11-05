/* Shared deterministic card catalogue. Loaded by both browser and server. */
(function (root) {
  'use strict';

  const TRIBES = ['dragon', 'beast', 'elemental', 'mech', 'demon', 'pirate', 'undead', 'none'];
  const RARITIES = ['common', 'rare', 'epic', 'legendary'];
  const SPELL_EFFECTS = ['damage_all', 'heal_hero', 'draw_card', 'buff_minions', 'single_damage'];
  const PREFIXES = ['Arcano', 'Ancestral', 'Infernal', 'Celestial', 'Sombrío', 'Gélido', 'Titánico', 'Venenoso', 'Volcánico', 'Espectral', 'Rúnico', 'Caótico', 'Sagrado', 'Maldito', 'Abisal'];
  const NOUNS = ['Dragón', 'Guerrero', 'Devorador', 'Elemental', 'Gólem', 'Asesino', 'Hechicero', 'Lich', 'Fénix', 'Demonio', 'Guardián', 'Titán', 'Cazador', 'Señor de la Guerra', 'Avatar'];

  const SPELL_DESCRIPTIONS = {
    damage_all: 'Inflige 2 de daño al héroe enemigo y a todos sus esbirros.',
    heal_hero: 'Restaura 4 de salud a tu héroe.',
    draw_card: 'Roba 2 cartas.',
    buff_minions: 'Tus esbirros obtienen +1/+1.',
    single_damage: 'Inflige 3 de daño al objetivo enemigo más débil; respeta Provocar.'
  };

  const CARD_DATABASE = [];
  for (let i = 0; i < 500; i += 1) {
    const isSpell = i % 7 === 0;
    const mana = Math.min(10, Math.floor(i / 50));
    const rarity = RARITIES[i % RARITIES.length];
    const tribe = isSpell ? 'spell' : TRIBES[i % TRIBES.length];
    const battlecry = isSpell ? null : (i % 5 === 0 ? 'deal_damage_2' : (i % 8 === 0 ? 'heal_hero_4' : null));
    const spellEffect = isSpell ? SPELL_EFFECTS[i % SPELL_EFFECTS.length] : null;
    const card = {
      id: i,
      name: `${PREFIXES[i % PREFIXES.length]} ${NOUNS[(i + 3) % NOUNS.length]} #${i + 1}`,
      mana,
      type: isSpell ? 'spell' : 'minion',
      tribe,
      rarity,
      attack: isSpell ? 0 : Math.max(1, mana + (i % 3)),
      health: isSpell ? 0 : Math.max(1, mana + ((i + 2) % 4) + 1),
      taunt: !isSpell && i % 6 === 0,
      charge: !isSpell && i % 9 === 0,
      divineShield: !isSpell && i % 11 === 0,
      battlecry,
      spellEffect,
      icon: isSpell ? 'fa-wand-magic-sparkles' : (tribe === 'dragon' ? 'fa-dragon' : 'fa-paw')
    };

    const description = [];
    if (card.taunt) description.push('Provocar.');
    if (card.charge) description.push('Carga.');
    if (card.divineShield) description.push('Escudo divino.');
    if (battlecry === 'deal_damage_2') description.push('Grito de batalla: inflige 2 de daño.');
    if (battlecry === 'heal_hero_4') description.push('Grito de batalla: restaura 4 de salud a tu héroe.');
    if (spellEffect) description.push(SPELL_DESCRIPTIONS[spellEffect]);
    card.description = description.join(' ');
    CARD_DATABASE.push(Object.freeze(card));
  }

  const api = Object.freeze({ CARD_DATABASE, SPELL_DESCRIPTIONS, DEFAULT_DECK: Object.freeze(Array.from({ length: 30 }, (_, i) => i)) });
  root.ArcaneCards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
