// Stato dell'app.
// - data: archivio (parole, regole, tentativi). È l'unica parte sincronizzata tra dispositivi.
// - settings: chiavi API e preferenze. Restano SOLO su questo dispositivo.
// - session: la sessione di esercizi in corso, così si può riprendere dopo aver chiuso l'app.
import * as db from './db.js';
import { newSrs } from './srs.js';

const MAX_ATTEMPTS = 3000;

export const DEFAULT_SETTINGS = {
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  groqKey: '',
  groqModel: 'openai/gpt-oss-120b',
  level: 'B1',
  sessionSize: 10,
  gistToken: '',
  gistId: '',
  lastSync: 0,
};

// Categorie dell'archivio. Phrasal verb e parole vengono usati allo stesso modo negli esercizi.
export const KINDS = {
  word: { one: 'parola', many: 'Parole' },
  phrasal: { one: 'phrasal verb', many: 'Phrasal verb' },
  rule: { one: 'regola', many: 'Regole' },
};

const emptyData = () => ({ version: 1, updatedAt: 0, items: [], attempts: [], deleted: {} });

export const S = { data: emptyData(), settings: { ...DEFAULT_SETTINGS }, session: null };

let onDataChange = () => {};
export const setOnDataChange = (fn) => { onDataChange = fn; };

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function load() {
  S.data = { ...emptyData(), ...((await db.get('data')) || {}) };
  S.settings = { ...DEFAULT_SETTINGS, ...((await db.get('settings')) || {}) };
  S.session = (await db.get('session')) || null;
  navigator.storage?.persist?.();
}

export async function saveData({ silent = false } = {}) {
  S.data.updatedAt = Date.now();
  if (S.data.attempts.length > MAX_ATTEMPTS) S.data.attempts = S.data.attempts.slice(-MAX_ATTEMPTS);
  await db.set('data', S.data);
  if (!silent) onDataChange();
}

export const saveSettings = () => db.set('settings', S.settings);
export const saveSession = () => (S.session ? db.set('session', S.session) : db.del('session'));

export function replaceData(newData) {
  S.data = { ...emptyData(), ...newData };
  return saveData();
}

export function addItem(fields) {
  const now = Date.now();
  const item = {
    id: uid(),
    kind: KINDS[fields.kind] ? fields.kind : 'word',
    term: (fields.term || '').trim(),
    meaning: (fields.meaning || '').trim(),
    notes: (fields.notes || '').trim(),
    example: (fields.example || '').trim(),
    topic: (fields.topic || '').trim(),
    createdAt: now,
    updatedAt: now,
    srs: newSrs(),
  };
  S.data.items.push(item);
  return item;
}

export function deleteItem(id) {
  S.data.items = S.data.items.filter((i) => i.id !== id);
  S.data.deleted[id] = Date.now();
}

export const findItem = (id) => S.data.items.find((i) => i.id === id);

export const isDuplicate = (kind, term) =>
  S.data.items.some((i) => i.kind === kind && i.term.toLowerCase() === term.trim().toLowerCase());

// Unisce due copie dell'archivio (es. telefono e PC usati entrambi offline):
// per ogni elemento vince la versione modificata più di recente, i tentativi si sommano.
export function merge(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, ts] of Object.entries(b.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, ts);

  const items = new Map();
  for (const it of [...a.items, ...(b.items || [])]) {
    const prev = items.get(it.id);
    if (!prev || it.updatedAt > prev.updatedAt) items.set(it.id, it);
  }
  const attempts = new Map();
  for (const at of [...a.attempts, ...(b.attempts || [])]) attempts.set(at.id, at);

  return {
    version: 1,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    deleted,
    items: [...items.values()].filter((i) => !(deleted[i.id] >= i.updatedAt)),
    attempts: [...attempts.values()].sort((x, y) => x.ts - y.ts).slice(-MAX_ATTEMPTS),
  };
}
