# English Tutor – app personale per imparare l'inglese

App installabile su telefono e PC (PWA) che:

- conserva il tuo archivio di **parole, espressioni e regole grammaticali** (inserimento manuale, lista incollata o file TXT/CSV/PDF/DOCX);
- genera con l'AI **frasi in italiano da tradurre in inglese**, costruite solo sul materiale che hai caricato;
- **corregge** la traduzione, distingue errori veri da alternative valide e spiega cosa cambiare;
- registra ogni errore e decide **cosa ripassare e quando** (spaced repetition gestito dal codice, non dall'AI);
- permette di rispondere **a voce** 🎤 e di **ascoltare** la frase corretta 🔊.

Costo: **zero**. Funziona anche quando il PC è spento.

## Come funziona (architettura)

- **App**: HTML + JavaScript senza build, pubblicata gratis su **GitHub Pages** → sempre online, raggiungibile da qualsiasi dispositivo.
- **Dati**: salvati sul dispositivo (IndexedDB). L'app si apre e mostra archivio e progressi anche offline.
- **Sincronizzazione PC ↔ telefono**: un **Gist privato** di GitHub fa da archivio condiviso. Le modifiche fatte su dispositivi diversi vengono unite (vince la versione più recente di ogni elemento).
- **AI**: chiamate dirette a **Gemini** (piano gratuito); **Groq** (gratuito) subentra in automatico se Gemini esaurisce la quota.
- **Senza AI** (offline o quota finita): l'app mostra la traduzione di riferimento e ti fa autovalutare, così il ripasso non si ferma.
- **Risparmio di chiamate**: una sola richiesta genera tutta la sessione (10 frasi), poi una richiesta breve per ogni correzione.

Le chiavi API **non sono nel codice**: le inserisci nelle Impostazioni e restano solo nel browser di quel dispositivo (non vengono sincronizzate).

## Pubblicazione (una volta sola, ~10 minuti)

1. Su GitHub crea un nuovo repository, ad esempio `english-tutor` (può essere pubblico: non contiene dati né chiavi).
2. Carica **il contenuto** di questa cartella (`index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`, `js/`, `icons/`) nella radice del repository.
3. Nel repository: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
4. Dopo un minuto l'app è online su `https://<tuo-utente>.github.io/english-tutor/`.

## Chiavi gratuite

- **Gemini** (consigliata): https://aistudio.google.com/apikey → "Create API key". Nel piano gratuito Google può usare i contenuti inviati per migliorare i suoi prodotti: non inserire dati personali nei file che carichi.
- **Groq** (riserva, facoltativa): https://console.groq.com/keys.
- **Token GitHub per la sincronizzazione**: https://github.com/settings/tokens/new?scopes=gist → spunta solo **gist** → genera. Usa lo stesso token su PC e telefono.

## Installazione

- **Android (Chrome)**: apri il link → menu ⋮ → **Installa app** (o "Aggiungi a schermata Home").
- **iPhone (Safari)**: apri il link → Condividi → **Aggiungi alla schermata Home**.
- **PC (Chrome/Edge)**: icona di installazione nella barra degli indirizzi, oppure usala come normale sito.

Poi, su ogni dispositivo: **Impostazioni → incolla chiave Gemini (e Groq) → incolla token GitHub**. Il secondo dispositivo trova da solo l'archivio creato dal primo.

## Formato rapido per liste e file TXT/CSV

Una voce per riga (separatori `=`, `;`, tab o ` - `):

```
rely on = contare su
put off ; rimandare
take for granted - dare per scontato
regola: Third conditional = ipotesi nel passato non realizzate (if + past perfect, would have + participio)
```

Qualsiasi altro testo (appunti, PDF di grammatica, esercizi) viene analizzato dall'AI, che estrae parole e regole e te le mostra in anteprima prima di salvarle.

## Struttura del codice

- `js/app.js` – interfaccia (Pratica, Archivio, Progressi, Impostazioni)
- `js/ai.js` – prompt, chiamate a Gemini/Groq, validazione del JSON
- `js/srs.js` – spaced repetition (scatole di Leitner) e scelta degli elementi da allenare
- `js/store.js` – stato, salvataggio e merge per la sincronizzazione
- `js/sync.js` – sincronizzazione tramite Gist
- `js/importer.js` – lettura di PDF/DOCX/TXT e parsing delle liste
- `sw.js` – service worker (installazione e funzionamento offline)

## Provarla in locale

```bash
python -m http.server 8000
```

e apri http://localhost:8000 (serve un server: aprendo `index.html` con doppio clic il service worker non funziona).

## Se qualcosa smette di funzionare

- **"Gemini 404"**: il modello è stato ritirato → in Impostazioni scrivi un modello attuale (lista su AI Studio).
- **"429 quota esaurita"**: aspetta o aggiungi la chiave Groq come riserva.
- **Dopo un aggiornamento del codice** l'app scarica la nuova versione alla prima apertura online; se vedi ancora la vecchia, chiudila e riaprila.
