"""Test end-to-end di Turno con Chrome headless e fotocamera simulata (file y4m).
Uno stesso profilo browser attraversa più avvii: così si verificano service worker,
IndexedDB e riapertura offline tra un avvio e l'altro."""
import asyncio, json, os, shutil, sys, time
from pathlib import Path
from playwright.async_api import async_playwright, expect

BASE = os.environ.get('TURNO_URL', 'http://127.0.0.1:8765/scado/')
HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, 'assets') + '/'
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
PROFILE = '/tmp/turno-profile'
SHOTS = Path(HERE) / 'shots'
OFF = {
    '8001234567897': {'product_name_it': 'Latte intero', 'brands': 'Fattoria Rossi'},
    '8007654321019': {'product_name_it': 'Yogurt greco', 'brands': 'Monte'},
    '8012345678907': {'product_name_it': 'Fusilli', 'brands': 'Grano Oro'},
    '8009998887770': {'product_name_it': 'Biscotti al burro', 'brands': 'Forno'},
}
results = []
def ok(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

INIT = """
window.__streams = [];
const _gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
if (_gum) navigator.mediaDevices.getUserMedia = async (c) => { const s = await _gum(c); window.__streams.push(s); return s; };
"""

async def launch(p, video):
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path=CHROME, headless=True,
        args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={A}{video}'],
        viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale='it-IT',
        accept_downloads=True)
    async def off(route):
        ean = route.request.url.split('/product/')[1].split('.json')[0]
        if ean in OFF: await route.fulfill(status=200, content_type='application/json', body=json.dumps({'status': 1, 'product': OFF[ean]}))
        else: await route.fulfill(status=404, content_type='application/json', body=json.dumps({'status': 0}))
    await ctx.route('**/world.openfoodfacts.org/**', off)
    await ctx.add_init_script(INIT)
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'special-words' not in m.text and '404' not in m.text else None)  # messaggio innocuo di Tesseract
    return ctx, page, errs

async def items(page):
    return await page.evaluate("""() => new Promise((res) => { const r = indexedDB.open('turno'); r.onsuccess = () => {
      const tx = r.result.transaction('items'); const q = tx.objectStore('items').getAll(); q.onsuccess = () => res(q.result); }; })""")

async def kv(page, key):
    return await page.evaluate("""(k) => new Promise((res) => { const r = indexedDB.open('turno'); r.onsuccess = () => {
      const q = r.result.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result ? q.result.value : null); }; })""", key)

async def streams_live(page):
    return await page.evaluate("() => window.__streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length")

async def fill_date(page, d, m, y, scope='.scan-overlay'):
    await page.locator(f'{scope} .dp-d').fill(d)
    await page.locator(f'{scope} .dp-m').fill(m)
    await page.locator(f'{scope} .dp-y').fill(y)

async def run1(p):
    """Primo avvio online + due confezioni con lo stesso EAN e date diverse."""
    ctx, page, errs = await launch(p, 'single.y4m')
    await page.goto(BASE)
    await page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=15000)
    await page.wait_for_function("""async () => { const c = await caches.open('turno-res-v1'); return (await c.keys()).length >= 7; }""", timeout=30000, polling=500)
    ok('risorse scansione/OCR in cache dopo il primo caricamento', True)
    await page.goto(BASE + '#/scan')
    await page.wait_for_selector('.scan-frame[data-mode="date"]', timeout=20000)
    await expect(page.locator('.scan-top .prod-name')).to_have_text('Latte intero', timeout=8000)
    ok('codice letto dal video e nome da Open Food Facts', True)
    await page.get_by_role('button', name='Scrivi data').click()
    await fill_date(page, '10', '12', '2026')
    await page.screenshot(path=str(SHOTS / 'scan-confirm.png'))
    await page.get_by_role('button', name='Salva e scansiona il prossimo').click()
    # stessa confezione ancora inquadrata: il codice viene ignorato per 3 s, poi riletto
    await page.wait_for_selector('.scan-frame[data-mode="barcode"]', timeout=5000)
    await page.wait_for_selector('.scan-frame[data-mode="date"]', timeout=20000)
    await page.get_by_role('button', name='Scrivi data').click()
    await fill_date(page, '20', '12', '2026')
    await page.get_by_role('button', name='Salva e chiudi').click()
    await page.wait_for_selector('.row', timeout=5000)
    await page.wait_for_timeout(500)
    its = [i for i in await items(page) if i['ean'] == '8001234567897' and i['status'] == 'active']
    dates = sorted(f"{i['expiry']['d']}/{i['expiry']['m']}/{i['expiry']['y']}" for i in its)
    ok('due confezioni stesso EAN con date diverse', len(its) == 2 and dates == ['10/12/2026', '20/12/2026'], str(dates))
    ok('fotocamera rilasciata uscendo dallo scanner', await streams_live(page) == 0)
    await page.screenshot(path=str(SHOTS / 'home-two.png'))
    # Consumato con annullamento
    await page.locator('.row .eat').first.click()
    await page.wait_for_timeout(300)
    n_after = len([i for i in await items(page) if i['status'] == 'active'])
    await page.locator('.toast-act').click()
    await page.wait_for_timeout(400)
    n_undo = len([i for i in await items(page) if i['status'] == 'active'])
    ok('Consumato in un tap e Annulla', n_after == 1 and n_undo == 2, f'{n_after} → {n_undo}')
    ok('nessun errore JS (avvio 1)', not errs, '; '.join(errs[:3]))
    await ctx.close()

