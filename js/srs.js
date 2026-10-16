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

// Piano della sessione di frasi: per ogni frase, gli elementi che deve allenare.
// usage = quante frasi hanno già usato ogni elemento: i meno usati hanno la precedenza,
// così prima o poi tutto l'archivio viene allenato. Ogni frase ha un elemento principale
// diverso; le frasi sulle regole aggiungono una parola o un phrasal verb non ancora usati.
export function planSession(items, n, usage = new Map()) {
  const now = Date.now();
  const score = (i) =>
    Math.min(usage.get(i.id) || 0, 20) * 10 + (isDue(i, now) ? 0 : 30) + i.srs.box * 3 - (i.srs.wrong > i.srs.correct ? 8 : 0) + Math.random() * 6;
  const byScore = (list) => [...list].sort((a, b) => score(a) - score(b));
  const rules = byScore(items.filter((i) => i.kind === 'rule'));
  const words = byScore(items.filter((i) => i.kind !== 'rule'));

  // Circa 4 frasi su 10 sulle regole, adattandosi a ciò che c'è nell'archivio.
  let nRules = Math.min(rules.length, Math.round(n * 0.4));
  const nWords = Math.min(words.length, n - nRules);
  nRules = Math.min(rules.length, n - nWords);
  const main = [...rules.slice(0, nRules), ...words.slice(0, nWords)];
  if (!main.length) return [];
  // Archivio (o selezione) più piccolo delle frasi richieste: si ricomincia dal primo.
  for (let k = 0; main.length < n; k++) main.push(main[k]);

  const spare = words.slice(nWords);
  const plan = main.map((m) => (m.kind === 'rule' && spare.length ? [m, spare.shift()] : [m]));
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
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
