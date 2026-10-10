// Lettura dei file caricati (TXT, MD, CSV, PDF, DOCX) e parsing delle liste "parola = significato".
// Le librerie per PDF e Word vengono scaricate solo quando servono.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Impossibile scaricare la libreria per leggere il file (serve internet).'));
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
  if (name.endsWith('.doc')) throw new Error('Il vecchio formato .doc non è supportato: salvalo come .docx o PDF.');
  return file.text();
}

// Formato rapido, una voce per riga:
//   rely on = contare su
//   put off ; rimandare
//   regola: Present perfect = azioni passate con effetti sul presente
export function parseQuickList(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let kind = 'word';
    const ruleMatch = line.match(/^(regola|rule|grammatica)\s*:\s*/i);
    if (ruleMatch) {
      kind = 'rule';
      line = line.slice(ruleMatch[0].length);
    }
    const parts = line.split(/\s*(?:=|;|\t|\s[-–—]\s)\s*/);
    if (parts.length < 2 || !parts[0]) continue;
    items.push({ kind, term: parts[0], meaning: parts.slice(1).join(' - '), notes: '', example: '', topic: '' });
  }
  return items;
}
