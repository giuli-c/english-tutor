import { t } from './i18n.js';

// Lettura dei file caricati (TXT, MD, CSV, PDF, DOCX) e parsing delle liste "parola = significato".
// Le librerie per PDF e Word vengono scaricate solo quando servono.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(t('file.libFailed')));
    document.head.appendChild(el);
  });
}

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

async function readPdf(file) {
  await loadScript(PDFJS);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    pages.push(content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join(''));
  }
  return pages.join('\n\n');
}

async function readDocx(file) {
  await loadScript(MAMMOTH);
  const out = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return out.value;
}

export async function readFileText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return readPdf(file);
  if (name.endsWith('.docx')) return readDocx(file);
  if (name.endsWith('.doc')) throw new Error(t('file.doc'));
  return file.text();
}

// Separa dal significato le frasi di esempio in inglese, es.
// "alzare il volume - Turn up the volume." -> meaning "alzare il volume", example "Turn up the volume."
// Un segmento (dopo il primo) è un esempio se contiene una parola del termine
// o parole tipicamente inglesi che non esistono in italiano.
const ENGLISH = /\b(I|you|he|she|we|they|the|is|are|was|were|my|your|his|her|their|don't|can't|I'm|it's|It's|He's|She's|You're)\b/;
export function splitMeaning(term, meaning) {
  const segments = meaning.split(/\s+[-–—]\s+/);
  if (segments.length < 2) return { meaning, example: '' };
  const tokens = term.toLowerCase().split(/\s+/).filter((t) => t.length >= 3 && !['someone', 'something', 'the'].includes(t));
  const isExample = (seg) => tokens.some((t) => seg.toLowerCase().includes(t)) || ENGLISH.test(seg);
  const keep = [segments[0]];
  const examples = [];
  for (const seg of segments.slice(1)) (isExample(seg) ? examples : keep).push(seg);
  return { meaning: keep.join(' - '), example: examples.join(' / ') };
}

// Formato rapido, una voce per riga:
//   rely on = contare su
//   put off ; rimandare
//   phrasal: give up = arrendersi, smettere
//   regola: Present perfect = azioni passate con effetti sul presente
export function parseQuickList(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let kind = 'word';
    const prefix = line.match(/^(regola|rule|grammatica|regel|grammatik|phrasal verb|phrasal)\s*:\s*/i);
    if (prefix) {
      kind = prefix[1].toLowerCase().startsWith('phrasal') ? 'phrasal' : 'rule';
      line = line.slice(prefix[0].length);
    }
    const parts = line.split(/\s*(?:=|;|\t|\s[-–—]\s)\s*/);
    if (parts.length < 2 || !parts[0]) continue;
    const { meaning, example } = kind === 'rule' ? { meaning: parts.slice(1).join(' - '), example: '' } : splitMeaning(parts[0], parts.slice(1).join(' - '));
    items.push({ kind, term: parts[0], meaning, notes: '', example, topic: '' });
  }
  return items;
}
