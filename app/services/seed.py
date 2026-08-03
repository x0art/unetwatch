from app.database import get_db

# Original patterns from main.py
URL_PATTERNS = [
    "*porn*", "*uncensored*", "*nonton*", "*bokep*", "*bugil*",
    "*colmek*", "*rebahin*", "*lk21layarkaca*", "*Kuronime*",
    "*Oploverz*", "*genre*", "IDLIX21", "idlix", "layarkayac21",
    "bandar", "dutamovie21", "dunia21", "film21", "gudang88",
    "indoxxi", "lk21", "LK21", "jalalive", "sohib21", "rb77",
    "klikxxi", "KLIKXXI",
]

URL_WHITELIST = [
    "googleapis", "wikipedia", "rctiplus", "detik.net.id",
    "idntimes", "filmora", "cnnindonesia", "kaskus",
    "googleusercontent", "detik.com", "cdns.klimg.com",
    "thumb.viva.id", "storage.googleapis.com", "store-api.jubelio.com",
    "indopingpong.com", "fundingchoicesmessages.google.com",
    "tivan.naver.com", "google.com", "img.inews.co.id",
    "challenges.cloudflare.com", "www.bi.go.id", "comentario.oploverz.ac",
    "berita", "sync.1rx.io", "korpri.go.id", "ka.ds.kakao.com",
    "radarbojonegoro.jawapos.com", "b1.nel.goog", "static.republika.co.id",
    "i.namu.wiki", "scs-phinf.pstatic.net", "tdwcontent.telkomsel.com",
    "assets.telkomsel.com", "whatsapp.net", "tirto.id",
    "www.mylintas.co.id", "asset.kompas.com", "pict.sindonews.net",
    "www.canva.com", "regional.kompas.com", "tribunnews.com",
    "naver.com", "ader.naver.com", "demo.idtheme.com", "kebunraya.id",
    "www.royalshuttle.co.id", "jadwalnonton.com", "img.okezone.com",
]


async def seed_patterns():
    db = await get_db()
    try:
        for p in URL_PATTERNS:
            await db.execute(
                "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type) VALUES (?, 'block')",
                (p,),
            )
        for p in URL_WHITELIST:
            await db.execute(
                "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type)"
                " VALUES (?, 'whitelist')",
                (p,),
            )
        await db.commit()
    finally:
        await db.close()
