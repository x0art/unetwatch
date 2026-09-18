"""Timezone provider — GET /api/timezone.

Exposes the active operator timezone to the admin UI. The backend buckets and
labels every time in the operator's zone (``Settings.display_tz``, env
``DISPLAY_TZ``) via ``app/services/timeutil.py``, but a JSON response cannot
carry that context — the frontend had no way to know which zone it was and so
could not label anything correctly (the hardcoded "UTC hour with most requests"
peak hint became a lie the moment ``DISPLAY_TZ`` stopped being UTC).

Response shape (camelCase — consumed by ``api.ts`` helpers verbatim):

    GET /api/timezone
        { label: str, offsetMinutes: int }

``label`` is ``timeutil.zone_label()`` verbatim (``"UTC"``, ``"+07:00"``,
``"Asia/Bangkok"``) — an honest name for the zone the backend actually uses.
``offsetMinutes`` is the zone's current UTC offset in minutes (DST-aware for
IANA zones), so the frontend can render any instant in that zone
deterministically instead of guessing.

Cheap and safe by construction: no Elasticsearch call, no DB call, and the
zone resolution is ``timeutil``'s failure-tolerant path — an invalid
``DISPLAY_TZ`` degrades to UTC exactly like every other helper, so this
endpoint never 500s.
"""

from fastapi import APIRouter

from app.services.timeutil import utc_offset_minutes, zone_label

router = APIRouter(prefix="/api/timezone", tags=["timezone"])


@router.get("")
async def operator_timezone():
    """The active operator timezone: label + current UTC offset in minutes.

    Both fields derive from the same ``timeutil`` helpers the aggregation
    paths use — the route reuses the zone, it never re-derives it.
    """
    return {
        "label": zone_label(),
        "offsetMinutes": utc_offset_minutes(),
    }
