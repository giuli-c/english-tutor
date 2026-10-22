import { S, KINDS, load, saveData, saveSettings, saveSession, replaceData, addItem, deleteItem, findItem, isDuplicate, merge, setOnDataChange } from './store.js';
import { planSession, pickCards, review, mastery, isDue } from './srs.js';
import * as ai from './ai.js';
import { readFileText, parseQuickList, splitMeaning } from './importer.js';
import * as sync from './sync.js';
import { LANGS, t, setLang, getLang, langInfo } from './i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kindLabel = (kind, form = 'many') => t(`kind.${kind}.${form}`);

const ui = {
  current: 'practice', libTab: 'word', libQuery: '', preview: null, syncState: 'off', syncMsg: '',
  // Flashcard: categorie scelte, direzione e mazzo in corso.
  flashKinds: new Set(Object.keys(KINDS)), flashDir: 'en-it', flash: null,
  // Quiz di grammatica in corso.
  quiz: null,
};

// ---------- Lingua ----------
// Aggiorna le parti fisse della pagina (barra in basso, menu della lingua) e ridisegna la vista.
function applyLang() {
  setLang(S.settings.lang);
  document.documentElement.lang = getLang();
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  const select = $('#lang-select');
  select.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === getLang() ? 'selected' : ''}>${v.label}</option>`).join('');
  $('#sync-dot').title = syncLabel();
}

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
const listNames = (items, moreKey) => items.slice(0, 3).map((i) => i.term).join(', ') + (items.length > 3 ? t(moreKey, { n: items.length - 3 }) : '');

function speak(text) {
  if (!('speechSynthesis' in window)) return toast(t('tts.unsupported'), true);
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
  rec.onerror = (e) => toast(t('mic.error', { e: e.error }), true);
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
  if (ui.quiz) return renderQuiz();
  if (ui.flash) return renderFlash();
  const sess = S.session;
  if (!sess) return renderPracticeHome();
  if (sess.phase === 'loading') return (view.innerHTML = loading(t('session.loading')));
  if (sess.phase === 'done') return renderSessionEnd();

  const ex = sess.exercises[sess.index];
  const head = `
    <div class="row between muted small"><span>${t('session.progress', { i: sess.index + 1, n: sess.exercises.length })}</span>
      <button class="link" data-action="quit-session">${t('common.end')}</button></div>
    ${bar(Math.round((sess.index / sess.exercises.length) * 100))}
    <div class="card">
      <div class="label">${t('session.translate')}</div>
      <p class="sentence">${esc(ex.it)}</p>
      ${ex.hint ? `<details class="hint"><summary>${t('session.hint')}</summary>${esc(ex.hint)}</details>` : ''}
    </div>`;

  if (sess.phase === 'answer' || sess.phase === 'checking') {
    const busy = sess.phase === 'checking';
    view.innerHTML = `${head}
      <div class="card">
        <textarea id="answer" rows="3" placeholder="${t('session.placeholder')}" autocapitalize="sentences" ${busy ? 'disabled' : ''}>${esc(sess.answer || '')}</textarea>
        <div class="row gap">
          ${Recognition ? `<button class="btn ghost icon" data-action="mic" title="${t('session.mic')}" ${busy ? 'disabled' : ''}>🎤</button>` : ''}
          <button class="btn ghost" data-action="skip" ${busy ? 'disabled' : ''}>${t('session.dontKnow')}</button>
          <button class="btn primary grow" data-action="check" ${busy ? 'disabled' : ''}>${busy ? t('session.checking') : t('session.check')}</button>
        </div>
        ${busy ? `<button class="link small" data-action="skip-wait">${t('session.skipWait')}</button>` : ''}
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
        <p class="muted small">${t('session.noAi', { err: fb.error ? ` (${esc(fb.error)})` : '' })}</p>
        <div class="label">${t('session.yourAnswer')}</div><p>${esc(sess.answer)}</p>
        <div class="label">${t('session.reference')}</div><p class="good-text">${esc(ex.en)} <button class="link" data-action="speak" data-text="${esc(ex.en)}">🔊</button></p>
        ${ex.alternatives.length ? `<div class="label">${t('session.alternatives')}</div><ul>${ex.alternatives.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
        <div class="row gap">
          <button class="btn bad grow" data-action="self" data-verdict="wrong">${t('session.selfWrong')}</button>
          <button class="btn warn grow" data-action="self" data-verdict="minor">${t('session.selfMinor')}</button>
          <button class="btn good grow" data-action="self" data-verdict="correct">${t('session.selfCorrect')}</button>
        </div>
      </div>`;
  } else {
    const badge = { correct: ['good', t('session.badgeCorrect')], minor: ['warn', t('session.badgeMinor')], wrong: ['bad', t('session.badgeWrong')] }[fb.verdict];
    const best = fb.natural || fb.corrected || ex.en;
    body = `
      <div class="card">
        <span class="badge ${badge[0]}">${badge[1]}</span>
        ${sess.answer ? `<div class="label">${t('session.yourAnswer')}</div><p>${esc(sess.answer)}</p>` : ''}
        ${fb.verdict !== 'correct' && fb.corrected ? `<div class="label">${t('session.corrected')}</div><p class="good-text">${esc(fb.corrected)}</p>` : ''}
        <div class="label">${t('session.native')}</div>
        <p>${esc(best)} <button class="link" data-action="speak" data-text="${esc(best)}">🔊</button></p>
        ${fb.explanation ? `<div class="label">${t('session.explanation')}</div><p>${esc(fb.explanation)}</p>` : ''}
        ${fb.errors?.length ? `<div class="label">${t('session.errors')}</div><ul>${fb.errors.map((e) => `<li><b>${esc(errorLabel(e.type))}</b>: ${esc(e.what)}</li>`).join('')}</ul>` : ''}
        <button class="btn primary full" data-action="next">${t('common.next')}</button>
      </div>`;
  }
  view.innerHTML = head + body;
}

