import { S, KINDS, load, saveData, saveSettings, saveSession, replaceData, addItem, deleteItem, findItem, isDuplicate, merge, setOnDataChange } from './store.js';
import { pickForSession, pickCards, review, mastery, isDue } from './srs.js';
import * as ai from './ai.js';
import { readFileText, parseQuickList } from './importer.js';
import * as sync from './sync.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ui = {
  current: 'practice', libTab: 'word', libQuery: '', preview: null, syncState: 'off', syncMsg: '',
  // Flashcard: categorie scelte, direzione e mazzo in corso.
  flashKinds: new Set(Object.keys(KINDS)), flashDir: 'en-it', flash: null,
};

// ---------- Utilità UI ----------
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 2500);
}

function openModal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-card').innerHTML = '';
  ui.preview = null;
}

const bar = (pct) => `<div class="bar"><span style="width:${pct}%"></span></div>`;
const loading = (msg) => `<div class="center muted"><div class="spinner"></div><p>${esc(msg)}</p></div>`;

function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Sintesi vocale non supportata su questo browser', true);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen(textarea, button) {
  const rec = new Recognition();
  rec.lang = 'en-US';
  rec.interimResults = false;
  button.classList.add('recording');
  rec.onresult = (e) => {
    const said = e.results[0][0].transcript;
    textarea.value = (textarea.value ? textarea.value + ' ' : '') + said;
  };
  rec.onerror = (e) => toast('Microfono: ' + e.error, true);
  rec.onend = () => button.classList.remove('recording');
  rec.start();
}

// ---------- Navigazione ----------
function navigate(name) {
  ui.current = name;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  render();
  window.scrollTo(0, 0);
}

function render() {
  ({ practice: renderPractice, library: renderLibrary, progress: renderProgress, settings: renderSettings })[ui.current]();
}

