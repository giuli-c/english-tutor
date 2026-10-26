// Livello AI: Gemini come provider principale, Groq come riserva (e primo per le correzioni, perché più veloce).
// Ogni chiamata chiede una risposta JSON strutturata, che viene poi validata dal codice.
// Frasi da tradurre e spiegazioni sono nella lingua scelta nell'app (s.lang).
import { t, langInfo } from './i18n.js';

export const hasProvider = (s) => Boolean(s.geminiKey || s.groqKey);

class ModelNotFound extends Error {}

// Se un servizio è sovraccarico può tenere la richiesta aperta senza rispondere:
// dopo 40 secondi la si interrompe e si passa al provider successivo.
async function timedFetch(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(40000) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(t('ai.timeout', { provider: new URL(url).hostname.includes('groq') ? 'Groq' : 'Gemini' }));
    throw e;
  }
}

async function fail(provider, res) {
  const text = await res.text();
  const msg = `${provider} ${res.status}${res.status === 429 ? t('ai.quota') : ''}: ${text.slice(0, 200)}`;
  if (res.status === 404 || text.includes('model_not_found') || text.includes('decommissioned')) throw new ModelNotFound(msg);
  throw new Error(msg);
}

// I modelli Gemini recenti "ragionano" prima di rispondere e questo li rende lenti.
// Per i nostri compiti basta un ragionamento minimo; se il modello non accetta
// il parametro, si riprova senza e lo si ricorda.
const GEMINI_THINKING = [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingBudget: 0 }, null];
let geminiThinking = 0;

async function callGemini(s, system, user, temperature) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
  let res;
  let busyRetries = 0;
  for (;;) {
    const thinkingConfig = GEMINI_THINKING[geminiThinking];
    res = await timedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature, ...(thinkingConfig && { thinkingConfig }) },
      }),
    });
    // 503/500: server sovraccarico, di solito passa in pochi secondi.
    if ((res.status === 503 || res.status === 500) && busyRetries < 2) {
      busyRetries++;
      await new Promise((r) => setTimeout(r, 2000 * busyRetries));
      continue;
    }
    if (res.status !== 400 || !thinkingConfig) break;
    const text = await res.clone().text();
    if (!/think/i.test(text)) break;
    geminiThinking++;
  }
  if (!res.ok) await fail('Gemini', res);
  const json = await res.json();
  return (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

async function callGroq(s, system, user, temperature) {
  const res = await timedFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.groqKey}` },
    body: JSON.stringify({
      model: s.groqModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      temperature,
      ...(s.groqModel.includes('gpt-oss') && { reasoning_effort: 'low' }),
    }),
  });
  if (!res.ok) await fail('Groq', res);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// I provider ritirano spesso i modelli: se quello impostato non esiste più,
// chiediamo l'elenco dei modelli disponibili e ne scegliamo uno adatto.
const SKIP = /lite|image|tts|audio|live|embed|vision|guard|whisper|thinking|exp|preview|nano|robotics|computer/i;

async function pickGeminiModel(s) {
  const res = await timedFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': s.geminiKey } });
  if (!res.ok) await fail('Gemini', res);
  const models = (await res.json()).models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const flash = models.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => version(b) - version(a));
  return flash[0] || models.find((n) => n.includes('flash') && !SKIP.test(n)) || models.find((n) => n.includes('flash'));
}

async function pickGroqModel(s) {
  const res = await timedFetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${s.groqKey}` } });
  if (!res.ok) await fail('Groq', res);
  const ids = (await res.json()).data.filter((m) => m.active !== false).map((m) => m.id).filter((id) => !SKIP.test(id));
  const preferred = ['gpt-oss-120b', 'llama-3.3-70b', 'llama-4', 'qwen', 'gpt-oss', 'llama'];
  for (const p of preferred) {
    const hit = ids.find((id) => id.includes(p));
    if (hit) return hit;
  }
  return ids[0];
}

const PROVIDERS = [
  { name: 'Gemini', key: 'geminiKey', model: 'geminiModel', call: callGemini, pick: pickGeminiModel },
  { name: 'Groq', key: 'groqKey', model: 'groqModel', call: callGroq, pick: pickGroqModel },
];