const ERROR_TYPES = ['grammar', 'vocabulary', 'spelling', 'word_order', 'missing'];
const errorLabel = (type) => t(ERROR_TYPES.includes(type) ? `error.${type}` : 'error.other');

function renderPracticeHome() {
  const items = S.data.items;
  const due = items.filter((i) => isDue(i)).length;
  const count = (kind) => items.filter((i) => i.kind === kind).length;
  let action;
  if (!items.length) {
    action = `<p>${t('home.empty')}</p>
      <button class="btn primary full" data-nav="library">${t('home.goLibrary')}</button>`;
  } else if (!ai.hasProvider(S.settings)) {
    action = `<p>${t('home.needKey')}</p>
      <button class="btn primary full" data-nav="settings">${t('home.configureAi')}</button>`;
  } else {
    const focus = focusItems();
    action = `
      <div class="focus-summary small">
        <span>🎯 ${focus.length ? t('home.topics', { names: esc(listNames(focus, 'common.andOthers')) }) : t('home.topicsAuto')}</span>
        <button class="link" data-action="focus-open">${focus.length ? t('home.topicsEdit') : t('home.topicsChoose')}</button>
      </div>
      <button class="btn primary full big" data-action="start">${t('home.start', { n: S.settings.sessionSize })}</button>`;
  }
  view.innerHTML = `
    <div class="card hero">
      <h2>${t('home.hello')}</h2>
      <ul class="stats four">
        <li><b>${count('word')}</b> ${t('home.words')}</li>
        <li><b>${count('phrasal')}</b> ${t('home.phrasal')}</li>
        <li><b>${count('rule')}</b> ${t('home.rules')}</li>
        <li><b>${due}</b> ${t('home.due')}</li>
      </ul>
      <h3>${t('home.translationTitle')}</h3>
      ${action}
    </div>
    ${items.length ? flashHome(count) : ''}
    ${count('rule') ? quizHome() : ''}
    <p class="muted small center">${t('home.footer')}</p>`;
}

// ---------- FLASHCARD ----------
const flashPool = () => S.data.items.filter((i) => ui.flashKinds.has(i.kind));

