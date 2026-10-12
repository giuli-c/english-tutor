// Spaced repetition (sistema a scatole di Leitner).
// È il codice, non l'AI, a decidere cosa ripassare e quando.
const DAY = 24 * 60 * 60 * 1000;
const INTERVALS_DAYS = [0, 1, 2, 4, 8, 16, 32, 64];
export const MAX_BOX = INTERVALS_DAYS.length - 1;

export const newSrs = () => ({ box: 0, due: 0, correct: 0, wrong: 0, lastSeen: 0 });

export function review(item, ok, now = Date.now()) {
  const s = item.srs;
  if (ok) {
    s.box = Math.min(MAX_BOX, s.box + 1);
    s.correct++;
  } else {
    s.box = Math.max(0, s.box - 2);
    s.wrong++;
  }
  // Scatola 0: torna disponibile dopo 10 minuti, così un errore viene riproposto presto.
  s.due = now + (s.box === 0 ? 10 * 60 * 1000 : INTERVALS_DAYS[s.box] * DAY);
  s.lastSeen = now;
  item.updatedAt = now;
}

export const isDue = (item, now = Date.now()) => item.srs.due <= now;
export const mastery = (item) => Math.round((item.srs.box / MAX_BOX) * 100);

// Sceglie gli elementi su cui generare la sessione: prima quelli scaduti e deboli,
// con un po' di casualità per non proporre sempre le stesse combinazioni.
const priority = (items) => {
  const now = Date.now();
  const score = (i) => (isDue(i, now) ? 0 : 100) + i.srs.box * 10 + (i.srs.wrong > i.srs.correct ? -5 : 0) + Math.random() * 8;
  return [...items].sort((a, b) => score(a) - score(b));
};

export function pickForSession(items, { rules = 4, words = 10 } = {}) {
  return [
    ...priority(items.filter((i) => i.kind === 'rule')).slice(0, rules),
    ...priority(items.filter((i) => i.kind !== 'rule')).slice(0, words),
  ];
}

// Mazzo di flashcard: stessa priorità degli esercizi, poi mescolato.
export function pickCards(items, n = 20) {
  const deck = priority(items).slice(0, n);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
