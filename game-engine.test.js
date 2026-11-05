'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CARD_DATABASE,
  DEFAULT_DECK,
  validateDeck,
  createMatch,
  applyAction,
  getView
} = require('../shared/game-engine.js');

const userA = { id: 'user-a', username: 'JugadorA', rating: 1000 };
const userB = { id: 'user-b', username: 'JugadorB', rating: 1000 };
function newMatch() {
  return createMatch(userA, userB, [...DEFAULT_DECK], [...DEFAULT_DECK], { firstSeat: 'A', mode: 'test' });
}

test('el catálogo contiene 500 cartas con identificadores consecutivos', () => {
  assert.equal(CARD_DATABASE.length, 500);
  assert.deepEqual(CARD_DATABASE.map((card) => card.id), Array.from({ length: 500 }, (_, i) => i));
});

test('valida tamaño, identificadores y límites de copias del mazo', () => {
  assert.equal(validateDeck([...DEFAULT_DECK]).valid, true);
  assert.equal(validateDeck([1, 2]).valid, false);
  assert.equal(validateDeck([...DEFAULT_DECK, 30]).valid, false);
  assert.equal(validateDeck([...DEFAULT_DECK.slice(0, 28), 1, 1]).valid, false);
  assert.equal(validateDeck([...DEFAULT_DECK.slice(0, 29), 3, 3]).valid, false);
});

test('crea partidas con manos privadas y maná inicial correcto', () => {
  const match = newMatch();
  assert.equal(match.turn, 'A');
  assert.equal(match.players.A.mana, 1);
  assert.equal(match.players.A.maxMana, 1);
  assert.equal(match.players.B.mana, 0);
  assert.equal(match.players.A.hand.length, 3);
  assert.equal(match.players.B.hand.length, 3);
  const view = getView(match, 'A');
  assert.equal(view.you.hand.length, 3);
  assert.equal('hand' in view.opponent, false);
  assert.equal(view.opponent.handCount, 3);
});

test('jugar un esbirro consume maná y lo coloca en el campo', () => {
  const match = newMatch();
  match.players.A.hand = [{ ...CARD_DATABASE[1], instanceId: 'card-instance-1' }];
  match.players.A.mana = 1;
  applyAction(match, 'A', { type: 'play_card', index: 0 });
  assert.equal(match.players.A.hand.length, 0);
  assert.equal(match.players.A.board.length, 1);
  assert.equal(match.players.A.board[0].id, 1);
  assert.equal(match.players.A.mana, 1); // Card 1 costs 0.
});

test('los hechizos de daño de área afectan al héroe y a los esbirros rivales', () => {
  const match = newMatch();
  match.players.A.hand = [{ ...CARD_DATABASE[0], instanceId: 'spell-0' }];
  match.players.B.board = [{ instanceId: 'target', health: 4, attack: 1, taunt: false, shieldActive: false }];
  applyAction(match, 'A', { type: 'play_card', index: 0 });
  assert.equal(match.players.B.hp, 28);
  assert.equal(match.players.B.board.length, 1);
  assert.equal(match.players.B.board[0].health, 2);
});

test('Provocar impide atacar directamente al héroe', () => {
  const match = newMatch();
  match.players.A.board = [{ instanceId: 'attacker', attack: 3, health: 3, canAttack: true, hasAttacked: false, taunt: false, shieldActive: false }];
  match.players.B.board = [{ instanceId: 'taunt', attack: 1, health: 5, canAttack: false, hasAttacked: false, taunt: true, shieldActive: false }];
  assert.throws(() => applyAction(match, 'A', { type: 'attack', attackerId: 'attacker', targetType: 'hero' }), /Provocar/);
  applyAction(match, 'A', { type: 'attack', attackerId: 'attacker', targetType: 'minion', targetId: 'taunt' });
  assert.equal(match.players.B.board[0].health, 2);
});

test('Escudo divino absorbe el primer daño', () => {
  const match = newMatch();
  match.players.A.board = [{ instanceId: 'attacker', attack: 3, health: 3, canAttack: true, hasAttacked: false, taunt: false, shieldActive: false }];
  match.players.B.board = [{ instanceId: 'shielded', attack: 0, health: 4, canAttack: false, hasAttacked: false, taunt: false, shieldActive: true }];
  applyAction(match, 'A', { type: 'attack', attackerId: 'attacker', targetType: 'minion', targetId: 'shielded' });
  assert.equal(match.players.B.board[0].health, 4);
  assert.equal(match.players.B.board[0].shieldActive, false);
});

