#!/usr/bin/env python3
"""Convert the .apkg decks in this folder into cards.js for the local flashcard site.

Run from anywhere:  python3 build_cards.py
English translations are merged from translations/*.txt (format described in parse_translations).
"""
import glob
import hashlib
import html
import json
import os
import re
import sqlite3
import tempfile
import zipfile
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.abspath(__file__))
# Deck order on the home page; any other .apkg in the folder is appended after these.
PREFERRED = ["SDE_Interview_Python.apkg", "RAG_Interview_LlamaIndex.apkg", "面试八股文.apkg"]

KEEP = {"p", "br", "b", "strong", "i", "em", "u", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody",
        "tr", "th", "td", "blockquote", "a", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "sub", "sup", "del", "s", "kbd"}
UNWRAP = {"span", "div", "section"}
VOID = {"br", "hr"}
NOIMG = '<span class="noimg">［图片缺失：原牌组未打包图片，可看原文］</span>'


class Sanitizer(HTMLParser):
    """Whitelist markup. Unknown tags are source code the deck forgot to escape (<mapper>, <stdio.h>),
    so they are kept as visible text rather than dropped."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []

    def handle_starttag(self, tag, attrs):
        if tag in UNWRAP:
            return
        if tag == "img":
            self.out.append(NOIMG)
            return
        if tag not in KEEP:
            self.out.append(html.escape(self.get_starttag_text() or f"<{tag}>", quote=False))
            return
        a = dict(attrs)
        extra = ""
        if tag == "a":
            href = a.get("href") or ""
            if re.match(r"https?://", href):
                extra = f' href="{html.escape(href)}" target="_blank" rel="noopener noreferrer"'
        elif tag == "ol" and (a.get("start") or "").isdigit():
            extra = f' start="{a["start"]}"'
        elif tag in ("td", "th"):
            for k in ("colspan", "rowspan"):
                if (a.get(k) or "").isdigit():
                    extra += f' {k}="{a[k]}"'
        self.out.append(f"<{tag}{extra}>")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in KEEP and tag not in VOID and tag != "img":
            self.out.append(f"</{tag}>")

    def handle_endtag(self, tag):
        if tag in UNWRAP or tag == "img" or tag in VOID:
            return
        self.out.append(f"</{tag}>" if tag in KEEP else html.escape(f"</{tag}>", quote=False))

    def handle_data(self, data):
        self.out.append(html.escape(data, quote=False))

    def handle_comment(self, data):
        pass

    def handle_decl(self, decl):
        self.out.append(html.escape(f"<!{decl}>", quote=False))

    def handle_pi(self, data):
        self.out.append(html.escape(f"<?{data}>", quote=False))

    def unknown_decl(self, data):
        self.out.append(html.escape(f"<![{data}]>", quote=False))


def sanitize(s):
    p = Sanitizer()
    p.feed(s)
    p.close()
    return "".join(p.out).strip()


def clean_answer(a):
    """Returns (html, source_url). Moves the 原文 link out of the body and drops scraper boilerplate."""
    src = ""
    m = re.search(r"<blockquote>\s*<p>原文[：:]\s*<a href=\"([^\"]+)\".*?</blockquote>", a, re.S)
    if m:
        src = m.group(1)
        a = a[:m.start()] + a[m.end():]
    a = a.replace("(opens new window)", "")
    a = re.sub(r"<p>Issue</p>\s*<p>欢迎在 Gtihub Issue 中回答此问题.*?</p>", "", a, flags=re.S)
    # Community answers: keep a small divider naming who wrote each one.
    a = re.sub(r"<p>Author</p>\s*<p>回答者[：:]\s*(?:<a[^>]*>)?(.*?)(?:</a>)?</p>",
               lambda x: f"<p>§BY§{x.group(1)}</p>", a, flags=re.S)
    a = sanitize(a)
    a = re.sub(r"<p>§BY§(.*?)</p>", r'<div class="by">回答者 \1</div>', a, flags=re.S)
    a = re.sub(r"\n{2,}", "\n", a)
    a = re.sub(r"<p>\s*</p>", "", a)
    return a.strip(), src


def clean_question(q, deck_name):
    q = re.sub(r"</?h[1-6]>", "", q).strip()
    if q.startswith(deck_name):
        q = q[len(deck_name):].lstrip(" -–—:：")
    q = re.sub(r"^\d+\s*[.、]\s*", "", q)
    return sanitize(q)


def parse_translations():
    """translations/*.txt holds blocks of:

        @@ <card id>
        Q: English question
        A:
        <English answer html, any number of lines>
    """
    out = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "translations", "*.txt"))):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for block in re.split(r"^@@ ", text, flags=re.M)[1:]:
            cid, _, rest = block.partition("\n")
            m = re.match(r"Q:\s*(.*?)\nA:\s*\n?(.*)", rest, re.S)
            if not m:
                raise SystemExit(f"{os.path.basename(path)}: malformed block for {cid.strip()!r}")
            out[cid.strip()] = {"q": m.group(1).strip(), "a": m.group(2).strip()}
    return out


def read_collection(apkg):
    """Yields (guid, deck_top, deck_sub, question, answer, tags) from the newest collection in the package."""
    with zipfile.ZipFile(apkg) as z, tempfile.TemporaryDirectory() as tmp:
        names = z.namelist()
        member = next((n for n in ("collection.anki21", "collection.anki2") if n in names), None)
        if member is None:
            raise SystemExit(f"{apkg}: no readable collection (collection.anki21b is not supported)")
        path = os.path.join(tmp, "col.db")
        with open(path, "wb") as f:
            f.write(z.read(member))
        con = sqlite3.connect(path)
        decks = json.loads(con.execute("select decks from col").fetchone()[0])
        rows = con.execute("select n.guid, n.flds, n.tags, c.did, c.id from notes n join cards c on c.nid = n.id "
                           "order by c.did, c.due, c.id").fetchall()
        con.close()
    for guid, flds, tags, did, _ in rows:
        parts = flds.split("\x1f")
        top, _, sub = decks[str(did)]["name"].partition("::")
        yield guid, top, sub or top, parts[0], parts[1], tags.split()


def main():
    files = [os.path.join(ROOT, n) for n in PREFERRED if os.path.exists(os.path.join(ROOT, n))]
    files += [p for p in sorted(glob.glob(os.path.join(ROOT, "*.apkg"))) if p not in files]

    decks, deck_index, cards, by_guid, by_content = [], {}, [], {}, {}
    stats = {"seen": 0, "same_note": 0, "same_content": 0, "img_cards": 0, "no_answer": 0}

    for apkg in files:
        rows = list(read_collection(apkg))
        # Numbered decks are already in teaching order; sorting keeps 01, 02, ... and groups the rest by name.
        for guid, top, sub, q, a, tags in sorted(rows, key=lambda r: r[2]):
            stats["seen"] += 1
            key = f"{top}::{sub}"
            if key not in deck_index:
                deck_index[key] = len(decks)
                decks.append({"id": key, "top": top, "name": sub})
            d = deck_index[key]
            if guid in by_guid:
                stats["same_note"] += 1
                if d not in by_guid[guid]["d"]:
                    by_guid[guid]["d"].append(d)
                continue
            question = clean_question(q, sub)
            answer, src = clean_answer(a)
            sig = hashlib.sha1((re.sub(r"\s", "", question) + "\0" + re.sub(r"\s", "", answer)).encode()).hexdigest()
            if sig in by_content:
                # The same question copied into several decks: one card, visible from each deck.
                stats["same_content"] += 1
                if d not in by_content[sig]["d"]:
                    by_content[sig]["d"].append(d)
                continue
            if not re.sub(r"<[^>]+>", "", answer).strip():
                # Nobody answered it on the source site, so there is nothing to flip to.
                stats["no_answer"] += 1
                continue
            # Anki guids contain characters like < and ", so hash them into an id that is safe in HTML.
            card = {"id": hashlib.sha1(guid.encode()).hexdigest()[:10], "d": [d], "q": question, "a": answer}
            if src:
                card["src"] = src
            if tags:
                card["tags"] = tags
            if "noimg" in answer:
                stats["img_cards"] += 1
            by_guid[guid] = by_content[sig] = card
            cards.append(card)

    trans = parse_translations()
    known = {c["id"] for c in cards}
    unknown = sorted(set(trans) - known)
    if unknown:
        raise SystemExit(f"translations reference unknown card ids: {unknown[:5]}")
    for c in cards:
        if c["id"] in trans:
            c["qe"] = sanitize(trans[c["id"]]["q"])
            c["ae"] = sanitize(trans[c["id"]]["a"])

    out = os.path.join(ROOT, "cards.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write("// Generated by build_cards.py. Do not edit by hand.\n")
        f.write("window.DECKS = " + json.dumps(decks, ensure_ascii=False, separators=(",", ":")) + ";\n")
        f.write("window.CARDS = " + json.dumps(cards, ensure_ascii=False, separators=(",", ":")) + ";\n")

    print(f"{len(cards)} cards in {len(decks)} decks ({stats['seen']} read; merged {stats['same_note']} same-note "
          f"and {stats['same_content']} identical copies)")
    print(f"dropped {stats['no_answer']} cards whose answer is empty")
    print(f"{stats['img_cards']} cards had images missing from the package")
    print(f"English: {sum('ae' in c for c in cards)} / {len(cards)} cards")
    print(f"cards.js: {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
