// Livello AI: Gemini come provider principale, Groq come riserva.
// Ogni chiamata chiede una risposta JSON strutturata, che viene poi validata dal codice.

export const hasProvider = (s) => Boolean(s.geminiKey || s.groqKey);

async function callGemini(s, system, user, temperature) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}${res.status === 429 ? ' (quota gratuita esaurita per ora)' : ''}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

async function callGroq(s, system, user, temperature) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.groqKey}` },
    body: JSON.stringify({
      model: s.groqModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      temperature,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}${res.status === 429 ? ' (quota gratuita esaurita per ora)' : ''}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

function parseJSON(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(clean);
}

export async function askJSON(s, system, user, temperature = 0.4) {
  const providers = [];
  if (s.geminiKey) providers.push(callGemini);
  if (s.groqKey) providers.push(callGroq);
  if (!providers.length) throw new Error('Nessuna chiave API configurata (vai in Impostazioni).');
  const errors = [];
  for (const call of providers) {
    try {
      return parseJSON(await call(s, system, user, temperature));
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

const TUTOR = `Sei un tutor di inglese esperto per una persona madrelingua italiana.
Rispondi SEMPRE e SOLO con JSON valido, senza testo fuori dal JSON. Le spiegazioni sono in italiano, brevi e chiare.`;

const compactItems = (items) =>
  items.map((i) => ({ id: i.id, kind: i.kind, term: i.term, meaning: i.meaning, notes: i.notes || undefined }));

export async function generateExercises(s, items, n) {
  const user = `Livello dello studente: ${s.level} (CEFR).
Materiale studiato (usa SOLO questo come obiettivo dell'esercizio):
${JSON.stringify(compactItems(items))}

Crea esattamente ${n} frasi in ITALIANO da tradurre in inglese.
Regole:
- Ogni frase deve richiedere almeno un elemento del materiale; idealmente combina 1 regola grammaticale ("rule") con 1-2 parole/espressioni ("word").
- Frasi naturali di vita quotidiana, lavoro, viaggi, relazioni. Varia contesti e soggetti.
- Non rivelare nella frase italiana quale regola usare.
- Non introdurre strutture grammaticali molto più difficili del livello indicato.
- "en" è la traduzione di riferimento più naturale; "alternatives" altre traduzioni corrette (0-2).
- "itemIds" contiene gli id ESATTI degli elementi del materiale che la frase allena.
- "hint" è un piccolo aiuto in italiano che non dà la soluzione.

Formato:
{"exercises":[{"it":"...","en":"...","alternatives":["..."],"itemIds":["..."],"hint":"..."}]}`;
  const out = await askJSON(s, TUTOR, user, 0.9);
  const valid = new Set(items.map((i) => i.id));
  const exercises = (out.exercises || [])
    .filter((e) => e && typeof e.it === 'string' && typeof e.en === 'string')
    .map((e) => ({
      it: e.it.trim(),
      en: e.en.trim(),
      alternatives: Array.isArray(e.alternatives) ? e.alternatives.filter((a) => typeof a === 'string') : [],
      itemIds: (Array.isArray(e.itemIds) ? e.itemIds : []).filter((id) => valid.has(id)),
      hint: typeof e.hint === 'string' ? e.hint : '',
    }));
  if (!exercises.length) throw new Error("L'AI non ha restituito esercizi validi. Riprova.");
  return exercises;
}

export async function correctAnswer(s, ex, answer, items) {
  const user = `Frase italiana: "${ex.it}"
Traduzione di riferimento: "${ex.en}"${ex.alternatives.length ? `\nAltre traduzioni corrette: ${JSON.stringify(ex.alternatives)}` : ''}
Elementi allenati: ${JSON.stringify(compactItems(items))}
Traduzione dello studente: "${answer}"

Valuta la traduzione dello studente.
- Accetta qualsiasi traduzione corretta e naturale, anche diversa dal riferimento.
- Ignora maiuscole e punteggiatura finale.
- verdict: "correct" (corretta), "minor" (piccolo errore di ortografia/articolo che non cambia il senso), "wrong" (errore di grammatica, lessico o significato).
- corrected: la versione corretta più vicina a ciò che ha scritto lo studente.
- natural: come lo direbbe un madrelingua (può coincidere con corrected).
- errors: un oggetto per ogni errore; itemId è l'id dell'elemento allenato coinvolto, oppure null se l'errore non riguarda il materiale.

Formato:
{"verdict":"correct|minor|wrong","corrected":"...","natural":"...","explanation":"...","errors":[{"type":"grammar|vocabulary|spelling|word_order|missing|other","itemId":"... o null","what":"..."}]}`;
  const out = await askJSON(s, TUTOR, user, 0.2);
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

export async function extractItems(s, text) {
  const user = `Dal testo seguente estrai il materiale di studio di inglese.
- "word": parole, phrasal verbs, espressioni, modi di dire. term = in inglese, meaning = traduzione italiana.
- "rule": regole grammaticali. term = nome della regola in inglese (es. "Third conditional"), meaning = spiegazione breve in italiano, notes = struttura/formula (es. "if + past perfect, would have + participio").
- example: un esempio in inglese se presente nel testo o facile da scrivere.
- topic: argomento breve (es. "lavoro", "tempi verbali").
Non inventare elementi che non sono nel testo. Niente duplicati.

Formato:
{"items":[{"kind":"word|rule","term":"...","meaning":"...","notes":"...","example":"...","topic":"..."}]}

TESTO:
${text.slice(0, 60000)}`;
  const out = await askJSON(s, TUTOR, user, 0.1);
  return (out.items || []).filter((i) => i && i.term && (i.kind === 'word' || i.kind === 'rule'));
}