test('el turno siguiente recibe un cristal y roba una carta', () => {
  const match = newMatch();
  const handBefore = match.players.B.hand.length;
  applyAction(match, 'A', { type: 'end_turn' });
  assert.equal(match.turn, 'B');
  assert.equal(match.players.B.maxMana, 1);
  assert.equal(match.players.B.mana, 1);
  assert.equal(match.players.B.hand.length, handBefore + 1);
});

test('rendirse funciona incluso cuando no es el turno del jugador', () => {
  const match = newMatch();
  applyAction(match, 'B', { type: 'concede' });
  assert.equal(match.status, 'ended');
  assert.equal(match.winner, 'A');
  assert.equal(match.resultReason, 'concede');
});

test('cada efecto de hechizo genera un resultado definido', () => {
  const cases = [
    { cardId: 0, prepare(match) { match.players.B.hp = 20; }, check(match) { assert.equal(match.players.B.hp, 18); } },
    { cardId: 21, prepare(match) { match.players.A.hp = 20; }, check(match) { assert.equal(match.players.A.hp, 24); } },
    { cardId: 7, prepare(match) { match.players.A.deck = [2, 4]; match.players.A.hand = [{ ...CARD_DATABASE[7], instanceId: 'draw-spell' }]; }, check(match) { assert.equal(match.players.A.hand.length, 2); assert.equal(match.players.A.deck.length, 0); } },
    { cardId: 28, prepare(match) { match.players.A.board = [{ instanceId: 'ally', attack: 2, health: 3, maxHealth: 3, taunt: false, shieldActive: false }]; }, check(match) { assert.equal(match.players.A.board[0].attack, 3); assert.equal(match.players.A.board[0].health, 4); } },
    { cardId: 14, prepare(match) { match.players.B.hp = 20; }, check(match) { assert.equal(match.players.B.hp, 17); } }
  ];
  for (const item of cases) {
    const match = newMatch();
    item.prepare(match);
    match.players.A.hand = [{ ...CARD_DATABASE[item.cardId], instanceId: `spell-${item.cardId}` }];
    match.players.A.mana = 10;
    applyAction(match, 'A', { type: 'play_card', index: 0 });
    item.check(match);
  }
});

test('los gritos de batalla se resuelven al invocar', () => {
  const match = newMatch();
  match.players.A.hand = [{ ...CARD_DATABASE[5], instanceId: 'battlecry-damage' }];
  match.players.A.mana = 10;
  match.players.B.hp = 20;
  applyAction(match, 'A', { type: 'play_card', index: 0 });
  assert.equal(match.players.B.hp, 18);
  assert.equal(match.players.A.board.length, 1);
});

test('un esbirro recién invocado sin Carga no puede atacar', () => {
  const match = newMatch();
  match.players.A.hand = [{ ...CARD_DATABASE[1], instanceId: 'new-minion' }];
  match.players.A.mana = 10;
  applyAction(match, 'A', { type: 'play_card', index: 0 });
  const minion = match.players.A.board[0];
  assert.equal(minion.canAttack, false);
  assert.throws(() => applyAction(match, 'A', { type: 'attack', attackerId: minion.instanceId, targetType: 'hero' }), /no puede atacar/);
});

test('no se pueden jugar cartas fuera de turno ni superar el límite de campo', () => {
  const match = newMatch();
  assert.throws(() => applyAction(match, 'B', { type: 'play_card', index: 0 }), /No es tu turno/);
  match.players.A.hand = [{ ...CARD_DATABASE[1], instanceId: 'overflow-card' }];
  match.players.A.mana = 10;
  match.players.A.board = Array.from({ length: 7 }, (_, index) => ({ instanceId: `board-${index}`, health: 2, attack: 1 }));
  assert.throws(() => applyAction(match, 'A', { type: 'play_card', index: 0 }), /campo está lleno/);
});

test('el daño de héroe consume armadura antes que salud', () => {
  const match = newMatch();
  match.players.B.armor = 3;
  match.players.B.hp = 20;
  match.players.A.board = [{ instanceId: 'face-attacker', attack: 5, health: 3, canAttack: true, hasAttacked: false, taunt: false, shieldActive: false }];
  applyAction(match, 'A', { type: 'attack', attackerId: 'face-attacker', targetType: 'hero' });
  assert.equal(match.players.B.armor, 0);
  assert.equal(match.players.B.hp, 18);
});
