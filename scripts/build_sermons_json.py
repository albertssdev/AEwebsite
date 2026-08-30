#!/usr/bin/env python3
"""
Build sermon/sermons.json (the data the /sermon search page loads) from the
sermon_database.csv produced by the sermon-processor pipeline.

Usage:
    python scripts/build_sermons_json.py [path/to/sermon_database.csv]

If no path is given it looks in a few common spots (Downloads\\Telegram Desktop,
the Ryzen working folder, this repo). Re-runnable: it overwrites sermons.json.

What it does:
  - maps the 20 CSV columns down to the fields the search UI needs
  - DROPS the full `transcript` (too big to ship to browsers) but keeps every
    enrichment field derived from it (summary, scripture, topics, keywords, ...)
  - repairs the CP1252-over-UTF-8 mojibake in the text fields (â€" -> —, etc.)
  - tidies raw titles (whitespace, stray leading/trailing quotes)
  - tags each sermon audio/video from its URL host
  - sorts newest first, de-dupes on id (keeps the richer row)
  - prints a summary of how complete the data is
"""

import csv
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "sermon" / "sermons.json"

CANDIDATES = [
    # Google Drive sync of the sermon-processor working folder — the live output.
    Path("G:/My Drive/Work and pictures/sermon-processor/sermon_database.csv"),
    Path.home() / "sermon-processor" / "sermon_database.csv",           # the Ryzen working folder
    Path.home() / "Downloads" / "Telegram Desktop" / "sermon_database.csv",
    REPO_ROOT / "scripts" / "sermon_database.csv",
]

# csv.field_size_limit default is too small for the transcript column.
csv.field_size_limit(10_000_000)


def fix_mojibake(s: str) -> str:
    """Reverse a UTF-8 string that got decoded as CP1252 and re-saved.

    'responsibilitiesâ€"such' -> 'responsibilities—such'. Only applied when the
    round-trip succeeds cleanly and actually removes the tell-tale 'Ã'/'â€'
    sequences; otherwise the original is returned untouched.
    """
    if not s or ("Ã" not in s and "â€" not in s and "Â" not in s):
        return s
    try:
        repaired = s.encode("cp1252").decode("utf-8")
        return repaired
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def clean_title(s: str) -> str:
    s = fix_mojibake(s or "").strip()
    s = re.sub(r"\s+", " ", s)
    # raw titles sometimes carry one unbalanced double-quote, e.g.
    #   1Tim. 1:1-7  "The Goal of our Labors
    if s.count('"') == 1:
        s = s.replace('"', "").strip()
    return s


def clean_text(s: str) -> str:
    return re.sub(r"\s+", " ", fix_mojibake(s or "").strip())


def split_list(s: str):
    """'grace, sanctification , atonement' -> ['grace', 'sanctification', 'atonement']"""
    s = clean_text(s)
    if not s:
        return []
    parts = [p.strip(" .;") for p in re.split(r"[;,]", s)]
    seen, out = set(), []
    for p in parts:
        key = p.lower()
        if p and key not in seen:
            seen.add(key)
            out.append(p)
    return out


def parse_date(*values) -> str:
    """Normalise a sermon date to YYYY-MM-DD.

    The processor writes dates as YYMMDD ('141019', '260705'); older exports
    used ISO already. Returns '' if nothing parses.
    """
    for v in values:
        v = (v or "").strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            return v
        m = re.fullmatch(r"(\d{2})(\d{2})(\d{2})", v)
        if m:
            yy, mm, dd = m.groups()
            if 1 <= int(mm) <= 12 and 1 <= int(dd) <= 31:
                return f"20{yy}-{mm}-{dd}"
    return ""


def media_kind(url: str) -> str:
    u = (url or "").lower()
    if "youtube.com" in u or "youtu.be" in u:
        return "video"
    if u.endswith(".mp3") or "thefaithoncedelivered.info" in u:
        return "audio"
    return "other"


