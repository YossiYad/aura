#!/usr/bin/env python3
"""Split a module file into smaller files of the same module.

usage: split.py <repo> <module> <origin-file> <spec.json>
spec: {"src/views/settings-x.js": {"names": [...], "note": "header comment"}, ...}
Names are top-level function / const / let names of the origin, moved in origin order.
"""
import json, os, re, sys

repo, module, origin, specfile = sys.argv[1:5]
spec = json.load(open(specfile))
ns = {"views": "views", "player": "player", "api": "api", "main": "main", "store": "store", "sync": "sync", "voice": "voice", "ai": "ai", "shared-queue": "sharedQueue"}[module]

def read(p): return open(os.path.join(repo, p)).read()
def write(p, s):
    os.makedirs(os.path.dirname(os.path.join(repo, p)) or ".", exist_ok=True)
    open(os.path.join(repo, p), "w").write(s)

index_html = read("index.html")
scripts = re.findall(r'<script src="([^"]+)"></script>', index_html)
def module_files():
    return [f for f in scripts if f == "src/%s.js" % module or f.startswith("src/%s/" % module)]

src = read(origin)
lines = src.split("\n")

# ---- find the IIFE body bounds ----
body_start = next(i for i, l in enumerate(lines) if l.startswith("(function () {"))
body_end = max(i for i, l in enumerate(lines) if l.startswith("})();"))
# header: up to and including the defineProperties block close, or the V line
dp_start = next((i for i in range(body_start, body_end) if lines[i].startswith("  Object.defineProperties(V, {")), None)
if dp_start is not None:
    dp_end = next(i for i in range(dp_start, body_end) if lines[i] == "  });")
    header_end = dp_end
else:
    header_end = next(i for i in range(body_start, body_end) if lines[i].startswith("  const V = "))