function flashHome(count) {
  const n = Math.min(20, flashPool().length);
  return `
    <div class="card">
      <h3>${t('flash.title')}</h3>
      <p class="muted small">${t('flash.intro')}</p>
      <div class="chips">
        ${Object.keys(KINDS).map((k) => `
          <button class="chip ${ui.flashKinds.has(k) ? 'active' : ''}" data-action="flash-kind" data-kind="${k}">${kindLabel(k)} · ${count(k)}</button>`).join('')}
      </div>
      <div class="segmented">
        <button class="${ui.flashDir === 'en-it' ? 'active' : ''}" data-action="flash-dir" data-dir="en-it">${t('flash.enToNative')}</button>
        <button class="${ui.flashDir === 'it-en' ? 'active' : ''}" data-action="flash-dir" data-dir="it-en">${t('flash.nativeToEn')}</button>
      </div>
      <button class="btn primary full" data-action="flash-start" ${n ? '' : 'disabled'}>${n ? t('flash.start', { n }) : t('flash.none')}</button>
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
        <h2>${t('flash.doneTitle')}</h2>
        <ul class="stats">
          <li><b class="good-text">${known}</b> ${t('flash.known')}</li>
          <li><b class="bad-text">${f.missed.length}</b> ${t('flash.missed')}</li>
          <li><b>${f.cards.length}</b> ${t('flash.cards')}</li>
        </ul>
        ${f.missed.length ? `<button class="btn primary full" data-action="flash-retry">${t('flash.retry', { n: f.missed.length })}</button>` : ''}
        <button class="btn ${f.missed.length ? 'ghost' : 'primary'} full" data-action="flash-quit">${t('common.done')}</button>
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
    <div class="row between muted small"><span>${t('flash.progress', { i: f.index + 1, n: f.cards.length })}</span>
      <button class="link" data-action="flash-quit">${t('common.end')}</button></div>
    ${bar(Math.round((f.index / f.cards.length) * 100))}
    <div class="card flashcard" data-action="flash-flip">
      <span class="tag">${kindLabel(item.kind, 'one')}</span>
      <p class="sentence">${esc(front)}</p>
      ${f.flipped ? `
        <hr>
        <p class="sentence good-text">${esc(back)}</p>
        ${item.notes ? `<p class="small">${esc(item.notes)}</p>` : ''}
        ${item.example ? `<p class="small muted"><i>${esc(item.example)}</i></p>` : ''}
        <button class="link" data-action="speak" data-text="${esc(item.example || item.term)}">${t('common.listen')}</button>`
      : `<p class="muted small">${t('flash.tap')}</p>`}
    </div>
    ${f.flipped ? `
      <div class="row gap">
        <button class="btn bad grow" data-action="flash-grade" data-ok="0">${t('flash.forgot')}</button>
        <button class="btn good grow" data-action="flash-grade" data-ok="1">${t('flash.remembered')}</button>
      </div>` : `<button class="btn primary full" data-action="flash-flip">${t('flash.show')}</button>`}`;
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

// ---------- QUIZ DI GRAMMATICA ----------
// Domande a scelta multipla sulle regole. Le genera l'AI la prima volta e restano
// salvate nella regola (anche offline); si rinnovano ogni due settimane o se cambia la lingua.
const QUIZ_SIZE = 10;
const QUIZ_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const quizRules = () => {
  const sel = S.settings.quizRuleIds.map(findItem).filter(Boolean);
  return sel.length ? sel : S.data.items.filter((i) => i.kind === 'rule');
};
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function quizHome() {
  const sel = S.settings.quizRuleIds.map(findItem).filter(Boolean);
  return `
    <div class="card">
      <h3>${t('quiz.title')}</h3>
      <p class="muted small">${t('quiz.intro')}</p>
      <div class="focus-summary small">
        <span>${t('quiz.rules', { names: sel.length ? esc(listNames(sel, 'common.andOtherRules')) : t('quiz.all') })}</span>
        <button class="link" data-action="quiz-rules">${t('common.choose')}</button>
      </div>
      <button class="btn primary full" data-action="quiz-start">${t('quiz.start', { n: QUIZ_SIZE })}</button>
    </div>`;
}

async function startQuiz(cards) {
  if (!cards) {
    // Al massimo 10 regole per quiz, le più da ripassare.
    const rules = pickCards(quizRules(), QUIZ_SIZE);
    const stale = rules.filter((r) => !r.quiz || Date.now() - r.quiz.createdAt > QUIZ_MAX_AGE || (r.quiz.lang || 'it') !== getLang());
    if (stale.length && ai.hasProvider(S.settings) && navigator.onLine) {
      view.innerHTML = loading(t('quiz.loading'));
      try {
        const quizzes = await ai.generateQuizzes(S.settings, stale);
        for (const [id, quiz] of quizzes) Object.assign(findItem(id), { quiz, updatedAt: Date.now() });
        await saveData();
      } catch (e) {
        toast(t('quiz.genFailed', { e: e.message }), true);
      }
    }
    const ready = rules.filter((r) => r.quiz?.questions.length);
    if (!ready.length) {
      render();
      return toast(t('quiz.noQuestions'), true);
    }
    // Domande distribuite a turno tra le regole, senza ripetizioni.
    const pools = new Map(ready.map((r) => [r.id, shuffle([...r.quiz.questions.keys()])]));
    cards = [];
    while (cards.length < QUIZ_SIZE && [...pools.values()].some((p) => p.length)) {
      for (const [id, pool] of pools) if (pool.length && cards.length < QUIZ_SIZE) cards.push({ id, q: pool.pop() });
    }
    cards = shuffle(cards);
  }
  // L'ordine delle opzioni viene mescolato per ogni carta.
  ui.quiz = { cards: cards.map((c) => ({ ...c, order: null })), index: 0, chosen: null, wrong: [] };
  render();
}

function renderQuiz() {
  const z = ui.quiz;
  if (z.index >= z.cards.length) {
    const right = z.cards.length - z.wrong.length;
    view.innerHTML = `
      <div class="card hero">
        <h2>${t('quiz.doneTitle')}</h2>
        <ul class="stats">
          <li><b class="good-text">${right}</b> ${t('quiz.right')}</li>
          <li><b class="bad-text">${z.wrong.length}</b> ${t('quiz.wrong')}</li>
          <li><b>${z.cards.length}</b> ${t('quiz.questions')}</li>
        </ul>
        ${z.wrong.length ? `<button class="btn primary full" data-action="quiz-retry">${t('quiz.retry', { n: z.wrong.length })}</button>` : ''}
        <button class="btn ${z.wrong.length ? 'ghost' : 'primary'} full" data-action="quiz-quit">${t('common.done')}</button>
      </div>`;
    return;
  }
  const card = z.cards[z.index];
  const item = findItem(card.id);
  const q = item?.quiz?.questions[card.q];
  if (!q) {
    z.index++;
    return renderQuiz();
  }
  card.order ??= shuffle([...q.options]);
  const answered = z.chosen !== null;
  const ok = answered && z.chosen === q.a;
  view.innerHTML = `
    <div class="row between muted small"><span>${t('quiz.progress', { i: z.index + 1, n: z.cards.length })}</span>
      <button class="link" data-action="quiz-quit">${t('common.end')}</button></div>
    ${bar(Math.round((z.index / z.cards.length) * 100))}
    <div class="card flashcard">
      <span class="tag">${esc(item.term)}</span>
      <p class="sentence">${esc(q.s)}</p>
      ${answered ? `
        <hr>
        <p class="${ok ? 'good-text' : 'bad-text'}"><b>${ok ? t('quiz.correct') : t('quiz.incorrect', { a: esc(q.a) })}</b></p>
        <p>${esc(q.full)} <button class="link" data-action="speak" data-text="${esc(q.full)}">🔊</button></p>
        ${q.why ? `<p class="small muted">${esc(q.why)}</p>` : ''}`
      : `<p class="muted small">${t('quiz.which')}</p>`}
    </div>
    <div class="list">
      ${card.order.map((o) => {
        const cls = !answered ? 'ghost' : o === q.a ? 'good' : o === z.chosen ? 'bad' : 'ghost';
        return `<button class="btn ${cls} full" data-action="quiz-pick" data-opt="${esc(o)}" ${answered ? 'disabled' : ''}>${esc(o)}</button>`;
      }).join('')}
    </div>
    ${answered ? `<button class="btn primary full" data-action="quiz-next">${t('common.next')}</button>` : ''}`;
}

async function pickQuizAnswer(option) {
  const z = ui.quiz;
  const card = z.cards[z.index];
  const item = findItem(card.id);
  z.chosen = option;
  const ok = option === item.quiz.questions[card.q].a;
  review(item, ok);
  if (!ok) z.wrong.push({ id: card.id, q: card.q });
  render();
  await saveData();
}

function renderSessionEnd() {
  const r = S.session.results;
  const count = (v) => r.filter((x) => x === v).length;
  view.innerHTML = `
    <div class="card hero">
      <h2>${t('session.doneTitle')}</h2>
      <ul class="stats">
        <li><b class="good-text">${count('correct')}</b> ${t('session.doneCorrect')}</li>
        <li><b class="warn-text">${count('minor')}</b> ${t('session.doneMinor')}</li>
        <li><b class="bad-text">${count('wrong')}</b> ${t('session.doneWrong')}</li>
      </ul>
      <button class="btn primary full" data-action="new-session">${t('session.new')}</button>
      <button class="btn ghost full" data-action="end-session">${t('session.home')}</button>
    </div>`;
}

const focusItems = () => S.settings.focusIds.map(findItem).filter(Boolean);

// Finestra di scelta degli argomenti, usata per gli esercizi (focusIds) e per il quiz (quizRuleIds).
function focusForm({ key = 'focusIds', kinds = ['rule', 'phrasal', 'word'], title = t('focus.title'), hint = t('focus.hint') } = {}) {
  ui.focusKey = key;
  const sel = new Set(S.settings[key]);
  const short = (s) => (s.length > 70 ? s.slice(0, 70) + '…' : s);
  const group = (kind) => {
    const list = S.data.items.filter((i) => i.kind === kind).sort((a, b) => a.term.localeCompare(b.term));
    if (!list.length) return '';
    return `
      <details ${kind === 'word' ? '' : 'open'}>
        <summary><b>${kindLabel(kind)}</b> (${list.length})</summary>
        <div class="row gap"><button class="link" data-action="focus-all" data-kind="${kind}">${t('focus.all')}</button><button class="link" data-action="focus-none" data-kind="${kind}">${t('focus.none')}</button></div>
        ${list.map((i) => `
          <label class="check">
            <input type="checkbox" data-id="${i.id}" data-kind="${kind}" ${sel.has(i.id) ? 'checked' : ''}>
            <span><b>${esc(i.term)}</b><br><span class="muted small">${esc(short(i.meaning))}</span></span>
          </label>`).join('')}
      </details>`;
  };
  openModal(`
    <h3>${title}</h3>
    <p class="muted small">${hint}</p>
    <input id="focus-search" type="search" placeholder="${t('common.search')}">
    <div class="list preview focus-list">${kinds.map(group).join('')}</div>
    <div class="row gap">
      <button class="btn ghost grow" data-action="focus-clear">${t('focus.clear')}</button>
      <button class="btn primary grow" data-action="focus-save">${t('focus.save')}</button>
    </div>`);
  $('#focus-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.focus-list .check').forEach((l) => l.classList.toggle('hidden', !l.textContent.toLowerCase().includes(q)));
    if (q) document.querySelectorAll('.focus-list details').forEach((d) => (d.open = true));
  });
}

