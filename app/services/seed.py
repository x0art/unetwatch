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


# Sample findings so the Findings page has data to display on a fresh install.
# These are only inserted when the findings table is empty; they never overwrite
# or duplicate rows produced by real ES polls.
SAMPLE_FINDINGS = [
    (
        "203.0.113.10",
        "10.0.0.4",
        "http://evil.example/uncensored/stream?id=1",
        "evil.example",
        "2026-08-05T09:15:00Z",
    ),
    (
        "198.51.100.42",
        "10.0.0.5",
        "https://mirror.example/lk21/page/7",
        "mirror.example",
        "2026-08-05T08:47:00Z",
    ),
    (
        "192.0.2.77",
        "10.0.0.6",
        "http://streams.example/film21/1080p",
        "streams.example",
        "2026-08-05T07:30:00Z",
    ),
    (
        "203.0.113.210",
        "10.0.0.7",
        "https://portal.example/indoxxi/home",
        "portal.example",
        "2026-08-05T06:05:00Z",
    ),
    (
        "198.51.100.9",
        "10.0.0.8",
        "http://cdn.example/rebahin/asset.mp4",
        "cdn.example",
        "2026-08-05T05:22:00Z",
    ),
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


async def seed_findings():
    """Populate sample findings only when the findings table is empty."""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT COUNT(*) AS total FROM findings")
        total = (await cursor.fetchone())["total"]
        if total > 0:
            return
        await db.executemany(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            SAMPLE_FINDINGS,
        )
        await db.commit()
    finally:
        await db.close()