async def run2(p):
    """Riapertura offline + OCR offline + scelta e correzione di una data ambigua."""
    ctx, page, errs = await launch(p, 'label.y4m')
    await ctx.set_offline(True)
    await page.goto(BASE)
    await page.wait_for_selector('.row', timeout=8000)
    ok('riapertura offline: lista disponibile', await page.locator('.row').count() == 2)
    # Inserimento manuale offline
    await page.goto(BASE + '#/add')
    await page.locator('.form input.in').first.fill('Pane')
    await fill_date(page, '25', '11', '2026', scope='.form')
    await page.get_by_role('button', name='Salva', exact=True).click()
    await page.wait_for_timeout(500)
    ok('inserimento manuale offline', any(i['name'] == 'Pane' for i in await items(page)))
    # Data dalla foto, offline
    await page.goto(BASE + '#/scan')
    await page.get_by_role('button', name='Senza codice').click()
    await page.wait_for_selector('.scan-frame[data-mode="date"]')
    await page.wait_for_timeout(800)
    t0 = time.time()
    await page.get_by_role('button', name='Scatta e leggi la data').click()
    try:
        await page.wait_for_selector('.choice', timeout=60000)
    except Exception:
        await page.screenshot(path=str(SHOTS / 'fail-ocr.png'))
        print('   msg:', await page.locator('.scan-msg').inner_text(), '| errs:', errs[:5], '| ocr:', repr(await page.evaluate('self.__turnoLastOcr')))
        raise
    ok('OCR offline: più date proposte con testo vicino', await page.locator('.choice').count() >= 2, f'{time.time() - t0:.1f}s')
    texts = await page.locator('.choice').all_inner_texts()
    print('   scelte:', [t.replace('\n', ' | ') for t in texts])
    ok('lotto e data di produzione esclusi', not any('12/03/2027' in t or '01/11/2026' in t for t in texts))
    await page.screenshot(path=str(SHOTS / 'choose.png'))
    await page.locator('.choice', has_text='Da consumarsi entro').click()
    await page.wait_for_selector('.scan-overlay .dp-d')
    pre = [await page.locator(f'.scan-overlay .dp-{k}').input_value() for k in 'dmy']
    ok('data scelta precompilata da confermare', pre[:2] == ['28', '11'], str(pre))
    # correzione: giorno e anno (l'OCR può confondere 6 e 4)
    await page.locator('.scan-overlay .dp-d').fill('27')
    await page.locator('.scan-overlay .dp-y').fill('2026')
    note = await page.locator('.scan-overlay .datef > .dnote').inner_text()
    ok('correzione segnalata', 'Corretta' in note, note)
    await page.locator('.scan-overlay .form input.in').first.fill('Mozzarella')
    print('   sheet style', await page.evaluate("() => [...document.querySelectorAll('.scan-overlay .sheet')].map(e => { const c = getComputedStyle(e); return [c.opacity, c.backgroundColor, e.parentElement.className]; })"))
    await page.wait_for_timeout(400)
    await page.screenshot(path=str(SHOTS / 'corrected.png'))
    await page.get_by_role('button', name='Salva e chiudi').click()
    await page.wait_for_timeout(600)
    mz = [i for i in await items(page) if i['name'] == 'Mozzarella']
    ok('data corretta salvata (27/11/2026, entro)', mz and mz[0]['expiry'] == {'y': 2026, 'm': 11, 'd': 27} and mz[0]['expiryKind'] == 'use_by', str(mz and mz[0]['expiry']))
    st = await kv(page, 'stats')
    ok('statistica date corrette aggiornata', st and st.get('ocrCorrected') == 1, str(st))
    ok('nessun errore JS (avvio 2)', not [e for e in errs if 'openfoodfacts' not in e and 'ERR_INTERNET' not in e], '; '.join(errs[:3]))
    await ctx.close()

