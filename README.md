# Turno

Web app per le scadenze degli alimenti di casa: registri la spesa (codice a barre, foto della data o a mano) e la lista mostra per primo ciò che scade prima. Gratuita, senza account e senza server: i dati restano in IndexedDB sul telefono.

File statici (HTML, CSS, JavaScript), nessuna compilazione. Funziona anche sotto un percorso come `/nome-repo/`.

## Avvio in locale

```sh
cd scado            # la cartella del repository
python3 -m http.server 8000
```

Apri `http://localhost:8000/`. Su `localhost` il browser consente fotocamera e service worker anche senza HTTPS.

## Servirla via HTTPS

Su iPhone fotocamera e modalità offline richiedono HTTPS. Va bene qualsiasi hosting statico, per esempio:

- **GitHub Pages**: Settings → Pages → *Deploy from a branch* → `main` / root. L'indirizzo sarà `https://<utente>.github.io/<repo>/`.
- **Tunnel temporaneo** per provare dal Mac: `cloudflared tunnel --url http://localhost:8000` e apri l'indirizzo `https://…trycloudflare.com` su iPhone.

Non serve configurare nulla sul server: tutti i percorsi sono relativi.

## Aggiungerla alla Home di iPhone

1. Apri l'indirizzo HTTPS in **Safari**.
2. Tocca **Condividi** → **Aggiungi alla schermata Home** → **Aggiungi**.
3. Apri Turno dall'icona, ancora con Internet, e vai in **Impostazioni → Uso offline**: attendi che «Lettore di codici» e «Lettura delle date» diventino **Pronto offline** (circa 7 MB in tutto, si scaricano da soli).
4. Da quel momento lista, inserimento manuale, scansione dei codici e lettura delle date funzionano anche in modalità aereo. Il nome dei prodotti nuovi da Open Food Facts richiede la rete; offline puoi scriverlo e verrà ricordato.

Al primo uso dello scanner iOS chiede il permesso per la fotocamera. Fai un backup ogni tanto (Impostazioni → Backup).

## Lettura della data: consigli

- Avvicina il telefono finché la data riempie la cornice ed è nitida; evita i riflessi della plastica.
- Se la fotocamera non mette a fuoco da vicino, usa **Foto nitida**: apre la fotocamera di sistema (messa a fuoco migliore) e l'app cerca la data in tutta la foto.
- Ogni foto viene letta con più filtri (contrasto, luce irregolare, stampa a punti, sole cifre). Le date senza anno, ammesse per i freschi (es. «28/11»), sono riconosciute e l'anno dedotto viene segnalato da controllare.
- Se non trova nulla, l'app mostra il testo che ha letto: aiuta a capire se la foto era sfocata.

## Aggiornare l'app

Dopo aver modificato i file, aumenta `VERSION` in `sw.js` e `APP_VERSION` in `js/version.js`. All'apertura l'app propone «Aggiorna». Il sito pubblico è servito da GitHub Pages dal ramo `gh-pages`: dopo un push su `main` aggiorna anche quello (`git push origin main:gh-pages`).

## Struttura

| Percorso | Contenuto |
|---|---|
| `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` | guscio PWA |
| `js/i18n.js` | **tutti i testi**: per una nuova lingua copia il blocco `it` e aggiungila a `LANGUAGES` |
| `js/views/` | lista, spesa intera, scanner, scheda, impostazioni |
| `js/ocr-parse.js` | ricerca delle date nel testo letto (formati italiani, diciture, lotti esclusi) |
| `vendor/` | ZXing WASM e Tesseract.js con il modello italiano, serviti in locale |

## Test

```sh
node tests/ocr-parse.test.mjs     # riconoscimento date e diciture
node tests/static.test.mjs        # testi presenti, file in cache nel service worker
python3 tests/ocr-bench/gen.py && python3 tests/ocr-bench/run.py new   # banco di prova OCR su etichette difficili
# end-to-end con Chrome e fotocamera finta (richiede playwright, python-barcode, ffmpeg)
python3 tests/make_assets.py && python3 tests/e2e.py
```

## Licenze di terze parti

`vendor/zxing` (zxing-wasm, MIT; ZXing-C++, Apache 2.0), `vendor/tesseract` (Tesseract.js e core, Apache 2.0; modello `ita` di tessdata, Apache 2.0). Carattere: Archivo (SIL Open Font License). Dati prodotto: Open Food Facts (ODbL).