def duration_seconds(s: str):
    m = re.search(r"([\d.]+)", s or "")
    return round(float(m.group(1))) if m else None


def id_sort_key(sid: str):
    m = re.match(r"(\d+)(.*)", str(sid))
    return (int(m.group(1)), m.group(2)) if m else (0, str(sid))


def richness(row: dict) -> int:
    return sum(1 for k in ("summary", "transcript", "keywords", "scripture_references") if (row.get(k) or "").strip())


def find_input() -> Path:
    if len(sys.argv) > 1:
        p = Path(sys.argv[1]).expanduser()
        if not p.is_file():
            sys.exit(f"Not a file: {p}")
        return p
    for c in CANDIDATES:
        if c.is_file():
            return c
    sys.exit(
        "Could not find sermon_database.csv. Pass its path:\n"
        "  python scripts/build_sermons_json.py \"C:/Users/Alber/sermon-processor/sermon_database.csv\""
    )


def main():
    src = find_input()
    with src.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    by_id: dict[str, dict] = {}
    for r in rows:
        sid = (r.get("sermon_id") or "").strip()
        if not sid:
            continue
        if sid in by_id and richness(r) <= richness(by_id[sid]["_raw"]):
            continue

        title = clean_title(r.get("title", ""))
        alt = clean_title(r.get("title_suggestion", ""))
        url = (r.get("audio_url") or "").strip()

        item = {
            "id": sid,
            "title": title,
            "speaker": clean_text(r.get("speaker", "")),
            "date": parse_date(r.get("sermon_date"), r.get("uploaded")),
            "url": url,
            "media": media_kind(url),
        }
        dur = duration_seconds(r.get("duration", ""))
        if dur:
            item["dur"] = dur
        if alt and alt.lower() != title.lower():
            item["title_alt"] = alt

        summary = clean_text(r.get("summary", ""))
        if summary:
            item["summary"] = summary[:700]
        for out_key, in_key in (
            ("scripture", "scripture_references"),
            ("themes", "doctrinal_themes"),
            ("topics", "topics"),
        ):
            vals = split_list(r.get(in_key, ""))
            if vals:
                item[out_key] = vals
        # keywords + seo_tags serve the same purpose for search — merge, dedupe.
        kw = split_list(r.get("keywords", ""))
        seen = {k.lower() for k in kw}
        kw += [t for t in split_list(r.get("seo_tags", "")) if t.lower() not in seen]
        if kw:
            item["keywords"] = kw
        for out_key, in_key in (("type", "sermon_type"), ("series", "series"), ("tone", "tone")):
            v = clean_text(r.get(in_key, ""))
            if v:
                item[out_key] = v

        item["_raw"] = r  # for the richness comparison above; stripped before write
        by_id[sid] = item

    items = sorted(by_id.values(), key=lambda x: id_sort_key(x["id"]), reverse=True)
    for it in items:
        it.pop("_raw", None)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Compact (no whitespace) — this file ships to every visitor. The full
    # transcripts are deliberately NOT here; the source CSV is their archive.
    OUT_PATH.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    enriched = sum(1 for i in items if "summary" in i)
    audio = sum(1 for i in items if i["media"] == "audio")
    video = sum(1 for i in items if i["media"] == "video")
    other = sum(1 for i in items if i["media"] == "other")
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"source : {src}")
    print(f"output : {OUT_PATH}  ({size_kb:,.0f} KB)")
    print(f"sermons: {len(items)}   enriched (has summary): {enriched}   stubs: {len(items) - enriched}")
    print(f"media  : {audio} audio, {video} video, {other} other")
    if other:
        print("  note: 'other' media rows have a URL that's neither an .mp3 nor YouTube — check them.")
    weird = [i["id"] for i in items if not i["id"].isdigit()]
    if weird:
        print(f"  non-numeric ids kept as-is: {', '.join(weird)}")


if __name__ == "__main__":
    main()
