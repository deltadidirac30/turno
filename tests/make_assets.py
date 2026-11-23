"""Genera le immagini e i video (y4m) usati come fotocamera finta nei test end-to-end.
Richiede: pip install python-barcode pillow, ffmpeg."""
import barcode, io, random, subprocess
from barcode.writer import ImageWriter
from PIL import Image, ImageDraw, ImageFont
import os
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'assets')+'/'
os.makedirs(OUT, exist_ok=True)
def ean(base): return barcode.get('ean13', base).get_fullcode()
def bc(code, mw=0.4):
    buf=io.BytesIO(); barcode.get('ean13', code[:12], writer=ImageWriter()).write(buf, {'module_width':mw,'module_height':12,'quiet_zone':4,'font_size':8,'text_distance':4,'dpi':300})
    buf.seek(0); return Image.open(buf).convert('RGB')
codes={'latte':ean('800123456789'),'yogurt':ean('800765432101'),'pasta':ean('801234567890'),'nuovo':ean('805555555555'),'biscotti':ean('800999888777')}
print(codes)
F='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
# 1) singolo codice al centro (video verticale 720x1280)
img=Image.new('RGB',(720,1280),(200,196,186)); b=bc(codes['latte'],0.33); b.thumbnail((440,440))
img.paste(b,(360-b.width//2,540-b.height//2)); img.save(OUT+'single.png')
# 2) etichetta con due diciture e un lotto
img=Image.new('RGB',(720,1280),(205,200,190)); d=ImageDraw.Draw(img)
d.rectangle([130,490,600,630],fill=(250,250,246))
f=ImageFont.truetype(F,25)
d.text((150,502),'DA CONSUMARSI ENTRO 28/11/26',font=f,fill=(20,20,20))
d.text((150,542),'PREF. ENTRO 15/01/2027',font=f,fill=(20,20,20))
d.text((150,582),'L 120327  PROD 01.11.26',font=f,fill=(20,20,20))
img.save(OUT+'label.png')
# 3) tavolo con piu' confezioni (due uguali)
img=Image.new('RGB',(1920,1080),(150,120,90)); random.seed(3)
items=[('latte',(260,260)),('yogurt',(760,250)),('yogurt',(1300,260)),('pasta',(300,760)),('nuovo',(820,780)),('biscotti',(1400,760))]
for name,(x,y) in items:
    box=Image.new('RGB',(420,330),(235,232,225)); b=bc(codes[name],0.3); b.thumbnail((360,260)); box.paste(b,(30,35))
    box=box.rotate(random.uniform(-6,6),expand=True,fillcolor=(150,120,90))
    img.paste(box,(x-box.width//2+60,y-box.height//2+40))
img.save(OUT+'table.png')
for n in ['single','label','table']:
    subprocess.run(['ffmpeg','-y','-loglevel','error','-loop','1','-i',OUT+n+'.png','-t','1','-r','10','-pix_fmt','yuv420p',OUT+n+'.y4m'],check=True)