async def run3(p):
    """Spesa intera: foto con più codici (due uguali), luogo in un tap, interruzione e ripresa."""
    ctx, page, errs = await launch(p, 'table.y4m')
    await page.goto(BASE + '#/batch')
    await page.wait_for_selector('.shutter:not([disabled])', timeout=15000)
    await page.wait_for_timeout(1000)
    await page.locator('.shutter').click()
    await page.wait_for_selector('.rows-batch .brow', timeout=60000)
    await page.wait_for_timeout(800)
    n = await page.locator('.rows-batch .brow').count()
    st = await kv(page, 'batch')
    eans = [e['ean'] for e in st['entries']]
    ok('foto del tavolo: 6 confezioni lette', n == 6, f'{n}: {eans}')
    ok('due confezioni con lo stesso codice restano separate', eans.count('8007654321019') == 2)
    await page.screenshot(path=str(SHOTS / 'batch-review.png'), full_page=True)
    # tutte selezionate → Dispensa; poi 1,2,3 → Frigo
    await page.locator('.footer-bar .seg-btn', has_text='Dispensa').click()
    for i in range(3): await page.locator('.rows-batch .sel').nth(i).click()
    await page.locator('.footer-bar .seg-btn', has_text='Frigo').click()
    await page.wait_for_timeout(300)
    st = await kv(page, 'batch')
    locs = [e['location'] for e in st['entries']]
    ok('luogo assegnato ai selezionati in un tap', locs == ['fridge'] * 3 + ['pantry'] * 3, str(locs))
    # nome per il prodotto sconosciuto
    unknown = page.locator('.rows-batch .brow', has=page.locator('.meta', has_text='8055555555552')).locator('input')
    await unknown.fill('Pesto fresco'); await unknown.press('Tab')
    await page.get_by_role('button', name='Leggi le date (6)').click()
    await page.wait_for_selector('.qpos', timeout=10000)
    await page.get_by_role('button', name='Scrivi data').click()
    await fill_date(page, '05', '12', '2026')
    await page.get_by_role('button', name='Conferma e avanti').click()
    await expect(page.locator('.qpos')).to_have_text('2 di 6', timeout=5000)
    # interruzione: chiudo lo scanner e ricarico l'app
    await page.locator('.scan-top .icon-btn').first.click()
    await page.wait_for_timeout(500)
    ok('fotocamera rilasciata uscendo dalla spesa', await streams_live(page) == 0)
    await page.reload()
    await page.wait_for_selector('.banner-strong', timeout=8000)
    banner = await page.locator('.banner-strong').inner_text()
    ok('dopo la ricarica la spesa è ripresa dalla lista', 'Spesa in corso' in banner, banner.replace('\n', ' '))
    its = [i for i in await items(page) if i.get('batchId')]
    ok('confezioni create subito (nessuna persa)', len(its) == 6 and sum(1 for i in its if i['expiry']) == 1)
    await page.locator('.banner-strong').click()
    await expect(page.locator('.qpos')).to_have_text('2 di 6', timeout=10000)
    ok('la coda riparte dalla confezione 2', True)
    await page.get_by_role('button', name='Dopo').click()  # data illeggibile: passo oltre
    for k, day in enumerate(['07', '09', '11', '13']):
        await expect(page.locator('.qpos')).to_have_text(f'{3 + k} di 6', timeout=5000)
        await page.get_by_role('button', name='Scrivi data').click()
        await fill_date(page, day, '12', '2026')
        await page.get_by_role('button', name='Conferma e avanti').click()
    await page.wait_for_selector('.done', timeout=5000)
    await page.screenshot(path=str(SHOTS / 'batch-done.png'))
    ok('riepilogo spesa', '5 di 6' in await page.locator('.done').inner_text())
    await page.goto(BASE + '#/todo')
    await page.wait_for_selector('.rows-todo .row')
    todo = await page.locator('.rows-todo .row').all_inner_texts()
    ok('confezione saltata in «Da completare»', len(todo) == 1 and 'Yogurt greco' in todo[0], str(todo))
    prods = await page.evaluate("""() => new Promise((res) => { const r = indexedDB.open('turno'); r.onsuccess = () => {
      const q = r.result.transaction('products').objectStore('products').get('8055555555552'); q.onsuccess = () => res(q.result); }; })""")
    ok('nome scritto ricordato per la prossima scansione', prods and prods['name'] == 'Pesto fresco' and prods['source'] == 'user')
    await page.goto(BASE)
    await page.wait_for_selector('.row')
    await page.screenshot(path=str(SHOTS / 'home-full.png'), full_page=True)
    await page.locator('.chips .chip', has_text='Frigo').click()
    frigo = await page.locator('.list-host .row').count()
    await page.locator('.search-in').fill('yog')
    yog = await page.locator('.list-host .row').count()
    ok('filtro Frigo e ricerca per nome', frigo >= 3 and yog >= 1, f'frigo={frigo} yog={yog}')
    ok('nessun errore JS (avvio 3)', not errs, '; '.join(errs[:3]))
    await ctx.close()