# ---- parse top-level blocks after the header ----
DECL = re.compile(r"^  (?:async )?function ([A-Za-z_$][\w$]*)\(|^  (?:const|let) ([A-Za-z_$][\w$]*)\b")
blocks = []  # (name or None, start, end) inclusive indexes, comments attached
i = header_end + 1
def is_comment(l): return l.startswith("  //") or l.startswith("  /**") or l.startswith("   *") or l.startswith("  */")
def strip_strings(l):
    l = re.sub(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`', '""', l)
    return re.sub(r"//.*$", "", l)
def balance(l):
    l = strip_strings(l)
    return l.count("{") + l.count("(") + l.count("[") - l.count("}") - l.count(")") - l.count("]")
TOPSTART = re.compile(r"^  (?!\}|\)|\]|else\b|catch\b|finally\b)\S")
def statement_end(i):
    # a top-level statement runs to the line before the next top-level start; blank
    # lines at its tail are not part of it
    j = i + 1
    while j < body_end and not TOPSTART.match(lines[j]): j += 1
    j -= 1
    while j > i and lines[j].strip() == "": j -= 1
    return j
while i < body_end:
    l = lines[i]
    if l.strip() == "":
        i += 1; continue
    m = DECL.match(l)
    start = i
    if l.startswith("  /*") or l.startswith("  //"):
        j = i
        while j + 1 < body_end and is_comment(lines[j + 1]): j += 1
        blocks.append(("#comment", start, j)); i = j + 1; continue
    end = statement_end(i)
    name = (m.group(1) or m.group(2)) if m else None
    blocks.append((name, start, end))
    i = end + 1

# attach comment runs to the block that follows
attached = []
pending = []
for b in blocks:
    if b[0] == "#comment":
        pending.append(b); continue
    start = pending[0][1] if pending else b[1]
    attached.append((b[0], start, b[2]))
    pending = []
blocks = attached

by_name = {b[0]: b for b in blocks if b[0]}
# "#123" names a block by a line number inside it (1-based), for unnamed statements
for b in blocks:
    for ln in range(b[1], b[2] + 1): by_name["#%d" % (ln + 1)] = b
missing = [n for f in spec for n in spec[f]["names"] if n not in by_name]
if missing: sys.exit("not top-level in %s: %s" % (origin, missing))

moved = {}
for f, s in spec.items():
    moved[f] = sorted({by_name[n][1]: by_name[n] for n in s["names"]}.values(), key=lambda b: b[1])
def declarators(line):
    # the names a `const a = 1, b = f(x, y), c;` line declares
    body = re.sub(r"^  (?:const|let)\s+", "", line)
    names, depth, token = [], 0, ""
    for ch in body:
        if ch in "([{": depth += 1
        elif ch in ")]}": depth -= 1
        if ch == "," and depth == 0:
            m = re.match(r"\s*([A-Za-z_$][\w$]*)", token)
            if m: names.append(m.group(1))
            token = ""
        else: token += ch
    # the last declarator, or the only one on a line whose initializer runs on
    m = re.match(r"\s*([A-Za-z_$][\w$]*)", token)
    if m: names.append(m.group(1))
    return names
moved_names = {}
for f, bs in moved.items():
    for b in bs:
        for line in lines[b[1]:b[2] + 1]:
            m = re.match(r"^  (?:async )?function ([A-Za-z_$][\w$]*)\(", line)
            if m: moved_names[m.group(1)] = f
            if re.match(r"^  (?:const|let) ", line):
                for n in declarators(line): moved_names[n] = f

# ---- origin without moved blocks ----
remove = set()
for bs in moved.values():
    for b in bs: remove.update(range(b[1], b[2] + 1))
origin_lines = [l for k, l in enumerate(lines) if k not in remove]
origin_text = re.sub(r"\n{3,}", "\n\n", "\n".join(origin_lines))

# ---- new files ----
first_file = "src/%s.js" % module
def text_of(bs): return "\n\n".join("\n".join(lines[b[1]:b[2] + 1]) for b in bs)
new_texts = {}
for f, bs in moved.items():
    note = spec[f].get("note", "")
    body = text_of(bs)
    new_texts[f] = "(function () {\n  const V = window.Aura.%s;\n%s  // Published on V for the other files of this module; see %s.\n  Object.defineProperties(V, {\n  });\n\n%s\n})();\n" % (
        ns, ("  // " + note.replace("\n", "\n  // ") + "\n") if note else "", first_file, body)

# ---- write, then rewrite references across the whole module ----
write(origin, origin_text)
for f, t in new_texts.items(): write(f, t)
# index.html and sw.js: new entries right after the origin
for f in spec:
    tag = '<script src="%s"></script>' % f
    if tag not in index_html:
        index_html = index_html.replace('<script src="%s"></script>' % origin, '<script src="%s"></script>\n%s' % (origin, tag), 1)
        origin_tag_pos = index_html.index(tag)
        origin = f  # chain the next one after this
write("index.html", index_html)
origin = sys.argv[3]
sw = read("sw.js")
prev = '  "./%s",' % origin
for f in spec:
    entry = '  "./%s",' % f
    if entry not in sw:
        sw = sw.replace(prev, prev + "\n" + entry, 1)
    prev = entry
write("sw.js", sw)

# ---- reference rewriting ----
scripts = re.findall(r'<script src="([^"]+)"></script>', read("index.html"))
files = [f for f in scripts if f == first_file or f.startswith("src/%s/" % module)]
texts = {f: read(f) for f in files}
declared = {}
kinds = {}
for f, t in texts.items():
    declared[f] = set()
    for m in re.finditer(r"^  (?:async )?function ([A-Za-z_$][\w$]*)\(", t, re.M):
        declared[f].add(m.group(1)); kinds[m.group(1)] = "fn"
    for m in re.finditer(r"^  (?:const|let) [^\n]*", t, re.M):
        for n in declarators(m.group(0)): declared[f].add(n); kinds[n] = "var"
# names the moved blocks use from elsewhere: every top-level name of the module is a candidate
candidates = set(kinds)
def declared_locally(t, name):
    n = re.escape(name)
    if re.search(r"(?:function\s+%s\s*\(|(?:const|let|var)\s+%s\b|(?<![\w$.])%s\s*=>)" % (n, n, n), t): return True
    for m in re.finditer(r"\(([^()]*)\)\s*=>|function\s*[\w$]*\s*\(([^()]*)\)", t):
        params = m.group(1) if m.group(1) is not None else m.group(2)
        if re.search(r"(?<![\w$.])%s\b" % n, params): return True
    return False
publish = {f: {} for f in files}  # file -> {name: needs_setter}
warnings = []
STRING = re.compile(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`|/\*.*?\*/|(?:(?<=[(,=:\[!&|?{};])|(?<=[(,=:\[!&|?{};] ))/(?:[^/\\\n]|\\.)+/[gimsuy]*')
BLOCK = re.compile(r"  Object\.defineProperties\(V, \{\n[\s\S]*?  \}\);")
def sub_code(pat, repl, text):
    # substitute only outside string literals and outside the publish block, line by line
    out = []
    total = 0
    block = BLOCK.search(text)
    protect = set(range(text[:block.start()].count("\n"), text[:block.end()].count("\n") + 1)) if block else set()
    for k, line in enumerate(text.split("\n")):
        if k in protect: out.append(line); continue
        pos = 0; parts = []
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or (stripped.startswith("/*") and "*/" not in stripped):
            out.append(line); continue
        masked = STRING.sub(lambda m: " " * len(m.group(0)), line)
        masked = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group(0)), masked)
        cut = masked.find("//")
        tail = ""
        if cut != -1: line, tail = line[:cut], line[cut:]
        for m in STRING.finditer(line):
            seg, n = pat.subn(repl, line[pos:m.start()]); total += n
            parts.append(seg); parts.append(m.group(0)); pos = m.end()
        seg, n = pat.subn(repl, line[pos:]); total += n
        parts.append(seg)
        out.append("".join(parts) + tail)
    return "\n".join(out), total
def code_only(text):
    out = []
    for line in text.split("\n"):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or (stripped.startswith("/*") and "*/" not in stripped): out.append(""); continue
        line = STRING.sub('""', line)
        cut = line.find("//")
        out.append(line if cut == -1 else line[:cut])
    return "\n".join(out)
new_files = set(spec)
for name in candidates:
    owners = [f for f in files if name in declared[f]]
    if len(owners) != 1:
        if len(owners) > 1: warnings.append("%s declared in %s" % (name, owners))
        continue
    owner = owners[0]
    for f in files:
        if f == owner: continue
        # only what moved is rewritten everywhere; the new files also get their other uses rewritten
        if name not in moved_names and f not in new_files: 
            if re.search(r"(?<![\w$.])V\.%s\b" % re.escape(name), code_only(texts[f])):
                setter = re.search(r"(?<![\w$.])V\.%s\b\s*(?:=[^=]|\+\+|--|\+=|-=)" % re.escape(name), code_only(texts[f])) is not None
                publish[owner][name] = publish[owner].get(name, False) or setter
            continue
        t = texts[f]
        shadowed = re.search(r"(?:function\s+%s\s*\(|(?:const|let|var)\s+%s\b)" % (name, name), code_only(t)) is not None
        if shadowed or declared_locally(code_only(t), name):
            if re.search(r"(?<![\w$.])%s\b" % re.escape(name), code_only(t)): warnings.append("%s: %s used but also declared locally, left alone" % (f, name))
            continue
        short = re.compile(r"(?:(?<=[{,])|^)(\s*)%s(?![\w$])(?=\s*[,}])" % re.escape(name))
        t, n0 = sub_code(short, lambda m: m.group(1) + name + ": V." + name, t)
        pat = re.compile(r"(?<![\w$.])%s(?![\w$])(?!:(?!:))" % re.escape(name))
        new_t, n = sub_code(pat, "V." + name, t)
        n += n0
        if n: texts[f] = new_t
        code = code_only(texts[f])
        if re.search(r"(?<![\w$.])V\.%s(?![\w$])" % re.escape(name), code):
            setter = re.search(r"(?<![\w$.])V\.%s(?![\w$])\s*(?:=[^=]|\+\+|--|\+=|-=)|(?:\+\+|--)\s*V\.%s(?![\w$])" % (re.escape(name), re.escape(name)), code) is not None
            if setter and kinds.get(name) == "var" and re.search(r"^  const %s\b" % re.escape(name), texts[owner], re.M):
                warnings.append("%s: %s is a const in %s but assigned here" % (f, name, owner)); setter = False
            publish[owner][name] = publish[owner].get(name, False) or setter

# ---- rebuild defineProperties blocks ----
def rebuild(t, f):
    names = publish[f]
    entries = ["    %s: { get: () => %s%s }," % (n, n, (", set: value => { %s = value; }" % n) if s else "") for n, s in sorted(names.items(), key=lambda kv: kv[0].lower())]
    if entries: entries[-1] = entries[-1][:-1]
    block = "  Object.defineProperties(V, {\n" + "\n".join(entries) + "\n  });"
    if "  Object.defineProperties(V, {" in t:
        t = re.sub(r"  Object\.defineProperties\(V, \{\n[\s\S]*?  \}\);", lambda m: block, t, count=1)
    elif entries:
        t = t.replace("\n  const V = ", "\n  const V = ", 1)
        t = re.sub(r"(  const V = [^\n]*\n)", lambda m: m.group(1) + "  // Published on V for the other files of this module; see %s.\n" % first_file + block + "\n", t, count=1)
    return t
for f in files:
    # keep names already published that other files still use as V.name
    t = texts[f]
    old = re.search(r"  Object\.defineProperties\(V, \{\n([\s\S]*?)  \}\);", t)
    if old:
        for m in re.finditer(r"^    ([A-Za-z_$][\w$]*): \{ get: \(\) => \1(, set: value => \{ \1 = value; \})? \},?$", old.group(1), re.M):
            n = m.group(1)
            if n in declared[f] and any(re.search(r"(?<![\w$.])V\.%s\b" % n, texts[g]) for g in files if g != f) or n not in declared[f]:
                if n in declared[f]: publish[f][n] = publish[f].get(n, False) or bool(m.group(2))
    before = {}
    if old:
        for m in re.finditer(r"^    ([A-Za-z_$][\w$]*): \{ get: \(\) => \1(, set: value => \{ \1 = value; \})? \},?$", old.group(1), re.M):
            before[m.group(1)] = bool(m.group(2))
    for n, setter in before.items():
        if moved_names.get(n, f) == f: publish[f][n] = publish[f].get(n, False) or setter
    if before != publish[f]: texts[f] = rebuild(t, f)
for f, t in texts.items(): write(f, t.rstrip("\n") + "\n")
for w in warnings: print("WARN", w)
for f in files: print("%5d %s" % (len(texts[f].split("\n")), f))
