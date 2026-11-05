/* Deterministic game rules shared by the browser and authoritative server. */
(function (root) {
  'use strict';

  const cardsApi = root.ArcaneCards || (typeof require === 'function' ? require('./cards.js') : null);
  if (!cardsApi) throw new Error('ArcaneCards must be loaded before ArcaneEngine.');
  const { CARD_DATABASE, DEFAULT_DECK } = cardsApi;
  const MAX_HAND = 7;
  const MAX_BOARD = 7;
  const MAX_MANA = 10;

  function uid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function shuffle(input) {
    const result = [...input];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function validateDeck(deck) {
    if (!Array.isArray(deck) || deck.length !== 30) return { valid: false, reason: 'El mazo debe contener exactamente 30 cartas.' };
    const counts = new Map();
    for (const id of deck) {
      if (!Number.isInteger(id) || id < 0 || id >= CARD_DATABASE.length) return { valid: false, reason: 'El mazo contiene una carta inexistente.' };
      const count = (counts.get(id) || 0) + 1;
      counts.set(id, count);
      const max = CARD_DATABASE[id].rarity === 'legendary' ? 1 : 2;
      if (count > max) return { valid: false, reason: `${CARD_DATABASE[id].name}: máximo ${max} copia(s).` };
    }
    return { valid: true, reason: '' };
  }

  function makePlayer(user, deck) {
    return {
      userId: user.id || null,
      username: user.username || 'Jugador',
      rating: Number.isFinite(user.rating) ? user.rating : 1000,
      hp: 30,
      armor: 0,
      mana: 0,
      maxMana: 0,
      tempMana: 0,
      hand: [],
      deck: shuffle(deck),
      deckCount: 30,
      board: [],
      fatigue: 0
    };
  }

  function drawCard(player) {
    if (player.deck.length === 0) {
      player.fatigue += 1;
      dealHeroDamage(player, player.fatigue);
      return { type: 'fatigue', amount: player.fatigue };
    }
    const cardId = player.deck.pop();
    player.deckCount = player.deck.length;
    if (player.hand.length >= MAX_HAND) return { type: 'burn', cardId };
    player.hand.push({ ...clone(CARD_DATABASE[cardId]), instanceId: uid() });
    return { type: 'draw', cardId };
  }

  function dealHeroDamage(player, amount) {
    let remaining = Math.max(0, Math.floor(amount));
    const absorbed = Math.min(player.armor, remaining);
    player.armor -= absorbed;
    remaining -= absorbed;
    player.hp = Math.max(0, player.hp - remaining);
  }

  function damageMinion(minion, amount) {
    if (minion.shieldActive && amount > 0) {
      minion.shieldActive = false;
      return;
    }
    minion.health -= amount;
  }

  function removeDead(player) {
    player.board = player.board.filter((minion) => minion.health > 0);
  }

  function lowestHealthTarget(player) {
    return [...player.board].sort((a, b) => a.health - b.health || a.attack - b.attack)[0] || null;
  }

  function enemyHasTaunt(enemy) {
    return enemy.board.some((minion) => minion.taunt);
  }

  function resolveBattlecry(card, owner, enemy) {
    if (card.battlecry === 'deal_damage_2') {
      const target = enemyHasTaunt(enemy) ? enemy.board.filter((m) => m.taunt).sort((a, b) => a.health - b.health)[0] : lowestHealthTarget(enemy);
      if (target) damageMinion(target, 2);
      else dealHeroDamage(enemy, 2);
    } else if (card.battlecry === 'heal_hero_4') {
      owner.hp = Math.min(30, owner.hp + 4);
    }
  }

  function resolveSpell(card, owner, enemy) {
    switch (card.spellEffect) {
      case 'damage_all':
        dealHeroDamage(enemy, 2);
        enemy.board.forEach((minion) => damageMinion(minion, 2));
        break;
      case 'heal_hero':
        owner.hp = Math.min(30, owner.hp + 4);
        break;
      case 'draw_card':
        drawCard(owner);
        drawCard(owner);
        break;
      case 'buff_minions':
        owner.board.forEach((minion) => {
          minion.attack += 1;
          minion.health += 1;
          minion.maxHealth += 1;
        });
        break;
      case 'single_damage': {
        const taunts = enemy.board.filter((minion) => minion.taunt);
        const target = (taunts.length ? taunts : enemy.board).sort((a, b) => a.health - b.health || a.attack - b.attack)[0];
        if (target) damageMinion(target, 3);
        else dealHeroDamage(enemy, 3);
        break;
      }
      default:
        break;
    }
    removeDead(owner);
    removeDead(enemy);
  }

  function beginTurn(match, seat, shouldDraw = true) {
    const player = match.players[seat];
    player.maxMana = Math.min(MAX_MANA, player.maxMana + 1);
    player.mana = player.maxMana;
    player.tempMana = 0;
    player.board.forEach((minion) => {
      minion.canAttack = !minion.isFrozen;
      minion.hasAttacked = false;
      minion.isFrozen = false;
    });
    match.turn = seat;
    if (shouldDraw) drawCard(player);
  }

  function createMatch(userA, userB, deckA, deckB, options = {}) {
    const validA = validateDeck(deckA);
    const validB = validateDeck(deckB);
    if (!validA.valid) throw new Error(`Mazo de ${userA.username}: ${validA.reason}`);
    if (!validB.valid) throw new Error(`Mazo de ${userB.username}: ${validB.reason}`);

    const players = {
      A: makePlayer(userA, deckA),
      B: makePlayer(userB, deckB)
    };
    for (const seat of ['A', 'B']) {
      for (let i = 0; i < 3; i += 1) drawCard(players[seat]);
    }

    const first = options.firstSeat === 'B' ? 'B' : (options.firstSeat === 'A' ? 'A' : (Math.random() < 0.5 ? 'A' : 'B'));
    const match = {
      id: options.id || uid(),
      mode: options.mode || 'casual',
      rated: options.rated === true,
      players,
      turn: first,
      turnNumber: 1,
      status: 'playing',
      winner: null,
      resultReason: null,
      createdAt: Date.now(),
      resultRecorded: false
    };
    beginTurn(match, first, false);
    return match;
  }

  function requireTurn(match, seat) {
    if (!match || match.status !== 'playing') throw new Error('La partida ya ha terminado.');
    if (match.turn !== seat) throw new Error('No es tu turno.');
  }

  function applyAction(match, seat, action) {
    if (!match || match.status !== 'playing') throw new Error('La partida ya ha terminado.');
    if (!action || typeof action.type !== 'string') throw new Error('Acción no válida.');
    if (action.type === 'concede') {
      const opponentSeat = seat === 'A' ? 'B' : 'A';
      match.status = 'ended';
      match.winner = opponentSeat;
      match.resultReason = 'concede';
      return match;
    }
    requireTurn(match, seat);
    const player = match.players[seat];
    const enemySeat = seat === 'A' ? 'B' : 'A';
    const enemy = match.players[enemySeat];

    if (action.type === 'play_card') {
      const index = action.index;
      if (!Number.isInteger(index) || index < 0 || index >= player.hand.length) throw new Error('Carta no válida.');
      const card = player.hand[index];
      if (card.mana > player.mana + player.tempMana) throw new Error('No tienes suficiente maná.');
      if (card.type === 'minion' && player.board.length >= MAX_BOARD) throw new Error('Tu campo está lleno.');

      let remaining = card.mana;
      const tempUsed = Math.min(player.tempMana, remaining);
      player.tempMana -= tempUsed;
      remaining -= tempUsed;
      player.mana -= remaining;
      player.hand.splice(index, 1);

      if (card.type === 'minion') {
        const minion = {
          ...clone(card),
          instanceId: uid(),
          maxHealth: card.health,
          shieldActive: Boolean(card.divineShield),
          canAttack: Boolean(card.charge),
          hasAttacked: false,
          isFrozen: false
        };
        player.board.push(minion);
        resolveBattlecry(card, player, enemy);
      } else if (card.type === 'spell') {
        resolveSpell(card, player, enemy);
      } else {
        throw new Error('Tipo de carta desconocido.');
      }
    } else if (action.type === 'attack') {
      const attacker = player.board.find((minion) => minion.instanceId === action.attackerId);
      if (!attacker || !attacker.canAttack || attacker.hasAttacked || attacker.isFrozen) throw new Error('Ese esbirro no puede atacar ahora.');
      const taunts = enemy.board.filter((minion) => minion.taunt);
      if (action.targetType === 'hero') {
        if (taunts.length) throw new Error('Debes atacar primero a un esbirro con Provocar.');
        dealHeroDamage(enemy, attacker.attack);
      } else if (action.targetType === 'minion') {
        const defender = enemy.board.find((minion) => minion.instanceId === action.targetId);
        if (!defender) throw new Error('Objetivo no válido.');
        if (taunts.length && !defender.taunt) throw new Error('Debes elegir un esbirro con Provocar.');
        damageMinion(defender, attacker.attack);
        damageMinion(attacker, defender.attack);
        removeDead(enemy);
        removeDead(player);
      } else {
        throw new Error('Objetivo no válido.');
      }
      attacker.canAttack = false;
      attacker.hasAttacked = true;
    } else if (action.type === 'end_turn') {
      const nextSeat = enemySeat;
      if (nextSeat === 'A') match.turnNumber += 1;
      beginTurn(match, nextSeat, true);
    } else {
      throw new Error('Acción desconocida.');
    }

    removeDead(player);
    removeDead(enemy);
    if (match.status === 'playing') {
      if (player.hp <= 0 && enemy.hp <= 0) {
        match.status = 'ended';
        match.winner = 'draw';
        match.resultReason = 'simultaneous';
      } else if (enemy.hp <= 0) {
        match.status = 'ended';
        match.winner = seat;
        match.resultReason = 'hero_defeated';
      } else if (player.hp <= 0) {
        match.status = 'ended';
        match.winner = enemySeat;
        match.resultReason = 'hero_defeated';
      }
    }
    return match;
  }

  function publicPlayer(player, revealHand) {
    const view = {
      userId: player.userId,
      username: player.username,
      rating: player.rating,
      hp: player.hp,
      armor: player.armor,
      mana: player.mana,
      maxMana: player.maxMana,
      tempMana: player.tempMana,
      handCount: player.hand.length,
      deckCount: player.deck.length,
      board: clone(player.board),
      fatigue: player.fatigue
    };
    if (revealHand) view.hand = clone(player.hand);
    return view;
  }

  function getView(match, seat) {
    const opponentSeat = seat === 'A' ? 'B' : 'A';
    return {
      matchId: match.id,
      mode: match.mode,
      rated: match.rated,
      turn: match.turn,
      myTurn: match.turn === seat,
      turnNumber: match.turnNumber,
      status: match.status,
      winner: match.winner,
      resultReason: match.resultReason,
      you: publicPlayer(match.players[seat], true),
      opponent: publicPlayer(match.players[opponentSeat], false)
    };
  }

  const api = Object.freeze({ CARD_DATABASE, DEFAULT_DECK, MAX_HAND, MAX_BOARD, validateDeck, shuffle, createMatch, applyAction, getView, clone });
  root.ArcaneEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