async function saveFocus(ids) {
  S.settings[ui.focusKey] = ids;
  await saveSettings();
  closeModal();
  render();
}

async function startSession() {
  // Con argomenti scelti si lavora solo su quelli. Il piano privilegia gli elementi
  // usati in meno frasi finora (contati dai tentativi salvati).
  const focus = focusItems();
  const usage = new Map();
  for (const a of S.data.attempts) for (const id of a.itemIds || []) usage.set(id, (usage.get(id) || 0) + 1);
  const plan = planSession(focus.length ? focus : S.data.items, S.settings.sessionSize, usage);
  S.session = { phase: 'loading' };
  render();
  try {
    const exercises = await ai.generateExercises(S.settings, plan);
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
  if (!answer) return toast(t('session.writeFirst'));
  const ex = sess.exercises[sess.index];
  sess.answer = answer;
  sess.phase = 'checking';
  const token = (sess.checkToken = Date.now());
  render();
  // Se nel frattempo si è scelto di non aspettare, la risposta arrivata in ritardo va ignorata.
  const stale = () => S.session !== sess || sess.checkToken !== token;
  try {
    const items = ex.itemIds.map(findItem).filter(Boolean);
    const fb = await ai.correctAnswer(S.settings, ex, answer, items);
    if (stale()) return;
    sess.feedback = { ...fb, source: 'ai' };
    await applyResult(ex, answer, fb);
  } catch (e) {
    if (stale()) return;
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
      ${Object.keys(KINDS).map((k) => `<button class="${ui.libTab === k ? 'active' : ''}" data-action="lib-tab" data-tab="${k}">${kindLabel(k)}</button>`).join('')}
    </div>
    <div class="row gap wrap">
      <button class="btn primary grow" data-action="add-item">${t('lib.add')}</button>
      <button class="btn ghost grow" data-action="import-file">${t('lib.import')}</button>
      <button class="btn ghost grow" data-action="paste-list">${t('lib.paste')}</button>
      ${S.data.items.length ? `<button class="btn ghost grow" data-action="reclassify">${t('lib.fix')}</button>` : ''}
    </div>
    <input id="lib-search" type="search" placeholder="${t('common.search')}" value="${esc(ui.libQuery)}">
    ${list.length ? '' : `<p class="muted center">${q ? t('lib.notFound') : t('lib.empty')}</p>`}
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
    <h3>${item ? t('item.edit') : t('item.new')}</h3>
    <form id="item-form">
      <label>${t('item.kind')}<select name="kind">${Object.keys(KINDS).map((k) => `<option value="${k}" ${i.kind === k ? 'selected' : ''}>${kindLabel(k)}</option>`).join('')}</select></label>
      <label>${t('item.term')}<input name="term" required value="${esc(i.term)}" placeholder="${t('item.termPlaceholder')}"></label>
      <label>${t('item.meaning')}<textarea name="meaning" rows="2">${esc(i.meaning)}</textarea></label>
      <label>${t('item.notes')}<textarea name="notes" rows="2">${esc(i.notes)}</textarea></label>
      <label>${t('item.example')}<input name="example" value="${esc(i.example)}"></label>
      <label>${t('item.topic')}<input name="topic" value="${esc(i.topic)}"></label>
      ${item ? `<p class="muted small">${t('item.stats', { n: i.srs.correct + i.srs.wrong, ok: i.srs.correct, ko: i.srs.wrong })}</p>` : ''}
      <div class="row gap">
        ${item ? `<button type="button" class="btn bad" data-action="delete-item" data-id="${i.id}">${t('common.delete')}</button>` : ''}
        <button type="button" class="btn ghost grow" data-action="close-modal">${t('common.cancel')}</button>
        <button type="submit" class="btn primary grow">${t('common.save')}</button>
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
    <h3>${t('paste.title')}</h3>
    <p class="muted small">${t('paste.help')}</p>
    <textarea id="paste-text" rows="8"></textarea>
    <div class="row gap wrap">
      <button class="btn ghost grow" data-action="close-modal">${t('common.cancel')}</button>
      <button class="btn ghost grow" data-action="paste-parse">${t('paste.add')}</button>
      <button class="btn primary grow" data-action="paste-ai">${t('paste.ai')}</button>
    </div>`);
}

async function analyzeText(text, useAI) {
  if (!text.trim()) return toast(t('paste.noText'));
  let items;
  if (useAI) {
    if (!ai.hasProvider(S.settings)) return toast(t('common.configureKeyFirst'), true);
    openModal(loading(t('paste.extracting')));
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
    return toast(useAI ? t('paste.nothingAi') : t('paste.nothingList'), true);
  }
  showPreview(items);
}

function showPreview(items) {
  ui.preview = items.map((i) => ({ ...i, dup: isDuplicate(i.kind, i.term) }));
  openModal(`
    <h3>${t('preview.found', { n: items.length })}</h3>
    <p class="muted small">${t('preview.help')}</p>
    <div class="list preview">
      ${ui.preview.map((i, n) => `
        <label class="check">
          <input type="checkbox" data-n="${n}" ${i.dup ? '' : 'checked'}>
          <span><b>${esc(i.term)}</b> <span class="tag">${kindLabel(i.kind, 'one')}</span>${i.dup ? ` <span class="tag">${t('preview.dup')}</span>` : ''}<br>
          <span class="muted small">${esc(i.meaning)}</span></span>
        </label>`).join('')}
    </div>
    <div class="row gap">
      <button class="btn ghost grow" data-action="close-modal">${t('common.cancel')}</button>
      <button class="btn primary grow" data-action="save-preview">${t('preview.save')}</button>
    </div>`);
}

// Sistema l'archivio: sposta gli esempi inglesi fuori dal significato (codice)
// e corregge le categorie (AI). Tutte le modifiche passano da un'anteprima.
async function reclassify() {
  const changes = new Map();
  for (const item of S.data.items) {
    if (item.kind === 'rule') continue;
    const { meaning, example } = splitMeaning(item.term, item.meaning);
    if (example) changes.set(item.id, { id: item.id, meaning, example: item.example ? `${item.example} / ${example}` : example });
  }
  let aiError = '';
  if (ai.hasProvider(S.settings)) {
    openModal(loading(t('fix.checking')));
    try {
      const kinds = await ai.classifyItems(S.settings, S.data.items, (n, tot) => {
        if (tot > 1) openModal(loading(t('fix.checkingChunk', { n, tot })));
      });
      for (const c of kinds) changes.set(c.id, { ...(changes.get(c.id) || { id: c.id }), kind: c.kind });
    } catch (e) {
      aiError = e.message;
    }
  } else {
    aiError = t('common.noKey');
  }
  const list = [...changes.values()];
  if (!list.length) {
    closeModal();
    return aiError ? toast(t('fix.failed', { e: aiError }), true) : toast(t('fix.ok'));
  }
  ui.preview = list;
  openModal(`
    <h3>${t('fix.title', { n: list.length })}</h3>
    ${aiError ? `<p class="small bad-text">${t('fix.noCategories', { e: esc(aiError) })}</p>` : ''}
    <p class="muted small">${t('fix.help')}</p>
    <div class="list preview">
      ${list.map((c, n) => {
        const item = findItem(c.id);
        return `
        <label class="check">
          <input type="checkbox" data-n="${n}" checked>
          <span><b>${esc(item.term)}</b><br>
          ${c.kind ? `<span class="muted small">${kindLabel(item.kind)} → <b>${kindLabel(c.kind)}</b></span><br>` : ''}
          ${c.example ? `<span class="muted small">${t('fix.meaning')}: <b>${esc(c.meaning)}</b><br>${t('fix.example')}: <i>${esc(c.example)}</i></span>` : ''}</span>
        </label>`;
      }).join('')}
    </div>
    <div class="row gap">
      <button class="btn ghost grow" data-action="close-modal">${t('common.cancel')}</button>
      <button class="btn primary grow" data-action="save-reclassify">${t('fix.apply')}</button>
    </div>`);
}

async function saveReclassify() {
  const checked = [...document.querySelectorAll('.preview input:checked')].map((c) => ui.preview[+c.dataset.n]);
  const now = Date.now();
  for (const { id, ...fields } of checked) {
    const item = findItem(id);
    if (item) Object.assign(item, fields, { updatedAt: now });
  }
  await saveData();
  closeModal();
  toast(t('fix.done', { n: checked.length }));
  render();
}

async function savePreview() {
  const checked = [...document.querySelectorAll('.preview input:checked')].map((c) => ui.preview[+c.dataset.n]);
  checked.forEach(addItem);
  await saveData();
  closeModal();
  toast(t('preview.added', { n: checked.length }));
  render();
}

async function importFile(file) {
  openModal(loading(t('import.reading', { name: file.name })));
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
        <li><b>${streakDays()}</b> ${t('prog.streak')}</li>
        <li><b>${recent.length ? Math.round((ok / recent.length) * 100) : 0}%</b> ${t('prog.accuracy')}</li>
        <li><b>${attempts.length}</b> ${t('prog.translated')}</li>
      </ul>
    </div>
    <h3>${t('prog.rules')}</h3>
    ${rules.length ? rules.map((r) => `
      <div class="progress-row">
        <div class="row between"><span>${esc(r.term)}</span><b>${mastery(r)}%</b></div>
        ${bar(mastery(r))}
        <div class="muted small">✓ ${r.srs.correct} · ✗ ${r.srs.wrong}</div>
      </div>`).join('') : `<p class="muted">${t('prog.noRules')}</p>`}
    <h3>${t('prog.weak')}</h3>
    ${weakWords.length ? weakWords.map((w) => `
      <div class="progress-row">
        <div class="row between"><span>${esc(w.term)} <span class="muted small">· ${esc(w.meaning)}</span></span><b>${mastery(w)}%</b></div>
        ${bar(mastery(w))}
      </div>`).join('') : `<p class="muted">${t('prog.noData')}</p>`}
    <h3>${t('prog.lastErrors')}</h3>
    ${lastErrors.length ? lastErrors.map((a) => `
      <div class="card tight">
        <p class="small">${esc(a.it)}</p>
        <p class="small bad-text">✗ ${esc(a.answer)}</p>
        <p class="small good-text">✓ ${esc(a.corrected)}</p>
      </div>`).join('') : `<p class="muted">${t('prog.noErrors')}</p>`}
    <p class="muted small center">${t('prog.footer')}</p>`;
}

// ---------- IMPOSTAZIONI ----------
function renderSettings() {
  const s = S.settings;
  view.innerHTML = `
    <form id="settings-form">
      <div class="card">
        <h3>${t('set.ai')}</h3>
        <p class="muted small">${t('set.aiHelp')}</p>
        <label>${t('set.geminiKey')} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">${t('set.getFree')}</a>
          <input name="geminiKey" type="password" autocomplete="off" value="${esc(s.geminiKey)}"></label>
        <label>${t('set.geminiModel')}<input name="geminiModel" list="gemini-models" value="${esc(s.geminiModel)}"></label>
        <datalist id="gemini-models"><option value="gemini-flash-latest"></datalist>
        <label>${t('set.groqKey')} <a href="https://console.groq.com/keys" target="_blank" rel="noopener">${t('set.getFree')}</a>
          <input name="groqKey" type="password" autocomplete="off" value="${esc(s.groqKey)}"></label>
        <label>${t('set.groqModel')}<input name="groqModel" list="groq-models" value="${esc(s.groqModel)}"></label>
        <datalist id="groq-models"><option value="openai/gpt-oss-120b"></datalist>
        <button type="button" class="btn ghost full" data-action="test-ai">${t('set.test')}</button>
      </div>
      <div class="card">
        <h3>${t('set.study')}</h3>
        <label>${t('set.level')}<select name="level">${['A2', 'B1', 'B2', 'C1'].map((l) => `<option ${s.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>${t('set.sessionSize')}<input name="sessionSize" type="number" min="3" max="25" value="${s.sessionSize}"></label>
      </div>
      <div class="card">
        <h3>${t('set.sync')}</h3>
        <p class="muted small">${t('set.syncHelp')}
          <a href="https://github.com/settings/tokens/new?scopes=gist&description=English%20Tutor" target="_blank" rel="noopener">${t('set.createToken')}</a></p>
        <label>${t('set.token')}<input name="gistToken" type="password" autocomplete="off" value="${esc(s.gistToken)}"></label>
        <p class="small">${t('set.status')}: <b>${esc(syncLabel())}</b></p>
        <button type="button" class="btn ghost full" data-action="sync-now">${t('set.syncNow')}</button>
      </div>
    </form>
    <div class="card">
      <h3>${t('set.backup')}</h3>
      <div class="row gap wrap">
        <button class="btn ghost grow" data-action="export">${t('set.export')}</button>
        <button class="btn ghost grow" data-action="import-backup">${t('set.importBackup')}</button>
      </div>
      <button class="btn bad full" data-action="wipe">${t('set.wipe')}</button>
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
    toast(t('set.saved'));
    if (tokenChanged && S.settings.gistToken) syncNow();
  });
}

function syncLabel() {
  if (!S.settings.gistToken) return t('sync.off');
  const when = S.settings.lastSync ? new Date(S.settings.lastSync).toLocaleString(langInfo().locale) : t('sync.never');
  return { syncing: t('sync.syncing'), error: t('sync.error', { e: ui.syncMsg }) }[ui.syncState] || t('sync.last', { when });
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
    if (!Array.isArray(data.items)) throw new Error(t('backup.invalid'));
    await replaceData(merge(S.data, data));
    toast(t('backup.imported'));
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
    const fb = { verdict: 'wrong', corrected: ex.en, natural: ex.en, explanation: ex.alternatives.length ? t('session.otherTranslations', { list: ex.alternatives.join(' / ') }) : '', errors: [] };
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
    if (!confirm(t('session.quitConfirm'))) return;
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
    if (!confirm(t('item.deleteConfirm'))) return;
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
  'focus-open': () => focusForm(),
  'quiz-rules': () => focusForm({ key: 'quizRuleIds', kinds: ['rule'], title: t('quiz.formTitle'), hint: t('quiz.formHint') }),
  'quiz-start': () => startQuiz(),
  'quiz-retry': () => startQuiz(ui.quiz.wrong),
  'quiz-pick': (el) => pickQuizAnswer(el.dataset.opt),
  'quiz-next': () => {
    ui.quiz.index++;
    ui.quiz.chosen = null;
    render();
  },
  'quiz-quit': () => {
    ui.quiz = null;
    render();
  },
  'focus-all': (el) => document.querySelectorAll(`.focus-list input[data-kind="${el.dataset.kind}"]`).forEach((c) => (c.checked = true)),
  'focus-none': (el) => document.querySelectorAll(`.focus-list input[data-kind="${el.dataset.kind}"]`).forEach((c) => (c.checked = false)),
  'focus-save': () => saveFocus([...document.querySelectorAll('.focus-list input:checked')].map((c) => c.dataset.id)),
  'focus-clear': () => saveFocus([]),
  'skip-wait': async () => {
    const sess = S.session;
    sess.checkToken = null;
    sess.feedback = { source: 'self', error: t('session.skipWaitReason') };
    sess.phase = 'feedback';
    await saveSession();
    render();
  },
  'close-modal': closeModal,
  'test-ai': async () => {
    toast(t('set.testing'));
    try {
      const out = await ai.askJSON(S.settings, 'Rispondi solo con JSON.', 'Restituisci {"ok": true}', 0);
      toast(out.ok ? t('set.testOk') : t('set.testBad'), !out.ok);
    } catch (e) {
      toast(e.message, true);
    }
  },
  'sync-now': syncNow,
  export: exportBackup,
  'import-backup': () => $('#backup-input').click(),
  wipe: async () => {
    if (!confirm(t('set.wipeConfirm'))) return;
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

$('#lang-select').addEventListener('change', async (e) => {
  S.settings.lang = e.target.value;
  await saveSettings();
  applyLang();
  render();
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
  applyLang();
  setOnDataChange(scheduleSync);
  ai.setOnModelChange(async (provider, model) => {
    await saveSettings();
    toast(t('model.changed', { provider, model }));
    if (ui.current === 'settings') renderSettings();
  });
  setSyncState(S.settings.gistToken ? 'ok' : 'off');
  render();
  syncNow();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