// ---------- PRATICA ----------
function renderPractice() {
  if (ui.flash) return renderFlash();
  const sess = S.session;
  if (!sess) return renderPracticeHome();
  if (sess.phase === 'loading') return (view.innerHTML = loading('Sto preparando le frasi…'));
  if (sess.phase === 'done') return renderSessionEnd();

  const ex = sess.exercises[sess.index];
  const head = `
    <div class="row between muted small"><span>Frase ${sess.index + 1} di ${sess.exercises.length}</span>
      <button class="link" data-action="quit-session">Termina</button></div>
    ${bar(Math.round((sess.index / sess.exercises.length) * 100))}
    <div class="card">
      <div class="label">Traduci in inglese</div>
      <p class="sentence">${esc(ex.it)}</p>
      ${ex.hint ? `<details class="hint"><summary>Suggerimento</summary>${esc(ex.hint)}</details>` : ''}
    </div>`;

  if (sess.phase === 'answer' || sess.phase === 'checking') {
    const busy = sess.phase === 'checking';
    view.innerHTML = `${head}
      <div class="card">
        <textarea id="answer" rows="3" placeholder="Scrivi qui la tua traduzione…" autocapitalize="sentences" ${busy ? 'disabled' : ''}>${esc(sess.answer || '')}</textarea>
        <div class="row gap">
          ${Recognition ? `<button class="btn ghost icon" data-action="mic" title="Rispondi a voce" ${busy ? 'disabled' : ''}>🎤</button>` : ''}
          <button class="btn ghost" data-action="skip" ${busy ? 'disabled' : ''}>Non lo so</button>
          <button class="btn primary grow" data-action="check" ${busy ? 'disabled' : ''}>${busy ? 'Controllo…' : 'Controlla'}</button>
        </div>
      </div>`;
    if (!busy) $('#answer').focus();
    return;
  }

  // phase === 'feedback'
  const fb = sess.feedback;
  let body;
  if (fb.source === 'self') {
    body = `
      <div class="card">
        <p class="muted small">Correzione AI non disponibile${fb.error ? ` (${esc(fb.error)})` : ''}. Confronta tu e valuta.</p>
        <div class="label">La tua risposta</div><p>${esc(sess.answer)}</p>
        <div class="label">Riferimento</div><p class="good-text">${esc(ex.en)} <button class="link" data-action="speak" data-text="${esc(ex.en)}">🔊</button></p>
        ${ex.alternatives.length ? `<div class="label">Alternative</div><ul>${ex.alternatives.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
        <div class="row gap">
          <button class="btn bad grow" data-action="self" data-verdict="wrong">Sbagliata</button>
          <button class="btn warn grow" data-action="self" data-verdict="minor">Quasi</button>
          <button class="btn good grow" data-action="self" data-verdict="correct">Corretta</button>
        </div>
      </div>`;
  } else {
    const badge = { correct: ['good', 'Corretta ✓'], minor: ['warn', 'Quasi giusta'], wrong: ['bad', 'Da rivedere'] }[fb.verdict];
    const best = fb.natural || fb.corrected || ex.en;
    body = `
      <div class="card">
        <span class="badge ${badge[0]}">${badge[1]}</span>
        ${sess.answer ? `<div class="label">La tua risposta</div><p>${esc(sess.answer)}</p>` : ''}
        ${fb.verdict !== 'correct' && fb.corrected ? `<div class="label">Corretta</div><p class="good-text">${esc(fb.corrected)}</p>` : ''}
        <div class="label">Come lo direbbe un madrelingua</div>
        <p>${esc(best)} <button class="link" data-action="speak" data-text="${esc(best)}">🔊</button></p>
        ${fb.explanation ? `<div class="label">Spiegazione</div><p>${esc(fb.explanation)}</p>` : ''}
        ${fb.errors?.length ? `<div class="label">Errori</div><ul>${fb.errors.map((e) => `<li><b>${esc(errorLabel(e.type))}</b>: ${esc(e.what)}</li>`).join('')}</ul>` : ''}
        <button class="btn primary full" data-action="next">Avanti</button>
      </div>`;
  }
  view.innerHTML = head + body;
}

const errorLabel = (t) => ({ grammar: 'Grammatica', vocabulary: 'Lessico', spelling: 'Ortografia', word_order: 'Ordine delle parole', missing: 'Manca qualcosa' })[t] || 'Altro';

function renderPracticeHome() {
  const items = S.data.items;
  const due = items.filter((i) => isDue(i)).length;
  const count = (kind) => items.filter((i) => i.kind === kind).length;
  let action;
  if (!items.length) {
    action = `<p>Il tuo archivio è vuoto. Aggiungi parole e regole grammaticali, anche caricando un file.</p>
      <button class="btn primary full" data-nav="library">Vai all'archivio</button>`;
  } else if (!ai.hasProvider(S.settings)) {
    action = `<p>Per generare e correggere le frasi serve una chiave API gratuita (Gemini o Groq).</p>
      <button class="btn primary full" data-nav="settings">Configura l'AI</button>`;
  } else {
    action = `<button class="btn primary full big" data-action="start">Inizia sessione · ${S.settings.sessionSize} frasi</button>`;
  }
  view.innerHTML = `
    <div class="card hero">
      <h2>Ciao! 👋</h2>
      <ul class="stats four">
        <li><b>${count('word')}</b> parole</li>
        <li><b>${count('phrasal')}</b> phrasal verb</li>
        <li><b>${count('rule')}</b> regole</li>
        <li><b>${due}</b> da ripassare</li>
      </ul>
      <h3>✍️ Traduzione di frasi</h3>
      ${action}
    </div>
    ${items.length ? flashHome(count) : ''}
    <p class="muted small center">L'app sceglie cosa ripassare in base ai tuoi errori; l'AI crea le frasi e le corregge.</p>`;
}

// ---------- FLASHCARD ----------
const flashPool = () => S.data.items.filter((i) => ui.flashKinds.has(i.kind));

function flashHome(count) {
  const n = Math.min(20, flashPool().length);
  return `
    <div class="card">
      <h3>🃏 Flashcard</h3>
      <p class="muted small">Ripassa i significati, anche senza internet. Scegli le categorie:</p>
      <div class="chips">
        ${Object.entries(KINDS).map(([k, v]) => `
          <button class="chip ${ui.flashKinds.has(k) ? 'active' : ''}" data-action="flash-kind" data-kind="${k}">${v.many} · ${count(k)}</button>`).join('')}
      </div>
      <div class="segmented">
        <button class="${ui.flashDir === 'en-it' ? 'active' : ''}" data-action="flash-dir" data-dir="en-it">Inglese → Italiano</button>
        <button class="${ui.flashDir === 'it-en' ? 'active' : ''}" data-action="flash-dir" data-dir="it-en">Italiano → Inglese</button>
      </div>
      <button class="btn primary full" data-action="flash-start" ${n ? '' : 'disabled'}>${n ? `Inizia · ${n} carte` : 'Nessuna carta nelle categorie scelte'}</button>
    </div>`;
}

function startFlash(ids) {
  ui.flash = { cards: ids || pickCards(flashPool()).map((i) => i.id), index: 0, flipped: false, missed: [] };
  render();
}

function renderFlash() {
  const f = ui.flash;
  if (f.index >= f.cards.length) {
    const known = f.cards.length - f.missed.length;
    view.innerHTML = `
      <div class="card hero">
        <h2>Mazzo completato 🎉</h2>
        <ul class="stats">
          <li><b class="good-text">${known}</b> ricordate</li>
          <li><b class="bad-text">${f.missed.length}</b> da rivedere</li>
          <li><b>${f.cards.length}</b> carte</li>
        </ul>
        ${f.missed.length ? `<button class="btn primary full" data-action="flash-retry">Ripassa le ${f.missed.length} sbagliate</button>` : ''}
        <button class="btn ${f.missed.length ? 'ghost' : 'primary'} full" data-action="flash-quit">Fine</button>
      </div>`;
    return;
  }
  const item = findItem(f.cards[f.index]);
  if (!item) {
    f.index++;
    return renderFlash();
  }
  // Le regole si ripassano sempre dal nome alla spiegazione.
  const reverse = ui.flashDir === 'it-en' && item.kind !== 'rule';
  const front = reverse ? item.meaning : item.term;
  const back = reverse ? item.term : item.meaning;
  view.innerHTML = `
    <div class="row between muted small"><span>Carta ${f.index + 1} di ${f.cards.length}</span>
      <button class="link" data-action="flash-quit">Termina</button></div>
    ${bar(Math.round((f.index / f.cards.length) * 100))}
    <div class="card flashcard" data-action="flash-flip">
      <span class="tag">${KINDS[item.kind].one}</span>
      <p class="sentence">${esc(front)}</p>
      ${f.flipped ? `
        <hr>
        <p class="sentence good-text">${esc(back)}</p>
        ${item.notes ? `<p class="small">${esc(item.notes)}</p>` : ''}
        ${item.example ? `<p class="small muted"><i>${esc(item.example)}</i></p>` : ''}
        <button class="link" data-action="speak" data-text="${esc(item.example || item.term)}">🔊 Ascolta</button>`
      : '<p class="muted small">Tocca per vedere la risposta</p>'}
    </div>
    ${f.flipped ? `
      <div class="row gap">
        <button class="btn bad grow" data-action="flash-grade" data-ok="0">Non ricordavo</button>
        <button class="btn good grow" data-action="flash-grade" data-ok="1">Ricordavo</button>
      </div>` : `<button class="btn primary full" data-action="flash-flip">Mostra risposta</button>`}`;
}

async function gradeFlash(ok) {
  const f = ui.flash;
  const item = findItem(f.cards[f.index]);
  if (item) review(item, ok);
  if (!ok) f.missed.push(f.cards[f.index]);
  f.index++;
  f.flipped = false;
  render();
  await saveData();
}

function renderSessionEnd() {
  const r = S.session.results;
  const count = (v) => r.filter((x) => x === v).length;
  view.innerHTML = `
    <div class="card hero">
      <h2>Sessione completata 🎉</h2>
      <ul class="stats">
        <li><b class="good-text">${count('correct')}</b> corrette</li>
        <li><b class="warn-text">${count('minor')}</b> quasi</li>
        <li><b class="bad-text">${count('wrong')}</b> da rivedere</li>
      </ul>
      <button class="btn primary full" data-action="new-session">Nuova sessione</button>
      <button class="btn ghost full" data-action="end-session">Torna alla home</button>
    </div>`;
}

async function startSession() {
  const picked = pickForSession(S.data.items);
  S.session = { phase: 'loading' };
  render();
  try {
    const exercises = await ai.generateExercises(S.settings, picked, S.settings.sessionSize);
    S.session = { exercises, index: 0, results: [], phase: 'answer', answer: '', feedback: null };
    await saveSession();
  } catch (e) {
    S.session = null;
    toast(e.message, true);
  }
  render();
}

async function checkAnswer() {
  const sess = S.session;
  const answer = $('#answer').value.trim();
  if (!answer) return toast('Scrivi prima una traduzione');
  const ex = sess.exercises[sess.index];
  sess.answer = answer;
  sess.phase = 'checking';
  render();
  try {
    const items = ex.itemIds.map(findItem).filter(Boolean);
    const fb = await ai.correctAnswer(S.settings, ex, answer, items);
    sess.feedback = { ...fb, source: 'ai' };
    await applyResult(ex, answer, fb);
  } catch (e) {
    sess.feedback = { source: 'self', error: e.message };
  }
  sess.phase = 'feedback';
  await saveSession();
  render();
}

// Aggiorna lo spaced repetition: gli elementi su cui c'è stato un errore scendono, gli altri salgono.
async function applyResult(ex, answer, fb) {
  const now = Date.now();
  const blamed = new Set(fb.errors.map((e) => e.itemId).filter(Boolean));
  const allWrong = fb.verdict === 'wrong' && blamed.size === 0;
  for (const id of ex.itemIds) {
    const item = findItem(id);
    if (item) review(item, !allWrong && !blamed.has(id), now);
  }
  S.data.attempts.push({
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    ts: now,
    it: ex.it,
    answer,
    corrected: fb.corrected || ex.en,
    verdict: fb.verdict,
    itemIds: ex.itemIds,
    errors: fb.errors,
  });
  S.session.results.push(fb.verdict);
  await saveData();
}

async function nextExercise() {
  const sess = S.session;
  sess.index++;
  sess.answer = '';
  sess.feedback = null;
  sess.phase = sess.index >= sess.exercises.length ? 'done' : 'answer';
  await saveSession();
  render();
}

// ---------- ARCHIVIO ----------
function renderLibrary() {
  const q = ui.libQuery.toLowerCase();
  const list = S.data.items
    .filter((i) => i.kind === ui.libTab)
    .filter((i) => !q || [i.term, i.meaning, i.topic].some((f) => f.toLowerCase().includes(q)))
    .sort((a, b) => a.term.localeCompare(b.term));

  view.innerHTML = `
    <div class="segmented">
      ${Object.entries(KINDS).map(([k, v]) => `<button class="${ui.libTab === k ? 'active' : ''}" data-action="lib-tab" data-tab="${k}">${v.many}</button>`).join('')}
    </div>
    <div class="row gap wrap">
      <button class="btn primary grow" data-action="add-item">+ Aggiungi</button>
      <button class="btn ghost grow" data-action="import-file">📄 Carica file</button>
      <button class="btn ghost grow" data-action="paste-list">📋 Incolla lista</button>
      ${S.data.items.length ? '<button class="btn ghost grow" data-action="reclassify">🪄 Riordina categorie</button>' : ''}
    </div>
    <input id="lib-search" type="search" placeholder="Cerca…" value="${esc(ui.libQuery)}">
    ${list.length ? '' : `<p class="muted center">Nessun elemento${q ? ' trovato' : ''}.</p>`}
    <div class="list">
      ${list.map((i) => `
        <button class="item" data-action="edit-item" data-id="${i.id}">
          <div class="row between"><b>${esc(i.term)}</b><span class="muted small">${mastery(i)}%</span></div>
          <div class="muted small">${esc(i.meaning)}</div>
          ${bar(mastery(i))}
        </button>`).join('')}
    </div>`;
  $('#lib-search').addEventListener('input', (e) => {
    ui.libQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderLibrary();
    const el = $('#lib-search');
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}

function itemForm(item) {
  const i = item || { kind: ui.libTab, term: '', meaning: '', notes: '', example: '', topic: '' };
  openModal(`
    <h3>${item ? 'Modifica' : 'Nuovo elemento'}</h3>
    <form id="item-form">
      <label>Tipo<select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${i.kind === k ? 'selected' : ''}>${v.many}</option>`).join('')}</select></label>
      <label>Termine (in inglese)<input name="term" required value="${esc(i.term)}" placeholder="es. awkward / give up / Third conditional"></label>
      <label>Significato / spiegazione<textarea name="meaning" rows="2">${esc(i.meaning)}</textarea></label>
      <label>Note / struttura<textarea name="notes" rows="2">${esc(i.notes)}</textarea></label>
      <label>Esempio<input name="example" value="${esc(i.example)}"></label>
      <label>Argomento<input name="topic" value="${esc(i.topic)}"></label>
      ${item ? `<p class="muted small">Visto ${i.srs.correct + i.srs.wrong} volte · ✓ ${i.srs.correct} · ✗ ${i.srs.wrong}</p>` : ''}
      <div class="row gap">
        ${item ? `<button type="button" class="btn bad" data-action="delete-item" data-id="${i.id}">Elimina</button>` : ''}
        <button type="button" class="btn ghost grow" data-action="close-modal">Annulla</button>
        <button type="submit" class="btn primary grow">Salva</button>
      </div>
    </form>`);
  $('#item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (item) {
      Object.assign(item, { ...f, term: f.term.trim(), updatedAt: Date.now() });
    } else {
      addItem(f);
    }
    await saveData();
    closeModal();
    ui.libTab = f.kind;
    render();
  });
}

function pasteListForm() {
  openModal(`
    <h3>Incolla una lista</h3>
    <p class="muted small">Una voce per riga, ad esempio:<br><code>awkward = imbarazzante</code><br><code>phrasal: give up = arrendersi</code><br><code>regola: Present perfect = azioni passate con effetti sul presente</code><br>
    Oppure incolla un testo qualsiasi (appunti, esercizi) e lascia che l'AI estragga parole e regole.</p>
    <textarea id="paste-text" rows="8"></textarea>
    <div class="row gap wrap">
      <button class="btn ghost grow" data-action="close-modal">Annulla</button>
      <button class="btn ghost grow" data-action="paste-parse">Aggiungi lista</button>
      <button class="btn primary grow" data-action="paste-ai">Analizza con AI</button>
    </div>`);
}

async function analyzeText(text, useAI) {
  if (!text.trim()) return toast('Nessun testo da analizzare');
  let items;
  if (useAI) {
    if (!ai.hasProvider(S.settings)) return toast("Configura prima una chiave API nelle Impostazioni", true);
    openModal(loading("L'AI sta estraendo parole e regole…"));
    try {
      items = await ai.extractItems(S.settings, text);
    } catch (e) {
      closeModal();
      return toast(e.message, true);
    }
  } else {
    items = parseQuickList(text);
  }
  if (!items.length) {
    closeModal();
    return toast(useAI ? 'Non ho trovato elementi nel testo' : 'Nessuna riga nel formato "parola = significato"', true);
  }
  showPreview(items);
}

function showPreview(items) {
  ui.preview = items.map((i) => ({ ...i, dup: isDuplicate(i.kind, i.term) }));
  openModal(`
    <h3>Trovati ${items.length} elementi</h3>
    <p class="muted small">Deseleziona quelli che non vuoi salvare. I duplicati sono già deselezionati.</p>
    <div class="list preview">
      ${ui.preview.map((i, n) => `
        <label class="check">
          <input type="checkbox" data-n="${n}" ${i.dup ? '' : 'checked'}>
          <span><b>${esc(i.term)}</b> <span class="tag">${KINDS[i.kind].one}</span>${i.dup ? ' <span class="tag">già presente</span>' : ''}<br>
          <span class="muted small">${esc(i.meaning)}</span></span>
        </label>`).join('')}
    </div>
    <div class="row gap">
      <button class="btn ghost grow" data-action="close-modal">Annulla</button>
      <button class="btn primary grow" data-action="save-preview">Salva selezionati</button>
    </div>`);
}

async function reclassify() {
  if (!ai.hasProvider(S.settings)) return toast('Configura prima una chiave API nelle Impostazioni', true);
  openModal(loading("L'AI sta controllando le categorie…"));
  let changes;
  try {
    changes = await ai.classifyItems(S.settings, S.data.items, (n, tot) => {
      if (tot > 1) openModal(loading(`L'AI sta controllando le categorie… (blocco ${n} di ${tot})`));
    });
  } catch (e) {
    closeModal();
    return toast(e.message, true);
  }
  if (!changes.length) {
    closeModal();
    return toast('Tutti gli elementi sono già nella categoria giusta ✓');
  }
  ui.preview = changes;
  openModal(`
    <h3>${changes.length} elementi da spostare</h3>
    <p class="muted small">Deseleziona quelli che vuoi lasciare dove sono.</p>
    <div class="list preview">
      ${changes.map((c, n) => {
        const item = findItem(c.id);
        return `
        <label class="check">
          <input type="checkbox" data-n="${n}" checked>
          <span><b>${esc(item.term)}</b><br>
          <span class="muted small">${KINDS[item.kind].many} → <b>${KINDS[c.kind].many}</b></span></span>
        </label>`;
      }).join('')}
    </div>
    <div class="row gap">
      <button class="btn ghost grow" data-action="close-modal">Annulla</button>
      <button class="btn primary grow" data-action="save-reclassify">Sposta selezionati</button>
    </div>`);
}

