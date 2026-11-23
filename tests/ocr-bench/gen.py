"""Banco di prova per la lettura delle date: genera etichette sintetiche difficili
(stampa a punti, sfocatura, riflessi, date senza anno). Uso: python3 gen.py, poi run.py."""
# Etichette sintetiche realistiche: ritagli come quelli presi dalla cornice dello scanner.
import random, math, json, numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
random.seed(7); np.random.seed(7)
MONO='/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
SANS='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
import os
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'img')+'/'
import os; os.makedirs(OUT, exist_ok=True)

def text_mask(lines, font, size, pad=20, spacing=1.25):
    f=ImageFont.truetype(font,size)
    w=max(int(f.getlength(l)) for l in lines)+2*pad; h=int(len(lines)*size*spacing)+2*pad
    m=Image.new('L',(w,h),0); d=ImageDraw.Draw(m)
    for i,l in enumerate(lines): d.text((pad,pad+i*size*spacing),l,font=f,fill=255)
    return m

def dotify(mask, pitch):
    # stampa a getto d'inchiostro: punti su una griglia dove c'è il carattere
    a=np.array(mask); h,w=a.shape; out=Image.new('L',(w,h),0); d=ImageDraw.Draw(out)
    r=pitch*0.42
    for y in range(0,h,pitch):
        for x in range(0,w,pitch):
            if a[min(h-1,y+pitch//2),min(w-1,x+pitch//2)]>128:
                jx,jy=random.uniform(-.15,.15)*pitch,random.uniform(-.15,.15)*pitch
                d.ellipse([x+jx,y+jy,x+jx+2*r,y+jy+2*r],fill=255)
    return out

def compose(mask, bg, ink, size=(700,190)):
    W,H=size
    m=mask.copy(); m.thumbnail((int(W*random.uniform(.62,.9)), int(H*.8)))
    base=Image.new('RGB',(W,H),bg)
    # leggero gradiente di luce
    g=Image.linear_gradient('L').resize((W,H)).rotate(random.choice([0,90,180,270]))
    base=Image.composite(Image.new('RGB',(W,H),tuple(min(255,c+25) for c in bg)),base,g.point(lambda v:v//3))
    ox=random.randint(10,max(11,W-m.width-10)); oy=(H-m.height)//2+random.randint(-10,10)
    inkimg=Image.new('RGB',m.size,ink)
    base.paste(inkimg,(ox,oy),m)
    return base

def degrade(img, blur=0, contrast=1, noise=0, rot=0, glare=False, curve=0, scale=1, jpeg=None):
    if rot: img=img.rotate(rot,resample=Image.BICUBIC,expand=False,fillcolor=img.getpixel((2,2)))
    if curve:
        a=np.array(img); h,w,_=a.shape; out=np.zeros_like(a)
        for x in range(w):
            dy=int(curve*math.sin(math.pi*x/w)); out[:,x]=np.roll(a[:,x],dy,axis=0)
        img=Image.fromarray(out)
    if glare:
        W,H=img.size; g=Image.new('L',(W,H),0); d=ImageDraw.Draw(g)
        cx,cy=random.randint(W//4,3*W//4),random.randint(0,H)
        for r in range(120,0,-6): d.ellipse([cx-r*1.6,cy-r,cx+r*1.6,cy+r],fill=int(200*(1-r/120)))
        img=Image.composite(Image.new('RGB',(W,H),(255,255,255)),img,g.filter(ImageFilter.GaussianBlur(10)))
    if contrast!=1: img=ImageEnhance.Contrast(img).enhance(contrast)
    if scale!=1: img=img.resize((int(img.width*scale),int(img.height*scale)),Image.BILINEAR)
    if blur: img=img.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        a=np.array(img).astype(np.int16)+np.random.normal(0,noise,(img.height,img.width,3)).astype(np.int16)
        img=Image.fromarray(np.clip(a,0,255).astype(np.uint8))
    if jpeg:
        import io; b=io.BytesIO(); img.save(b,'JPEG',quality=jpeg); b.seek(0); img=Image.open(b).convert('RGB')
    return img

CASES=[
 # (id, righe, atteso d/m/y, tipo font, opzioni)
 ('nyear_dots',['DA CONSUMARSI ENTRO IL','28/11  L2611A'],'28/11/2026','dots',{}),
 ('dots_only',['28.11.26 L2611'],'28/11/2026','dots',{}),
 ('dots_blur',['TMC 15/03/2027'],'15/03/2027','dots',{'blur':1.4}),
 ('pref_month',['DA CONSUMARSI PREFERIBILMENTE','ENTRO FINE: 03/2027 L.B2416'],'-/03/2027','sans',{}),
 ('exp_name',['EXP 28NOV26'],'28/11/2026','mono',{}),
 ('spaced',['Da consumarsi entro:','28 11 2026'],'28/11/2026','sans',{}),
 ('laser',['12.01.27  0834'],'12/01/2027','laser',{}),
 ('small',['SCAD. 05/12/26'],'05/12/2026','mono',{'scale':.55}),
 ('glare',['DA CONSUMARSI ENTRO 02/12/2026'],'02/12/2026','sans',{'glare':True}),
 ('curve',['Da consumarsi pref. entro il 30/06/2027'],'30/06/2027','sans',{'curve':9}),
 ('lowc_dots',['01/12/26 14:32 L326'],'01/12/2026','dots',{'contrast':.45,'noise':8}),
 ('rot_dots',['DA CONS. ENTRO 04.12'],'04/12/2026','dots',{'rot':4}),
 ('blue_red',['BB: 18-02-2027'],'18/02/2027','mono',{'bg':(200,40,40),'ink':(240,240,240)}),
 ('kraft',['Preferibilmente entro 09/2027','Lotto 2410'],'-/09/2027','dots',{'bg':(196,160,110)}),
 ('motion',['DA CONSUMARSI ENTRO 26/11/26'],'26/11/2026','dots',{'blur':2.2,'jpeg':40}),
 ('tiny_dots',['31.12.2026'],'31/12/2026','dots',{'scale':.6,'blur':.8}),
]
meta=[]
for cid,lines,exp,kind,o in CASES:
    bg=o.pop('bg',(245,243,236)); ink=o.pop('ink',(25,25,30))
    if kind=='dots': m=dotify(text_mask(lines,MONO,56),random.choice([6,7,8]))
    elif kind=='laser': m=text_mask(lines,MONO,52); bg=(40,42,45); ink=(170,170,165)
    else: m=text_mask(lines,SANS if kind=='sans' else MONO,52)
    img=compose(m,bg,ink)
    img=degrade(img,**o)
    img.save(OUT+cid+'.png'); meta.append({'id':cid,'expect':exp})
json.dump(meta,open(OUT+'meta.json','w'),indent=1)
print(len(meta),'immagini')
# Foto intere (fotocamera di sistema): l'etichetta occupa una piccola parte dell'immagine.
whole=[]
for cid in ['nyear_dots','dots_blur','glare','small','rot_dots','motion']:
    lab=Image.open(OUT+cid+'.png'); W,H=3024,4032
    big=Image.new('RGB',(W,H),(random.randint(150,230),random.randint(120,200),random.randint(90,180)))
    d=ImageDraw.Draw(big)
    for _ in range(25):
        x0,x1=sorted([random.randint(0,W),random.randint(0,W)]); y0,y1=sorted([random.randint(0,H),random.randint(0,H)])
        d.rectangle([x0,y0,x1,y1],outline=(random.randint(0,255),)*3,width=8)
    lab=lab.resize((lab.width*3,lab.height*3)); big.paste(lab,(random.randint(100,W-lab.width-100),random.randint(400,H-lab.height-400)))
    big.save(OUT+'whole_'+cid+'.jpg',quality=85); whole.append({'id':'whole_'+cid,'expect':[m for m in meta if m['id']==cid][0]['expect'],'ext':'jpg'})
json.dump(whole,open(OUT+'whole.json','w'),indent=1)
