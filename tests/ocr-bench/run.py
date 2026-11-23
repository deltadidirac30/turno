import asyncio, sys, json, os
from playwright.async_api import async_playwright
async def main(mode):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'))
        pg = await b.new_page()
        pg.on('pageerror', lambda e: print('ERR', e))
        await pg.goto('' + os.environ.get('TURNO_URL', 'http://127.0.0.1:8765/scado/') + 'tests/ocr-bench/index.html'); await pg.wait_for_function('window.benchReady')
        res = await pg.evaluate(f"runBench('{mode}')")
        top = sum(r['top'] == r['expect'] for r in res); inl = sum(r['inList'] for r in res)
        for r in res: print(('OK ' if r['top']==r['expect'] else ('~  ' if r['inList'] else 'NO ')), f"{r['id']:<11} atteso {r['expect']:<11} letto {r['all']} {r['ms']}ms | {r['text'][:110]}")
        print(f'\n{mode}: primo esatto {top}/{len(res)} · tra le proposte {inl}/{len(res)} · tempo medio {sum(r["ms"] for r in res)//len(res)} ms')
        await b.close()
asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else 'base'))