async function saveReclassify() {
  const checked = [...document.querySelectorAll('.preview input:checked')].map((c) => ui.preview[+c.dataset.n]);
  const now = Date.now();
  for (const c of checked) {
    const item = findItem(c.id);
    if (item) Object.assign(item, { kind: c.kind, updatedAt: now });
  }
  await saveData();
  closeModal();
  toast(`${checked.length} elementi spostati`);
  render();
}

async function savePreview() {
  const checked = [...document.querySelectorAll('.preview input:checked')].map((c) => ui.preview[+c.dataset.n]);
  checked.forEach(addItem);
  await saveData();
  closeModal();
  toast(`${checked.length} elementi aggiunti`);
  render();
}

async function importFile(file) {
  openModal(loading(`Leggo ${file.name}…`));
  try {
    const text = await readFileText(file);
    // Se il file è già una lista "parola = significato" non serve l'AI.
    const quick = parseQuickList(text);
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    if (quick.length && quick.length >= lines * 0.8) return showPreview(quick);
    await analyzeText(text, true);
  } catch (e) {
    closeModal();
    toast(e.message, true);
  }
}

// ---------- PROGRESSI ----------
function streakDays() {
  const days = new Set(S.data.attempts.map((a) => new Date(a.ts).toDateString()));
  let streak = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  while (days.has(d.toDateString())) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function renderProgress() {
  const attempts = S.data.attempts;
  const recent = attempts.filter((a) => a.ts > Date.now() - 30 * 86400000);
  const ok = recent.filter((a) => a.verdict !== 'wrong').length;
  const rules = S.data.items.filter((i) => i.kind === 'rule').sort((a, b) => mastery(a) - mastery(b));
  const weakWords = S.data.items
    .filter((i) => i.kind !== 'rule' && i.srs.correct + i.srs.wrong > 0)
    .sort((a, b) => mastery(a) - mastery(b) || b.srs.wrong - a.srs.wrong)
    .slice(0, 10);
  const lastErrors = attempts.filter((a) => a.verdict === 'wrong').slice(-8).reverse();

  view.innerHTML = `
    <div class="card">
      <ul class="stats">
        <li><b>${streakDays()}</b> giorni di fila</li>
        <li><b>${recent.length ? Math.round((ok / recent.length) * 100) : 0}%</b> risposte giuste (30 gg)</li>
        <li><b>${attempts.length}</b> frasi tradotte</li>
      </ul>
    </div>
    <h3>Regole grammaticali</h3>
    ${rules.length ? rules.map((r) => `
      <div class="progress-row">
        <div class="row between"><span>${esc(r.term)}</span><b>${mastery(r)}%</b></div>
        ${bar(mastery(r))}
        <div class="muted small">✓ ${r.srs.correct} · ✗ ${r.srs.wrong}</div>
      </div>`).join('') : '<p class="muted">Nessuna regola nell\'archivio.</p>'}
    <h3>Parole e phrasal verb su cui insistere</h3>
    ${weakWords.length ? weakWords.map((w) => `
      <div class="progress-row">
        <div class="row between"><span>${esc(w.term)} <span class="muted small">· ${esc(w.meaning)}</span></span><b>${mastery(w)}%</b></div>
        ${bar(mastery(w))}
      </div>`).join('') : '<p class="muted">Ancora nessun dato: fai qualche sessione.</p>'}
    <h3>Ultimi errori</h3>
    ${lastErrors.length ? lastErrors.map((a) => `
      <div class="card tight">
        <p class="small">${esc(a.it)}</p>
        <p class="small bad-text">✗ ${esc(a.answer)}</p>
        <p class="small good-text">✓ ${esc(a.corrected)}</p>
      </div>`).join('') : '<p class="muted">Nessun errore registrato.</p>'}
    <p class="muted small center">La padronanza indica a che punto del ripasso è ogni elemento: sale con le risposte giuste, scende con gli errori.</p>`;
}

// ---------- IMPOSTAZIONI ----------
function renderSettings() {
  const s = S.settings;
  view.innerHTML = `
    <form id="settings-form">
      <div class="card">
        <h3>Intelligenza artificiale</h3>
        <p class="muted small">Basta una delle due chiavi; se le inserisci entrambe, Groq viene usato quando Gemini esaurisce la quota gratuita. Le chiavi restano solo su questo dispositivo.</p>
        <label>Chiave Gemini <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">(ottienila gratis)</a>
          <input name="geminiKey" type="password" autocomplete="off" value="${esc(s.geminiKey)}"></label>
        <label>Modello Gemini<input name="geminiModel" list="gemini-models" value="${esc(s.geminiModel)}"></label>
        <datalist id="gemini-models"><option value="gemini-flash-latest"></datalist>
        <label>Chiave Groq <a href="https://console.groq.com/keys" target="_blank" rel="noopener">(ottienila gratis)</a>
          <input name="groqKey" type="password" autocomplete="off" value="${esc(s.groqKey)}"></label>
        <label>Modello Groq<input name="groqModel" list="groq-models" value="${esc(s.groqModel)}"></label>
        <datalist id="groq-models"><option value="openai/gpt-oss-120b"></datalist>
        <button type="button" class="btn ghost full" data-action="test-ai">Prova connessione</button>
      </div>
      <div class="card">
        <h3>Studio</h3>
        <label>Livello<select name="level">${['A2', 'B1', 'B2', 'C1'].map((l) => `<option ${s.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Frasi per sessione<input name="sessionSize" type="number" min="3" max="25" value="${s.sessionSize}"></label>
      </div>
      <div class="card">
        <h3>Sincronizzazione PC ↔ telefono</h3>
        <p class="muted small">Inserisci lo stesso token GitHub (permesso "gist") su tutti i dispositivi: l'archivio viene salvato in un Gist privato e unito automaticamente.
          <a href="https://github.com/settings/tokens/new?scopes=gist&description=English%20Tutor" target="_blank" rel="noopener">Crea token</a></p>
        <label>Token GitHub<input name="gistToken" type="password" autocomplete="off" value="${esc(s.gistToken)}"></label>
        <p class="small">Stato: <b>${esc(syncLabel())}</b></p>
        <button type="button" class="btn ghost full" data-action="sync-now">Sincronizza ora</button>
      </div>
    </form>
    <div class="card">
      <h3>Backup</h3>
      <div class="row gap wrap">
        <button class="btn ghost grow" data-action="export">Esporta backup</button>
        <button class="btn ghost grow" data-action="import-backup">Importa backup</button>
      </div>
      <button class="btn bad full" data-action="wipe">Cancella tutti i dati di studio</button>
    </div>`;
  $('#settings-form').addEventListener('change', async (e) => {
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const tokenChanged = f.gistToken.trim() !== s.gistToken;
    Object.assign(S.settings, {
      geminiKey: f.geminiKey.trim(),
      geminiModel: f.geminiModel.trim() || 'gemini-flash-latest',
      groqKey: f.groqKey.trim(),
      groqModel: f.groqModel.trim() || 'openai/gpt-oss-120b',
      level: f.level,
      sessionSize: Math.min(25, Math.max(3, parseInt(f.sessionSize, 10) || 10)),
      gistToken: f.gistToken.trim(),
    });
    if (tokenChanged) S.settings.gistId = '';
    await saveSettings();
    toast('Impostazioni salvate');
    if (tokenChanged && S.settings.gistToken) syncNow();
  });
}

function syncLabel() {
  if (!S.settings.gistToken) return 'non configurata';
  const when = S.settings.lastSync ? new Date(S.settings.lastSync).toLocaleString('it-IT') : 'mai';
  return { syncing: 'sincronizzazione in corso…', error: `errore: ${ui.syncMsg}` }[ui.syncState] || `ultima sincronizzazione ${when}`;
}

function setSyncState(state, msg = '') {
  ui.syncState = state;
  ui.syncMsg = msg;
  const dot = $('#sync-dot');
  dot.className = 'sync-dot ' + state;
  dot.title = syncLabel();
  if (ui.current === 'settings') renderSettings();
}

// ---------- Sincronizzazione ----------
let syncing = false;
let syncTimer;
async function syncNow() {
  const s = S.settings;
  if (!s.gistToken || syncing || !navigator.onLine) return;
  syncing = true;
  setSyncState('syncing');
  try {
    if (!s.gistId) s.gistId = await sync.findGist(s.gistToken);
    if (s.gistId) {
      const remote = await sync.pull(s.gistToken, s.gistId);
      if (remote) {
        S.data = merge(S.data, remote);
        await saveData({ silent: true });
      }
    }
    s.gistId = await sync.push(s.gistToken, s.gistId, S.data);
    s.lastSync = Date.now();
    await saveSettings();
    setSyncState('ok');
    if (ui.current !== 'settings' && !(ui.current === 'practice' && S.session)) render();
  } catch (e) {
    setSyncState('error', e.message);
  } finally {
    syncing = false;
  }
}
const scheduleSync = () => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 4000);
};

// ---------- Backup ----------
function exportBackup() {
  const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `english-tutor-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.items)) throw new Error('File di backup non valido');
    await replaceData(merge(S.data, data));
    toast('Backup importato');
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- Eventi ----------
const actions = {
  start: startSession,
  'new-session': startSession,
  check: checkAnswer,
  next: nextExercise,
  mic: (el) => listen($('#answer'), el),
  speak: (el) => speak(el.dataset.text),
  skip: async () => {
    const ex = S.session.exercises[S.session.index];
    const fb = { verdict: 'wrong', corrected: ex.en, natural: ex.en, explanation: ex.alternatives.length ? `Altre traduzioni corrette: ${ex.alternatives.join(' / ')}` : '', errors: [] };
    S.session.answer = '';
    S.session.feedback = { ...fb, source: 'skip' };
    await applyResult(ex, '', fb);
    S.session.phase = 'feedback';
    await saveSession();
    render();
  },
  self: async (el) => {
    const ex = S.session.exercises[S.session.index];
    const fb = { verdict: el.dataset.verdict, corrected: ex.en, errors: [] };
    await applyResult(ex, S.session.answer, fb);
    await nextExercise();
  },
  'quit-session': async () => {
    if (!confirm('Terminare la sessione? Le risposte già date restano salvate.')) return;
    S.session = null;
    await saveSession();
    render();
  },
  'end-session': async () => {
    S.session = null;
    await saveSession();
    render();
  },
  'flash-kind': (el) => {
    const k = el.dataset.kind;
    if (ui.flashKinds.has(k)) ui.flashKinds.delete(k);
    else ui.flashKinds.add(k);
    render();
  },
  'flash-dir': (el) => {
    ui.flashDir = el.dataset.dir;
    render();
  },
  'flash-start': () => startFlash(),
  'flash-retry': () => startFlash([...ui.flash.missed]),
  'flash-flip': () => {
    if (ui.flash.flipped) return;
    ui.flash.flipped = true;
    render();
  },
  'flash-grade': (el) => gradeFlash(el.dataset.ok === '1'),
  'flash-quit': () => {
    ui.flash = null;
    render();
  },
  'lib-tab': (el) => {
    ui.libTab = el.dataset.tab;
    renderLibrary();
  },
  'add-item': () => itemForm(null),
  'edit-item': (el) => itemForm(findItem(el.dataset.id)),
  'delete-item': async (el) => {
    if (!confirm('Eliminare questo elemento?')) return;
    deleteItem(el.dataset.id);
    await saveData();
    closeModal();
    render();
  },
  'import-file': () => $('#file-input').click(),
  'paste-list': pasteListForm,
  'paste-parse': () => analyzeText($('#paste-text').value, false),
  'paste-ai': () => analyzeText($('#paste-text').value, true),
  'save-preview': savePreview,
  reclassify,
  'save-reclassify': saveReclassify,
  'close-modal': closeModal,
  'test-ai': async () => {
    toast('Provo la connessione…');
    try {
      const out = await ai.askJSON(S.settings, 'Rispondi solo con JSON.', 'Restituisci {"ok": true}', 0);
      toast(out.ok ? 'Connessione AI funzionante ✓' : 'Risposta inattesa dall\'AI', !out.ok);
    } catch (e) {
      toast(e.message, true);
    }
  },
  'sync-now': syncNow,
  export: exportBackup,
  'import-backup': () => $('#backup-input').click(),
  wipe: async () => {
    if (!confirm('Cancellare parole, regole e cronologia? (Le impostazioni restano.)')) return;
    const deleted = { ...S.data.deleted };
    for (const i of S.data.items) deleted[i.id] = Date.now();
    await replaceData({ items: [], attempts: [], deleted });
    S.session = null;
    await saveSession();
    render();
  },
};

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav], .tabbar button');
  if (nav) return navigate(nav.dataset.nav || nav.dataset.view);
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) {
    e.preventDefault();
    actions[el.dataset.action](el);
  }
});

$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' && !ui.preview) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'answer') {
    e.preventDefault();
    checkAnswer();
  }
});

$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importFile(file);
});
$('#backup-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importBackup(file);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow();
});
window.addEventListener('online', syncNow);

// ---------- Avvio ----------
(async function init() {
  await load();
  if (S.session?.phase === 'loading') S.session = null;
  if (S.session?.phase === 'checking') S.session.phase = 'answer';
  setOnDataChange(scheduleSync);
  ai.setOnModelChange(async (provider, model) => {
    await saveSettings();
    toast(`${provider}: il modello precedente non è più disponibile, ora uso ${model}`);
    if (ui.current === 'settings') renderSettings();
  });
  setSyncState(S.settings.gistToken ? 'ok' : 'off');
  render();
  syncNow();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