let onModelChange = () => {};
export const setOnModelChange = (fn) => { onModelChange = fn; };

function parseJSON(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(clean);
}

// fast: per le correzioni, dove conta la velocità, Groq (molto più rapido) va per primo.
export async function askJSON(s, system, user, temperature = 0.4, { fast = false } = {}) {
  const providers = PROVIDERS.filter((p) => s[p.key]);
  if (fast) providers.reverse();
  if (!providers.length) throw new Error(t('ai.noProvider'));
  const errors = [];
  for (const p of providers) {
    try {
      try {
        return parseJSON(await p.call(s, system, user, temperature));
      } catch (e) {
        if (!(e instanceof ModelNotFound)) throw e;
        const model = await p.pick(s);
        if (!model || model === s[p.model]) throw e;
        s[p.model] = model;
        onModelChange(p.name, model);
        return parseJSON(await p.call(s, system, user, temperature));
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

// Lingua madre dello studente, scritta in italiano per i prompt (es. "tedesco").
const native = (s) => langInfo(s.lang).native;
const tutor = (s) => `Sei un tutor di inglese esperto per una persona di madrelingua ${native(s)}.
Rispondi SEMPRE e SOLO con JSON valido, senza testo fuori dal JSON. Le spiegazioni sono in ${native(s)}, brevi e chiare.`;

const compactItems = (items) =>
  items.map((i) => ({ id: i.id, kind: i.kind, term: i.term, meaning: i.meaning, notes: i.notes || undefined }));

// plan: per ogni frase, la lista degli elementi che deve allenare (deciso da srs.planSession).
// Le frasi che svelano la soluzione (termine inglese o asterischi nella frase da tradurre)
// vengono scartate e richieste di nuovo una volta.
export async function generateExercises(s, plan) {
  const byN = await requestExercises(s, plan);
  const missing = plan.map((_, k) => k).filter((k) => !byN.has(k));
  if (missing.length && byN.size) {
    try {
      const retry = await requestExercises(s, missing.map((k) => plan[k]));
      retry.forEach((ex, j) => byN.set(missing[j], ex));
    } catch {
      // Se il secondo tentativo fallisce si usano le frasi valide già ottenute.
    }
  }
  const exercises = [...byN.keys()].sort((a, b) => a - b).map((k) => byN.get(k));
  if (!exercises.length) throw new Error(t('ai.noExercises'));
  return exercises;
}

// Restituisce una Map indice-del-piano -> esercizio, solo per le frasi valide.
async function requestExercises(s, plan) {
  const items = [...new Map(plan.flat().map((i) => [i.id, i])).values()];
  const n = plan.length;
  const user = `Livello dello studente: ${s.level} (CEFR).
Materiale studiato:
${JSON.stringify(compactItems(items))}

Crea esattamente ${n} frasi in ${native(s).toUpperCase()} da tradurre in inglese, seguendo questo piano.
Ogni frase "n" deve richiedere TUTTI gli elementi indicati in "use" (id del materiale):
${JSON.stringify(plan.map((p, k) => ({ n: k + 1, use: p.map((i) => i.id) })))}

Regole:
- "it" è la frase da tradurre, scritta INTERAMENTE in ${native(s)}: nessuna parola inglese, niente asterischi o virgolette per evidenziare.
- Esprimi il significato degli elementi in ${native(s)}: lo studente deve trovare da solo il termine inglese. Esempio: per "look up" scrivi "cercare" (non "look up").
- Rispetta il piano: non usare come obiettivo elementi diversi da quelli indicati per ogni frase.
- Frasi naturali di vita quotidiana, lavoro, viaggi, relazioni. Varia contesti e soggetti.
- Non rivelare quale regola usare.
- Non introdurre strutture grammaticali molto più difficili del livello indicato.
- "en" è la traduzione di riferimento più naturale e usa gli elementi del piano; "alternatives" altre traduzioni corrette (0-2).
- "n" è il numero della frase nel piano.
- "hint" è un piccolo aiuto in ${native(s)} che non dà la soluzione e non contiene il termine inglese.

Formato:
{"exercises":[{"n":1,"it":"...","en":"...","alternatives":["..."],"hint":"..."}]}`;
  const out = await askJSON(s, tutor(s), user, 0.9);
  const byN = new Map();
  (out.exercises || []).forEach((e, k) => {
    if (!e || typeof e.it !== 'string' || typeof e.en !== 'string') return;
    const idx = (Number.isInteger(e.n) ? e.n : k + 1) - 1;
    const planned = plan[idx];
    if (!planned || byN.has(idx) || revealsAnswer(e.it, planned)) return;
    byN.set(idx, {
      it: e.it.trim(),
      en: e.en.trim(),
      alternatives: Array.isArray(e.alternatives) ? e.alternatives.filter((a) => typeof a === 'string') : [],
      // Gli elementi allenati sono quelli del piano, non quelli dichiarati dall'AI.
      itemIds: planned.map((i) => i.id),
      hint: typeof e.hint === 'string' && !revealsAnswer(e.hint, planned) ? e.hint : '',
    });
  });
  return byN;
}

// La frase da tradurre non deve contenere asterischi né il termine inglese di parole e phrasal verb.
const revealsAnswer = (text, planned) =>
  text.includes('*') || planned.some((i) => i.kind !== 'rule' && i.term.length > 2 && text.toLowerCase().includes(i.term.toLowerCase()));

export async function correctAnswer(s, ex, answer, items) {
  const user = `Frase in ${native(s)}: "${ex.it}"
Traduzione di riferimento: "${ex.en}"${ex.alternatives.length ? `\nAltre traduzioni corrette: ${JSON.stringify(ex.alternatives)}` : ''}
Elementi allenati: ${JSON.stringify(compactItems(items))}
Traduzione dello studente: "${answer}"

Valuta la traduzione dello studente.
- Accetta qualsiasi traduzione corretta e naturale, anche diversa dal riferimento.
- Ignora maiuscole e punteggiatura finale.
- verdict: "correct" (corretta), "minor" (piccolo errore di ortografia/articolo che non cambia il senso), "wrong" (errore di grammatica, lessico o significato).
- corrected: la versione corretta più vicina a ciò che ha scritto lo studente.
- natural: come lo direbbe un madrelingua inglese (può coincidere con corrected).
- explanation ed errors[].what: in ${native(s)}.
- errors: un oggetto per ogni errore; itemId è l'id dell'elemento allenato coinvolto, oppure null se l'errore non riguarda il materiale.

Formato:
{"verdict":"correct|minor|wrong","corrected":"...","natural":"...","explanation":"...","errors":[{"type":"grammar|vocabulary|spelling|word_order|missing|other","itemId":"... o null","what":"..."}]}`;
  const out = await askJSON(s, tutor(s), user, 0.2, { fast: true });
  const verdict = ['correct', 'minor', 'wrong'].includes(out.verdict) ? out.verdict : 'wrong';
  const valid = new Set(items.map((i) => i.id));
  return {
    verdict,
    corrected: out.corrected || ex.en,
    natural: out.natural || '',
    explanation: out.explanation || '',
    errors: (Array.isArray(out.errors) ? out.errors : []).map((e) => ({
      type: e.type || 'other',
      itemId: valid.has(e.itemId) ? e.itemId : null,
      what: e.what || '',
    })),
  };
}

// Controlla le categorie degli elementi già salvati e restituisce solo quelli da spostare.
// L'archivio viene inviato a blocchi, con i significati accorciati, per restare
// nei limiti dei piani gratuiti (Groq: circa 8000 token al minuto).
export async function classifyItems(s, items, onProgress = () => {}) {
  const CHUNK = 40;
  const changes = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    onProgress(Math.floor(i / CHUNK) + 1, Math.ceil(items.length / CHUNK));
    changes.push(...(await classifyChunk(s, items.slice(i, i + CHUNK))));
  }
  return changes;
}

async function classifyChunk(s, items) {
  const short = (t) => (t.length > 80 ? t.slice(0, 80) + '…' : t);
  const user = `Ecco un archivio di studio di inglese. Ogni elemento ha una categoria ("kind"):
- "word": parole, espressioni, modi di dire;
- "phrasal": phrasal verbs (verbo + particella/preposizione, es. "give up", "rely on", "look forward to");
- "rule": regole grammaticali (es. "Present perfect", "Third conditional").

Indica SOLO gli elementi la cui categoria è sbagliata, con la categoria corretta. Se è tutto corretto restituisci una lista vuota.

${JSON.stringify(items.map((i) => ({ id: i.id, kind: i.kind, term: i.term, meaning: short(i.meaning) })))}

Formato:
{"changes":[{"id":"...","kind":"word|phrasal|rule"}]}`;
  const out = await askJSON(s, tutor(s), user, 0);
  const byId = new Map(items.map((i) => [i.id, i]));
  return (out.changes || []).filter((c) => byId.has(c.id) && ['word', 'phrasal', 'rule'].includes(c.kind) && byId.get(c.id).kind !== c.kind);
}

// Domande a scelta multipla per il quiz di grammatica.
// Una richiesta ogni 3 regole, per restare nei limiti dei piani gratuiti.
export async function generateQuizzes(s, rules) {
  const result = new Map();
  for (let i = 0; i < rules.length; i += 3) {
    const chunk = rules.slice(i, i + 3);
    const user = `Livello dello studente: ${s.level} (CEFR).
Per ognuna di queste regole grammaticali crea un quiz a scelta multipla.
${JSON.stringify(chunk.map((r) => ({ id: r.id, term: r.term, meaning: r.meaning.slice(0, 400), notes: r.notes || undefined })))}

Per ogni regola crea 8 domande:
- "s": frase in inglese con "___" al posto della parte da scegliere. Se serve, metti tra parentesi la forma base, es. "If I ___ (know), I would have helped you."
- "options": le scelte possibili.
  - Regole del tipo "A vs B" (es. "-ing vs to (infinitive)"): le opzioni sono le alternative del nome della regola, uguali per tutte le domande (es. ["-ing", "to (infinitive)"]).
  - Altre regole: 3 opzioni, cioè la forma corretta e 2 forme sbagliate ma plausibili legate alla regola (es. ["had known", "knew", "would know"]).
- "a": l'opzione corretta, scritta ESATTAMENTE come in "options". Ogni frase deve avere una sola risposta corretta.
- "full": la frase completa e corretta.
- "why": spiegazione brevissima in ${native(s)}.
Frasi naturali e varie, di vita quotidiana. Nelle regole "A vs B" distribuisci le risposte in modo equilibrato.

Formato:
{"quizzes":[{"id":"...","questions":[{"s":"...","options":["..."],"a":"...","full":"...","why":"..."}]}]}`;
    const out = await askJSON(s, tutor(s), user, 0.7);
    for (const q of out.quizzes || []) {
      if (!chunk.some((r) => r.id === q.id)) continue;
      const questions = (q.questions || [])
        .map((x) => ({ ...x, options: (Array.isArray(x?.options) ? x.options : []).filter((o) => typeof o === 'string' && o.trim()).slice(0, 4) }))
        .filter((x) => typeof x.s === 'string' && x.s.includes('___') && x.options.length >= 2 && x.options.includes(x.a));
      if (questions.length >= 3) result.set(q.id, { questions, createdAt: Date.now(), lang: s.lang || 'it' });
    }
  }
  return result;
}

export async function extractItems(s, text) {
  const user = `Dal testo seguente estrai il materiale di studio di inglese.
- "phrasal": phrasal verbs (verbo + particella, es. "give up", "look forward to"). term = in inglese, meaning = traduzione in ${native(s)}.
- "word": parole, espressioni, modi di dire. term = in inglese, meaning = traduzione in ${native(s)}.
- "rule": regole grammaticali. term = nome della regola in inglese (es. "Third conditional"), meaning = spiegazione breve in ${native(s)}, notes = struttura/formula (es. "if + past perfect, would have + past participle").
- example: un esempio in inglese se presente nel testo o facile da scrivere.
- topic: argomento breve in ${native(s)}.
Non inventare elementi che non sono nel testo. Niente duplicati.

Formato:
{"items":[{"kind":"word|phrasal|rule","term":"...","meaning":"...","notes":"...","example":"...","topic":"..."}]}

TESTO:
${text.slice(0, 60000)}`;
  const out = await askJSON(s, tutor(s), user, 0.1);
  return (out.items || []).filter((i) => i && i.term && ['word', 'phrasal', 'rule'].includes(i.kind));
}