async def run4(p):
    """Backup: esporta, rifiuta un file non valido senza toccare i dati, ripristina con conferma."""
    ctx, page, errs = await launch(p, 'single.y4m')
    await page.goto(BASE + '#/settings')
    await page.wait_for_selector('text=Esporta backup')
    async with page.expect_download() as dl:
        await page.get_by_role('button', name='Esporta backup').click()
    path = '/tmp/turno-backup.json'
    await (await dl.value).save_as(path)
    data = json.load(open(path))
    before = len([i for i in data['items'] if i['status'] == 'active'])
    ok('backup esportato', data['app'] == 'turno' and before >= 9, f'{before} attive')
    bad = '/tmp/bad.json'
    broken = json.loads(json.dumps(data)); broken['items'][0]['qty'] = 0
    json.dump(broken, open(bad, 'w'))
    await page.locator('input[type=file]').set_input_files(bad)
    await page.wait_for_timeout(600)
    toast = await page.locator('.toast').inner_text()
    n_now = len([i for i in await items(page) if i['status'] == 'active'])
    ok('file non valido rifiutato, nessun dato modificato', 'non valido' in toast and n_now == before, toast)
    # cambio i dati: elimino tutto tranne una confezione
    await page.evaluate("""() => new Promise((res) => { const r = indexedDB.open('turno'); r.onsuccess = () => {
      const tx = r.result.transaction('items', 'readwrite'); tx.objectStore('items').clear(); tx.oncomplete = res; }; })""")
    await page.locator('input[type=file]').set_input_files(path)
    await page.wait_for_selector('.sheet .btn-danger')
    msg = await page.locator('.sheet').inner_text()
    await page.screenshot(path=str(SHOTS / 'restore-confirm.png'))
    await page.locator('.sheet .btn-danger').click()
    await page.wait_for_timeout(800)
    after = len([i for i in await items(page) if i['status'] == 'active'])
    ok('ripristino dopo conferma', after == before, f'{after}/{before} · «{msg.splitlines()[0]}»')
    # .ics
    async with page.expect_download() as dl2:
        await page.goto(BASE + '#/settings')
        await page.get_by_role('button', name='Esporta scadenze dei prossimi 14 giorni (.ics)').click()
    ics = open(await (await dl2.value).path()).read()
    ok('.ics con eventi e avviso', ics.count('BEGIN:VEVENT') >= 3 and 'BEGIN:VALARM' in ics and 'TRIGGER:-PT900M' in ics, f"{ics.count('BEGIN:VEVENT')} eventi")
    open('/tmp/turno.ics', 'w').write(ics)
    ok('nessun errore JS (avvio 4)', not errs, '; '.join(errs[:3]))
    await ctx.close()

async def run5(p):
    """Fotocamera negata: l'inserimento manuale resta disponibile."""
    ctx = await p.chromium.launch_persistent_context('/tmp/turno-profile-deny', executable_path=CHROME, headless=True,
        args=['--use-fake-device-for-media-stream', '--deny-permission-prompts'], viewport={'width': 390, 'height': 844}, locale='it-IT')
    page = ctx.pages[0]
    await page.goto(BASE + '#/scan')
    await page.wait_for_selector('.scan-fallback:not([hidden])', timeout=10000)
    fb = await page.locator('.scan-fallback').inner_text()
    await page.screenshot(path=str(SHOTS / 'denied.png'))
    await page.get_by_role('button', name='Inserisci a mano').click()
    await page.get_by_role('button', name='Scrivi data').click()
    await page.wait_for_selector('.scan-overlay .dp-d')
    ok('fotocamera negata: messaggio e inserimento manuale', 'negato' in fb or 'fotocamera' in fb.lower(), fb.replace('\n', ' '))
    await ctx.close()

async def main():
    shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree('/tmp/turno-profile-deny', ignore_errors=True)
    SHOTS.mkdir(exist_ok=True)
    async with async_playwright() as p:
        for fn in [run1, run2, run3, run4, run5]:
            if len(sys.argv) > 1 and fn.__name__ not in sys.argv[1:]: continue
            try: await fn(p)
            except Exception as e: ok(fn.__name__ + ' completato', False, repr(e)[:600])
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} verifiche superate')
    sys.exit(1 if failed else 0)

asyncio.run(main())
