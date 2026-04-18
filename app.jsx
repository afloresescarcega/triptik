// app.jsx — triptik, a three-panel Hacker News comment navigator.
//
// HN API (Firebase, public, no auth, no documented rate limit):
//   topstories.json      → array of story IDs (top ~500)
//   item/<id>.json       → one item (story or comment), with `kids` (array of IDs)
//
// Caching strategy (aggressive, since deep comment trees fan out fast):
//   1. In-memory Map (per-session) of every fetched item.
//   2. localStorage backing with TTLs:
//        - top-stories list:       5 min
//        - story headers (kind=story): 30 min
//        - comments (immutable-ish): 7 days
//   3. In-flight de-dup: one Promise per id, never re-fetch in parallel.
//   4. Concurrency cap: at most CONCURRENCY parallel network requests.
//   5. Lazy fetch: only request items that are about to be shown
//      (current node, its first 4 visible kids, parent), never the whole tree.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─── HN cache + fetch layer ─────────────────────────────────────────────────
const HN_BASE = "https://hacker-news.firebaseio.com/v0";
const CACHE_KEY = "hn:item:";
const TOP_KEY   = "hn:topstories";
const TTL_TOP     = 5 * 60 * 1000;          // 5 min
const TTL_STORY   = 30 * 60 * 1000;         // 30 min
const TTL_COMMENT = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONCURRENCY = 4;

const memCache = new Map();   // id -> item
const inflight = new Map();   // id -> Promise

let active = 0;
const queue = [];
function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => { active--; pump(); });
  }
}
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    pump();
  });
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { v, t } = JSON.parse(raw);
    return { value: v, ts: t };
  } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ v: value, t: Date.now() })); } catch {}
}

function ttlFor(item) {
  if (!item) return TTL_COMMENT;
  if (item.type === "story" || item.type === "job" || item.type === "poll") return TTL_STORY;
  return TTL_COMMENT;
}

async function fetchItem(id) {
  if (id == null) return null;
  if (memCache.has(id)) return memCache.get(id);

  const cached = lsGet(CACHE_KEY + id);
  if (cached && cached.value) {
    const age = Date.now() - cached.ts;
    if (age < ttlFor(cached.value)) {
      memCache.set(id, cached.value);
      return cached.value;
    }
  }
  if (inflight.has(id)) return inflight.get(id);

  const p = schedule(async () => {
    const res = await fetch(`${HN_BASE}/item/${id}.json`);
    if (!res.ok) throw new Error(`HN ${res.status}`);
    const item = await res.json();
    if (item) {
      memCache.set(id, item);
      lsSet(CACHE_KEY + id, item);
    } else if (cached && cached.value) {
      memCache.set(id, cached.value);
      return cached.value;
    }
    return item;
  }).finally(() => inflight.delete(id));

  inflight.set(id, p);
  return p;
}

async function fetchTopStories() {
  const cached = lsGet(TOP_KEY);
  if (cached && cached.value && Date.now() - cached.ts < TTL_TOP) {
    return cached.value;
  }
  const res = await fetch(`${HN_BASE}/topstories.json`);
  if (!res.ok) {
    if (cached && cached.value) return cached.value;
    throw new Error(`HN ${res.status}`);
  }
  const ids = await res.json();
  lsSet(TOP_KEY, ids);
  return ids;
}

// Time formatter — HN gives unix seconds.
function relTime(unixSec) {
  if (!unixSec) return "";
  const sec = Math.floor(Date.now() / 1000) - unixSec;
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d`;
  if (sec < 86400 * 365) return `${Math.floor(sec / 86400 / 30)}mo`;
  return `${Math.floor(sec / 86400 / 365)}y`;
}

function domainOf(url) {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Strip HN's HTML out into mostly-plain text but keep paragraph breaks.
function decodeHtml(s) {
  if (!s) return "";
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}
function cleanCommentText(html) {
  if (!html) return "";
  let s = html
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<i>(.*?)<\/i>/gi, "$1")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "");
  return decodeHtml(s).trim();
}

// ─── Viewport hook ──────────────────────────────────────────────────────────
function useIsMobile() {
  const get = () => typeof window !== "undefined" &&
    (window.matchMedia("(max-width: 720px)").matches ||
     window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 900);
  const [m, setM] = useState(get);
  useEffect(() => {
    const onResize = () => setM(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return m;
}

// ─── React hook: fetch item ─────────────────────────────────────────────────
function useItem(id) {
  const [item, setItem] = useState(() => (id != null && memCache.get(id)) || null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (id == null) { setItem(null); return; }
    if (memCache.has(id)) { setItem(memCache.get(id)); return; }
    let alive = true;
    setItem(null);
    fetchItem(id).then(it => { if (alive) setItem(it || null); })
      .catch(e => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [id]);
  return { item, error };
}

// Prefetch a list of ids without rendering — eagerly warms cache.
function prefetch(ids) {
  for (const id of (ids || [])) {
    if (id != null && !memCache.has(id) && !inflight.has(id)) {
      fetchItem(id).catch(() => {});
    }
  }
}

// ─── Theme ──────────────────────────────────────────────────────────────────
const THEMES = {
  sketch: {
    bg: "#f4f0e6", ink: "#1a1a1a", inkSoft: "#5a544a", inkFaint: "#a09a8f",
    cellBg: "#fcfaf3", cellBgActive: "#f7f1dc",
    accent: "#d94a2e", accentSoft: "#f7d7ca",
    headFont: "'Caveat', 'Bradley Hand', cursive",
    bodyFont: "'Patrick Hand', 'Comic Neue', system-ui, sans-serif",
    monoFont: "'JetBrains Mono', ui-monospace, monospace",
    borderStyle: "2.5px solid", cellRadius: 4, strokeStyle: "dashed",
    shadowOffset: "6px 6px 0", variant: "sketch",
  },
  paper: {
    bg: "#ebe6dc", ink: "#221e18", inkSoft: "#6b6357", inkFaint: "#a89e8f",
    cellBg: "#f7f2e7", cellBgActive: "#fffaec",
    accent: "#8c2f1a", accentSoft: "#e8d5cc",
    headFont: "'Caveat', cursive",
    bodyFont: "'Kalam', 'Patrick Hand', cursive",
    monoFont: "'JetBrains Mono', ui-monospace, monospace",
    borderStyle: "1.5px solid", cellRadius: 2, strokeStyle: "solid",
    shadowOffset: "3px 3px 0", variant: "paper",
  },
  mono: {
    bg: "#0f0f0f", ink: "#e8e6df", inkSoft: "#8d8a7f", inkFaint: "#5a5750",
    cellBg: "#1a1a1a", cellBgActive: "#242420",
    accent: "#e8c547", accentSoft: "#3d3723",
    headFont: "'JetBrains Mono', ui-monospace, monospace",
    bodyFont: "'JetBrains Mono', ui-monospace, monospace",
    monoFont: "'JetBrains Mono', ui-monospace, monospace",
    borderStyle: "1px solid", cellRadius: 0, strokeStyle: "solid",
    shadowOffset: "0 0 0", variant: "mono",
  },
};

const TWEAK_DEFAULTS = {
  variant: "sketch",
  showMinimap: true,
  showHints: true,
  showBreadcrumb: true,
  showProgress: true,
  animateTransitions: true,
  gap: 8,
};

// ─── Seen-set (progress / fog-of-war) ───────────────────────────────────────
const SEEN_KEY = "fsq:seen";
function loadSeen() {
  try { const raw = localStorage.getItem(SEEN_KEY); if (raw) return new Set(JSON.parse(raw)); } catch {}
  return new Set();
}
function saveSeen(s) { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch {} }

// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
  const [tweaks, setTweaks] = useState(TWEAK_DEFAULTS);
  const [seen, setSeen] = useState(() => loadSeen());

  const [storyId, setStoryId] = useState(() => {
    try { const v = localStorage.getItem("fsq:storyId"); return v ? +v : null; } catch { return null; }
  });
  useEffect(() => {
    try {
      if (storyId) localStorage.setItem("fsq:storyId", String(storyId));
      else localStorage.removeItem("fsq:storyId");
    } catch {}
  }, [storyId]);

  const theme = THEMES[tweaks.variant] || THEMES.sketch;

  if (!storyId) {
    return <LibraryScreen theme={theme} onOpen={(id) => setStoryId(id)} seen={seen} />;
  }
  return (
    <Navigator
      key={storyId}
      storyId={storyId}
      theme={theme}
      tweaks={tweaks}
      seen={seen}
      setSeen={setSeen}
      onExit={() => setStoryId(null)}
    />
  );
}

// ─── Library ────────────────────────────────────────────────────────────────
function LibraryScreen({ theme, onOpen, seen }) {
  const [topIds, setTopIds] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(0);
  const PAGE = 24;

  useEffect(() => {
    fetchTopStories()
      .then(ids => {
        setTopIds(ids.slice(0, PAGE));
        // Pre-warm story headers for the visible page only.
        prefetch(ids.slice(0, PAGE));
      })
      .catch(setError);
  }, []);

  // Keyboard: ↑/↓ select, Enter opens.
  useEffect(() => {
    if (!topIds) return;
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (["arrowdown", "j", "s"].includes(k)) {
        e.preventDefault();
        setSelected(s => Math.min(topIds.length - 1, s + 1));
      } else if (["arrowup", "k", "w"].includes(k)) {
        e.preventDefault();
        setSelected(s => Math.max(0, s - 1));
      } else if (e.key === "Enter" || k === "arrowright" || k === "l") {
        e.preventDefault();
        if (topIds[selected]) onOpen(topIds[selected]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [topIds, selected, onOpen]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: theme.bg, color: theme.ink,
      fontFamily: theme.bodyFont, overflow: "auto",
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "32px 16px 64px",
    }}>
      <div style={{ maxWidth: 820, width: "100%" }}>
        <div style={{
          display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6,
          fontFamily: theme.monoFont, fontSize: 11, letterSpacing: "0.15em",
          textTransform: "uppercase", color: theme.inkSoft,
        }}>
          <span style={{ color: theme.accent, fontWeight: 700 }}>LIBRARY</span>
          <span>·</span>
          <span>top {topIds ? topIds.length : "—"} on hacker news</span>
          <span style={{ marginLeft: "auto" }}>↑↓ select · enter open</span>
        </div>
        <h1 style={{
          fontFamily: theme.headFont, fontSize: 56, lineHeight: 1.0,
          margin: 0, marginBottom: 28, color: theme.ink, textWrap: "balance",
        }}>
          triptik
        </h1>

        {error && <div style={{ color: theme.accent, padding: 12 }}>Failed to load HN: {String(error.message || error)}</div>}
        {!topIds && !error && <SkeletonList theme={theme} />}

        {topIds && (
          <div style={{ display: "grid", gap: 10 }}>
            {topIds.map((id, i) => (
              <StoryCard
                key={id}
                id={id}
                theme={theme}
                selected={i === selected}
                rank={i + 1}
                seen={seen}
                onSelect={() => setSelected(i)}
                onOpen={() => onOpen(id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonList({ theme }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{
          height: 76, border: `${theme.borderStyle} ${theme.inkFaint}`,
          borderStyle: theme.strokeStyle, borderRadius: theme.cellRadius,
          background: theme.cellBg, animation: "shimmer 1.4s ease-in-out infinite",
          animationDelay: `${i * 80}ms`,
        }}/>
      ))}
    </div>
  );
}

function StoryCard({ id, theme, selected, rank, seen, onSelect, onOpen }) {
  const { item } = useItem(id);
  const visited = seen.has(String(id)) || seen.has(id);
  return (
    <div
      onMouseEnter={onSelect}
      onClick={onOpen}
      style={{
        display: "grid", gridTemplateColumns: "44px 1fr auto",
        gap: 14, padding: "14px 16px",
        background: selected ? theme.cellBgActive : theme.cellBg,
        border: `${theme.borderStyle} ${selected ? theme.accent : theme.ink}`,
        borderStyle: theme.strokeStyle, borderRadius: theme.cellRadius,
        cursor: "pointer",
        boxShadow: selected && theme.variant !== "mono" ? `${theme.shadowOffset} ${theme.accent}` : "none",
        transition: "background 120ms, border-color 140ms, box-shadow 140ms, transform 120ms",
        transform: selected ? "translate(-2px,-2px)" : "translate(0,0)",
        opacity: visited ? 0.78 : 1,
      }}
    >
      <div style={{
        fontFamily: theme.monoFont, fontSize: 22, color: theme.inkFaint,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {String(rank).padStart(2, "0")}
      </div>
      <div style={{ minWidth: 0 }}>
        {!item ? (
          <div style={{ height: 48, opacity: 0.4, fontFamily: theme.monoFont, fontSize: 12, color: theme.inkSoft }}>
            loading…
          </div>
        ) : (
          <>
            <div style={{
              fontFamily: theme.headFont, fontSize: 24, lineHeight: 1.25,
              color: theme.ink, marginBottom: 4, textWrap: "balance",
            }}>
              {item.title || "(untitled)"}
            </div>
            <div style={{
              fontFamily: theme.monoFont, fontSize: 11, letterSpacing: "0.04em",
              textTransform: "uppercase", color: theme.inkSoft,
              display: "flex", flexWrap: "wrap", gap: 8,
            }}>
              <span>▲ {item.score || 0}</span>
              <span>·</span>
              <span>{item.by || "anon"}</span>
              <span>·</span>
              <span>{relTime(item.time)}</span>
              <span>·</span>
              <span>{(item.descendants ?? (item.kids || []).length) || 0} comments</span>
              {item.url && <><span>·</span><span style={{ color: theme.inkFaint }}>{domainOf(item.url)}</span></>}
            </div>
          </>
        )}
      </div>
      <div style={{
        display: "flex", alignItems: "center",
        fontFamily: theme.monoFont, fontSize: 11, letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: selected ? theme.accent : theme.inkFaint, fontWeight: 600,
      }}>
        open ↓
      </div>
    </div>
  );
}

// ─── Navigator ──────────────────────────────────────────────────────────────
// `path` is an array of HN ids: [storyId, commentId, ...] from root to current.
function Navigator({ storyId, theme, tweaks, seen, setSeen, onExit }) {
  const isMobile = useIsMobile();
  const PATH_KEY = `fsq:path:${storyId}`;
  const [path, setPath] = useState(() => {
    try { const raw = localStorage.getItem(PATH_KEY); if (raw) return JSON.parse(raw); } catch {}
    return [storyId];
  });
  useEffect(() => {
    try { localStorage.setItem(PATH_KEY, JSON.stringify(path)); } catch {}
  }, [path]);

  // Page: which pair of children of the current node we're showing.
  const [pageMap, setPageMap] = useState({});
  const pageKey = path.join(".");
  const page = pageMap[pageKey] || 0;
  const setPage = useCallback((p) => setPageMap(m => ({ ...m, [pageKey]: p })), [pageKey]);

  const [focus, setFocus] = useState("left");
  useEffect(() => { setFocus("left"); }, [pageKey]);

  // Fetch the node chain.
  const { item: current } = useItem(path[path.length - 1]);
  const { item: parent }  = useItem(path.length > 1 ? path[path.length - 2] : null);

  const childIds = (current && current.kids) || [];
  const pairStart = page * 2;
  const leftChildId  = childIds[pairStart] || null;
  const rightChildId = childIds[pairStart + 1] || null;
  const { item: leftChild }  = useItem(leftChildId);
  const { item: rightChild } = useItem(rightChildId);

  // Eagerly warm: the next pair, plus the focused child's first kids.
  useEffect(() => {
    prefetch([childIds[pairStart + 2], childIds[pairStart + 3]]);
    const focused = focus === "right" ? rightChild : leftChild;
    if (focused && focused.kids) prefetch(focused.kids.slice(0, 2));
  }, [childIds, pairStart, focus, leftChild, rightChild]);

  // Mark visible nodes as seen.
  useEffect(() => {
    const ids = [];
    if (current) ids.push(String(current.id));
    if (leftChild) ids.push(String(leftChild.id));
    if (rightChild) ids.push(String(rightChild.id));
    if (parent) ids.push(String(parent.id));
    if (!ids.length) return;
    setSeen(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) if (!next.has(id)) { next.add(id); changed = true; }
      if (changed) saveSeen(next);
      return changed ? next : prev;
    });
  }, [current && current.id, leftChild && leftChild.id, rightChild && rightChild.id, parent && parent.id]);

  // Animation flag.
  const [anim, setAnim] = useState(null);
  const animKey = `${pageKey}:${page}`;
  useEffect(() => {
    if (!anim) return;
    const t = setTimeout(() => setAnim(null), 450);
    return () => clearTimeout(t);
  }, [animKey]);

  // ─── Navigation ──────────────────────────────────────────────────────────
  const descendInto = useCallback((childId) => {
    if (!childId) return;
    setAnim("down");
    setPath(p => [...p, childId]);
  }, []);
  const descendFocused = useCallback(() => {
    descendInto(focus === "right" ? rightChildId : leftChildId);
  }, [descendInto, focus, leftChildId, rightChildId]);

  const ascend = useCallback(() => {
    if (path.length <= 1) return; // root-ascend is a no-op (E pattern: exit only via Esc)
    setAnim("up");
    setPath(p => p.slice(0, -1));
  }, [path]);

  const maxPage = Math.max(0, Math.ceil(childIds.length / 2) - 1);
  const goLeft = useCallback(() => {
    if (focus === "right") { setFocus("left"); return; }
    if (page > 0) {
      setAnim("pageL");
      setPage(page - 1);
      const newStart = (page - 1) * 2;
      setFocus(childIds[newStart + 1] ? "right" : "left");
    }
  }, [focus, page, setPage, childIds]);

  const goRight = useCallback(() => {
    if (focus === "left" && rightChildId) { setFocus("right"); return; }
    if (page < maxPage) {
      setAnim("pageR");
      setPage(page + 1);
      setFocus("left");
    }
  }, [focus, rightChildId, page, maxPage, setPage]);

  // Exit guard (B pattern: cooldown-confirm).
  const lastExitRef = useRef(0);
  const [exitHint, setExitHint] = useState(false);
  const exitTimerRef = useRef(null);
  const guardedExit = useCallback(() => {
    const now = Date.now();
    const dt = now - lastExitRef.current;
    lastExitRef.current = now;
    if (dt < 1000 && dt > 50) {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      setExitHint(false);
      onExit();
      return;
    }
    setExitHint(true);
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = setTimeout(() => setExitHint(false), 1100);
  }, [onExit]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") { e.preventDefault(); guardedExit(); return; }
      if (["arrowdown", "s", "j", " "].includes(k) || e.key === "Enter") { e.preventDefault(); descendFocused(); }
      else if (["arrowup", "w", "k", "backspace"].includes(k)) { e.preventDefault(); ascend(); }
      else if (["arrowleft", "a", "h"].includes(k)) { e.preventDefault(); goLeft(); }
      else if (["arrowright", "d", "l"].includes(k)) { e.preventDefault(); goRight(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [descendFocused, ascend, goLeft, goRight, guardedExit]);

  // Touch swipe — container handles HORIZONTAL only (page siblings).
  // Vertical gestures live on individual cells:
  //   parent cell → swipe-down ascends (with scrollTop guard)
  //   child cells → tap descends, long-press previews
  const touchRef = useRef(null);
  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const s = touchRef.current; if (!s) return;
    touchRef.current = null;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 50 || ax < ay * 1.4) return; // horizontal-dominant only
    if (dx < 0) goRight(); else goLeft();
  };

  const [preview, setPreview] = useState(null); // node being long-press previewed

  // Jump (used by breadcrumb).
  const jumpTo = useCallback((newPath) => {
    setAnim(newPath.length < path.length ? "up" : "down");
    setPath(newPath);
  }, [path.length]);

  const numPairs = Math.max(1, Math.ceil(childIds.length / 2));

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{
        position: "fixed", inset: 0,
        background: theme.bg, color: theme.ink,
        fontFamily: theme.bodyFont, overflow: "hidden",
      }}
    >
      <div style={{
        position: "absolute",
        top: tweaks.showBreadcrumb ? 36 : 0,
        left: 0, right: 0,
        bottom: (tweaks.showHints || tweaks.showMinimap || tweaks.showProgress) ? 44 : 0,
      }}>
        <Grid
          theme={theme} tweaks={tweaks}
          current={current} parent={parent} path={path}
          childIds={childIds} leftChild={leftChild} rightChild={rightChild}
          leftId={leftChildId} rightId={rightChildId}
          pairStart={pairStart} page={page} numPairs={numPairs}
          anim={anim} animKey={animKey}
          focus={focus} setFocus={setFocus}
          seen={seen}
          isMobile={isMobile}
          onDescendLeft={() => descendInto(leftChildId)}
          onDescendRight={() => descendInto(rightChildId)}
          onAscend={ascend}
          onPrev={goLeft} onNext={goRight}
          onPreview={setPreview}
        />
      </div>

      {tweaks.showBreadcrumb && (
        <Breadcrumb
          path={path} theme={theme} onJump={jumpTo}
          onExit={guardedExit} exitLabel="library" exitHintVisible={exitHint}
        />
      )}

      {(tweaks.showHints || tweaks.showMinimap || tweaks.showProgress) && (
        <div style={{
          position: "fixed", left: 0, right: 0, bottom: 0, height: 44,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 14, padding: "0 14px",
          background: theme.bg, borderTop: `1px ${theme.strokeStyle} ${theme.ink}`,
          zIndex: 10,
        }}>
          {tweaks.showHints ? (
            <Hints theme={theme}
              hasParent={path.length > 1}
              numChildren={childIds.length}
              numPairs={numPairs} page={page} focus={focus}
              hasRight={!!rightChildId} canExit
            />
          ) : <div/>}
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {tweaks.showProgress && current && (
              <ProgressBar theme={theme} seen={seen}
                total={(current.descendants || 0) + 1}
              />
            )}
            {tweaks.showMinimap && (
              <CacheBadge theme={theme} />
            )}
          </div>
        </div>
      )}

      {preview && (
        <PreviewOverlay node={preview} theme={theme} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

// ─── Grid ────────────────────────────────────────────────────────────────────
function Grid({
  theme, tweaks,
  current, parent, path, childIds, leftChild, rightChild, leftId, rightId,
  pairStart, page, numPairs, anim, animKey,
  focus, setFocus, seen, isMobile,
  onDescendLeft, onDescendRight, onAscend, onPrev, onNext, onPreview,
}) {
  const animate = tweaks.animateTransitions;
  const padding = isMobile ? 8 : 16;
  // Mobile: 1+2 stack, parent gets ~55% of height. Desktop: equal quarters.
  const rows = isMobile ? "1.25fr 1fr" : "1fr 1fr";
  return (
    <div key={animKey} style={{
      position: "absolute", inset: 0, padding,
      display: "grid", gridTemplateColumns: "1fr 1fr",
      gridTemplateRows: rows, gap: isMobile ? Math.min(tweaks.gap, 6) : tweaks.gap,
    }}>
      <ParentSlot animate={animate} anim={anim} isMobile={isMobile}
                  canAscend={path.length > 1} onAscend={onAscend}>
        <Cell theme={theme} node={current} role="current"
              showUpChevron={path.length > 1} onUp={onAscend}
              isMobile={isMobile} />
      </ParentSlot>

      <ChildSlot side="left" animate={animate} anim={anim}
        focusOnEnter={() => leftId && setFocus("left")}
        onLongPress={leftChild ? () => onPreview(leftChild) : null}
        isMobile={isMobile}
      >
        {leftId ? (
          <Cell theme={theme} node={leftChild} role="child"
                onDescend={onDescendLeft} focused={!isMobile && focus === "left"}
                seen={seen} isMobile={isMobile}
                orderLabel={`reply ${pairStart + 1} of ${childIds.length}`}/>
        ) : (
          <EmptyCell theme={theme} label={path.length === 1 ? "no comments yet" : "no replies"} />
        )}
      </ChildSlot>

      <ChildSlot side="right" animate={animate} anim={anim}
        focusOnEnter={() => rightId && setFocus("right")}
        onLongPress={rightChild ? () => onPreview(rightChild) : null}
        isMobile={isMobile}
      >
        {rightId ? (
          <Cell theme={theme} node={rightChild} role="child"
                onDescend={onDescendRight} focused={!isMobile && focus === "right"}
                seen={seen} isMobile={isMobile}
                orderLabel={`reply ${pairStart + 2} of ${childIds.length}`}/>
        ) : leftId ? (
          <EmptyCell theme={theme} label={childIds.length === 1 ? "only one reply" : "end of siblings"} />
        ) : (
          <EmptyCell theme={theme} label="—" dim />
        )}
      </ChildSlot>

      {childIds.length > 2 && (
        <PairDots theme={theme} numPairs={numPairs} page={page} onPrev={onPrev} onNext={onNext}/>
      )}
    </div>
  );
}

// Parent slot: on mobile, swipe-down ascends but only when the inner cell
// is scrolled to the top (so in-cell scrolling never gets hijacked).
function ParentSlot({ children, animate, anim, isMobile, canAscend, onAscend }) {
  const startRef = useRef(null);
  const ref = useRef(null);
  if (!isMobile) {
    return (
      <div style={{ gridColumn: "1 / -1", animation: animate ? animEnterTop(anim) : "none" }}>
        {children}
      </div>
    );
  }
  // Find the scrollable inner element (the cell body) at touch start.
  const scrollerAtTop = () => {
    const root = ref.current; if (!root) return true;
    // Find first element with overflow auto/scroll inside.
    const scroller = root.querySelector('[data-cell-body="1"]');
    return !scroller || scroller.scrollTop <= 0;
  };
  const onTouchStart = (e) => {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY, atTop: scrollerAtTop() };
  };
  const onTouchEnd = (e) => {
    const s = startRef.current; if (!s) return;
    startRef.current = null;
    if (!canAscend || !s.atTop) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (dy > 60 && Math.abs(dy) > Math.abs(dx) * 1.4 && scrollerAtTop()) {
      onAscend();
    }
  };
  return (
    <div ref={ref}
         onTouchStart={onTouchStart}
         onTouchEnd={onTouchEnd}
         style={{ gridColumn: "1 / -1", animation: animate ? animEnterTop(anim) : "none" }}>
      {children}
    </div>
  );
}

// Child slot: long-press shows preview overlay (on mobile).
function ChildSlot({ children, side, animate, anim, focusOnEnter, onLongPress, isMobile }) {
  const timerRef = useRef(null);
  const movedRef = useRef(false);
  const startRef = useRef(null);
  const firedRef = useRef(false);

  const handlers = isMobile && onLongPress ? {
    onTouchStart: (e) => {
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY };
      movedRef.current = false;
      firedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (!movedRef.current) {
          firedRef.current = true;
          if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
          onLongPress();
        }
      }, 480);
    },
    onTouchMove: (e) => {
      const s = startRef.current; if (!s) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10) {
        movedRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
      }
    },
    onTouchEnd: () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    // If long-press fired, swallow the click that follows.
    onClickCapture: (e) => {
      if (firedRef.current) { e.stopPropagation(); e.preventDefault(); firedRef.current = false; }
    },
  } : {};

  return (
    <div onMouseEnter={focusOnEnter}
         {...handlers}
         style={{ animation: animate ? animEnterChild(anim, side) : "none" }}>
      {children}
    </div>
  );
}

function animEnterTop(anim) {
  if (anim === "down") return "slideFromBelow 360ms cubic-bezier(.2,.7,.2,1)";
  if (anim === "up")   return "slideFromAbove 360ms cubic-bezier(.2,.7,.2,1)";
  return "none";
}
function animEnterChild(anim, side) {
  if (anim === "down" || anim === "up") return "fadeIn 260ms ease-out 80ms both";
  if (anim === "pageR") return "slideFromRight 280ms cubic-bezier(.2,.7,.2,1)";
  if (anim === "pageL") return "slideFromLeft 280ms cubic-bezier(.2,.7,.2,1)";
  return "none";
}

// ─── Cell ────────────────────────────────────────────────────────────────────
function Cell({ theme, node, role, onDescend, onUp, showUpChevron, focused, seen, orderLabel, isMobile }) {
  const isCurrent = role === "current";
  const [hover, setHover] = useState(false);
  const isHot = hover || focused;
  const clickable = role === "child" && !!onDescend;

  const alreadyVisited = node && (seen?.has(String(node.id)) || seen?.has(node.id));
  const isStory = node && node.type === "story";

  return (
    <div
      onClick={clickable ? onDescend : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", width: "100%", height: "100%",
        background: isHot ? theme.cellBgActive : theme.cellBg,
        border: `${theme.borderStyle} ${theme.ink}`,
        borderStyle: theme.strokeStyle, borderRadius: theme.cellRadius,
        boxShadow: theme.variant !== "mono"
          ? (focused ? `${theme.shadowOffset} ${theme.accent}` : `${theme.shadowOffset} ${theme.ink}`)
          : (focused ? `inset 0 0 0 2px ${theme.accent}` : "none"),
        outline: focused && theme.variant !== "mono" ? `2px solid ${theme.accent}` : "none",
        outlineOffset: focused ? -1 : 0,
        cursor: clickable ? "pointer" : "default",
        transition: "background 120ms, transform 120ms, box-shadow 140ms, outline-color 140ms",
        transform: isHot && clickable ? "translate(-2px,-2px)" : "translate(0,0)",
        overflow: "hidden", display: "flex", flexDirection: "column",
      }}
    >
      <CellHeader theme={theme} node={node} role={role} orderLabel={orderLabel}
                  showUpChevron={showUpChevron} onUp={onUp} isMobile={isMobile} />
      <div data-cell-body="1" style={{
        flex: 1, overflowY: "auto",
        padding: isCurrent
          ? (isMobile ? "12px 14px 14px" : "18px 24px 24px")
          : (isMobile ? "10px 12px 12px" : "14px 18px 18px"),
        lineHeight: 1.45,
        fontSize: isStory
          ? (isCurrent ? (isMobile ? 17 : 22) : (isMobile ? 14 : 17))
          : (isCurrent ? (isMobile ? 16 : 19) : (isMobile ? 13.5 : 15.5)),
        fontFamily: theme.bodyFont, color: theme.ink,
      }}>
        {!node ? (
          <Loading theme={theme} />
        ) : isStory ? (
          <StoryBody node={node} theme={theme} isCurrent={isCurrent}/>
        ) : node.deleted ? (
          <div style={{ color: theme.inkFaint, fontStyle: "italic" }}>[deleted]</div>
        ) : node.dead ? (
          <div style={{ color: theme.inkFaint, fontStyle: "italic" }}>[dead]</div>
        ) : (
          <div style={{ whiteSpace: "pre-wrap", textWrap: "pretty" }}>
            {cleanCommentText(node.text)}
          </div>
        )}
      </div>
      <CellFooter theme={theme} node={node} role={role} clickable={clickable}
                  hover={isHot} alreadyVisited={alreadyVisited}/>
    </div>
  );
}

function CellHeader({ theme, node, role, orderLabel, showUpChevron, onUp, isMobile }) {
  const isCurrent = role === "current";
  const isStory = node && node.type === "story";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      padding: isCurrent
        ? (isMobile ? "8px 12px" : "12px 20px")
        : (isMobile ? "6px 10px" : "10px 16px"),
      borderBottom: `1px ${theme.strokeStyle} ${theme.ink}`,
      fontFamily: theme.monoFont, fontSize: isMobile ? 10 : 11, letterSpacing: "0.04em",
      textTransform: "uppercase", color: theme.inkSoft, flexShrink: 0,
    }}>
      {isCurrent && showUpChevron && (
        <button onClick={(e) => { e.stopPropagation(); onUp && onUp(); }}
          title="Up to parent (↑)" style={{
            width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: `1px ${theme.strokeStyle} ${theme.ink}`,
            borderRadius: theme.cellRadius, color: theme.ink, cursor: "pointer",
            padding: 0, fontFamily: theme.monoFont, fontSize: 14, lineHeight: 1,
          }}>↑</button>
      )}
      {!node ? (
        <span style={{ color: theme.inkFaint }}>loading…</span>
      ) : isStory ? (
        <>
          <span style={{ color: theme.accent, fontWeight: 600 }}>STORY</span>
          <span>·</span><span>▲ {node.score || 0}</span>
          <span>·</span><span>{node.by}</span>
          <span>·</span><span>{relTime(node.time)}</span>
          <span style={{ marginLeft: "auto" }}>{node.descendants ?? 0} comments</span>
        </>
      ) : (
        <>
          <span style={{ color: theme.accent, fontWeight: 600 }}>{node.by || "anon"}</span>
          <span>·</span><span>{relTime(node.time)}</span>
          {orderLabel && <span style={{ marginLeft: "auto", color: theme.inkFaint }}>{orderLabel}</span>}
          {!orderLabel && isCurrent && (
            <span style={{ marginLeft: "auto", color: theme.inkFaint }}>
              {(node.kids || []).length} {(node.kids || []).length === 1 ? "reply" : "replies"}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function CellFooter({ theme, node, role, clickable, hover, alreadyVisited }) {
  if (role === "current") return null;
  const n = node ? (node.kids || []).length : 0;
  return (
    <div style={{
      padding: "8px 16px 10px", borderTop: `1px ${theme.strokeStyle} ${theme.ink}`,
      fontFamily: theme.monoFont, fontSize: 10.5, letterSpacing: "0.04em",
      textTransform: "uppercase", color: hover ? theme.ink : theme.inkSoft,
      display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
    }}>
      <span>{node ? (n === 0 ? "leaf · no replies" : `${n} ${n === 1 ? "reply" : "replies"} below`) : "…"}</span>
      {clickable && (
        <span style={{
          color: alreadyVisited ? theme.inkFaint : theme.accent, fontWeight: 600,
          transition: "transform 120ms", transform: hover ? "translateX(3px)" : "translateX(0)",
          opacity: alreadyVisited ? 0.65 : 1,
        }}>
          {alreadyVisited ? "revisit ↓" : "dive in ↓"}
        </span>
      )}
    </div>
  );
}

function StoryBody({ node, theme, isCurrent }) {
  return (
    <div>
      <h1 style={{
        fontFamily: theme.headFont,
        fontSize: `clamp(22px, ${isCurrent ? "5.2vw" : "3.8vw"}, ${isCurrent ? 44 : 30}px)`,
        lineHeight: 1.05, margin: 0, marginBottom: 12, color: theme.ink, textWrap: "balance",
        letterSpacing: theme.variant === "mono" ? "-0.02em" : "0",
      }}>
        {node.title}
      </h1>
      {node.url && (
        <div style={{
          fontFamily: theme.monoFont, fontSize: 12, color: theme.inkSoft,
          marginBottom: 16, textDecoration: "underline", textUnderlineOffset: 3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          <a href={node.url} target="_blank" rel="noreferrer"
             style={{ color: "inherit", textDecoration: "inherit" }}
             onClick={(e) => e.stopPropagation()}>
            ({domainOf(node.url)})
          </a>
        </div>
      )}
      {node.text && (
        <p style={{ margin: 0, textWrap: "pretty" }}>{cleanCommentText(node.text)}</p>
      )}
    </div>
  );
}

// ─── Long-press preview overlay ─────────────────────────────────────────────
function PreviewOverlay({ node, theme, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const isStory = node && node.type === "story";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "flex-end", justifyContent: "center",
        animation: "fadeIn 180ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.bg, color: theme.ink,
          width: "100%", maxWidth: 720, maxHeight: "85vh",
          border: `${theme.borderStyle} ${theme.ink}`, borderStyle: theme.strokeStyle,
          borderRadius: `${theme.cellRadius * 2}px ${theme.cellRadius * 2}px 0 0`,
          boxShadow: theme.variant !== "mono" ? `0 -8px 0 ${theme.accent}` : "none",
          display: "flex", flexDirection: "column",
          animation: "slideFromBelow 240ms cubic-bezier(.2,.7,.2,1)",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 16px",
          borderBottom: `1px ${theme.strokeStyle} ${theme.ink}`,
          fontFamily: theme.monoFont, fontSize: 11, letterSpacing: "0.06em",
          textTransform: "uppercase", color: theme.inkSoft,
        }}>
          <span style={{ color: theme.accent, fontWeight: 600 }}>preview</span>
          <span>·</span>
          <span>{node.by || "anon"}</span>
          <span>·</span>
          <span>{relTime(node.time)}</span>
          <button onClick={onClose} style={{
            marginLeft: "auto",
            background: "none", border: `1px ${theme.strokeStyle} ${theme.ink}`,
            color: theme.ink, fontFamily: theme.monoFont, fontSize: 11,
            padding: "4px 10px", borderRadius: theme.cellRadius, cursor: "pointer",
            letterSpacing: "0.06em", textTransform: "uppercase",
          }}>close</button>
        </div>
        <div style={{
          flex: 1, overflowY: "auto", padding: "16px 20px 24px",
          fontFamily: theme.bodyFont, fontSize: 17, lineHeight: 1.5,
        }}>
          {isStory ? (
            <StoryBody node={node} theme={theme} isCurrent />
          ) : (
            <div style={{ whiteSpace: "pre-wrap", textWrap: "pretty" }}>
              {cleanCommentText(node.text)}
            </div>
          )}
        </div>
        <div style={{
          padding: "8px 16px 12px",
          borderTop: `1px ${theme.strokeStyle} ${theme.ink}`,
          fontFamily: theme.monoFont, fontSize: 10.5,
          letterSpacing: "0.06em", textTransform: "uppercase", color: theme.inkSoft,
          display: "flex", justifyContent: "space-between",
        }}>
          <span>{(node.kids || []).length} replies below</span>
          <span style={{ color: theme.inkFaint }}>tap outside or esc to dismiss</span>
        </div>
      </div>
    </div>
  );
}

function EmptyCell({ theme, label, dim }) {
  return (
    <div style={{
      width: "100%", height: "100%",
      border: `${theme.borderStyle} ${dim ? theme.inkFaint : theme.ink}`,
      borderStyle: "dashed", borderRadius: theme.cellRadius, background: "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: dim ? theme.inkFaint : theme.inkSoft, fontFamily: theme.monoFont,
      fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase",
      opacity: dim ? 0.5 : 1,
    }}>{label}</div>
  );
}

function Loading({ theme }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100%", color: theme.inkFaint, fontFamily: theme.monoFont,
      fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
      animation: "shimmer 1.4s ease-in-out infinite",
    }}>fetching from hn…</div>
  );
}

// ─── Pagination dots ────────────────────────────────────────────────────────
function PairDots({ theme, numPairs, page, onPrev, onNext }) {
  return (
    <div style={{
      position: "absolute", bottom: 6, left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: 10, padding: "4px 12px",
      background: theme.bg, border: `1px ${theme.strokeStyle} ${theme.ink}`,
      borderRadius: 999, fontFamily: theme.monoFont, fontSize: 10,
      letterSpacing: "0.06em", textTransform: "uppercase", color: theme.inkSoft, zIndex: 5,
    }}>
      <button onClick={onPrev} disabled={page === 0} style={{
        background: "none", border: "none",
        color: page === 0 ? theme.inkFaint : theme.ink,
        cursor: page === 0 ? "default" : "pointer",
        fontFamily: theme.monoFont, fontSize: 14, padding: "0 4px",
      }}>←</button>
      <div style={{ display: "flex", gap: 6 }}>
        {Array.from({ length: numPairs }).map((_, i) => (
          <div key={i} style={{
            width: i === page ? 16 : 6, height: 6, borderRadius: 3,
            background: i === page ? theme.ink : theme.inkFaint, transition: "all 180ms",
          }}/>
        ))}
      </div>
      <button onClick={onNext} disabled={page >= numPairs - 1} style={{
        background: "none", border: "none",
        color: page >= numPairs - 1 ? theme.inkFaint : theme.ink,
        cursor: page >= numPairs - 1 ? "default" : "pointer",
        fontFamily: theme.monoFont, fontSize: 14, padding: "0 4px",
      }}>→</button>
    </div>
  );
}

// ─── Breadcrumb ─────────────────────────────────────────────────────────────
function Breadcrumb({ path, theme, onJump, exitLabel, onExit, exitHintVisible }) {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0,
      display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 10,
    }}>
      <div style={{
        pointerEvents: "auto",
        display: "flex", alignItems: "center", gap: 10, padding: "6px 14px",
        background: theme.bg, border: `1px ${theme.strokeStyle} ${theme.ink}`,
        borderTop: "none", borderRadius: `0 0 ${theme.cellRadius}px ${theme.cellRadius}px`,
        fontFamily: theme.monoFont, fontSize: 11, letterSpacing: "0.06em",
        textTransform: "uppercase", color: theme.inkSoft, maxWidth: "70vw",
      }}>
        {exitLabel && onExit && (
          <>
            <button onClick={onExit} title={`Back to ${exitLabel}`} style={{
              background: "none", border: "none", fontFamily: theme.monoFont, fontSize: 11,
              letterSpacing: "0.06em", textTransform: "uppercase",
              color: exitHintVisible ? theme.accent : theme.inkSoft, cursor: "pointer",
              padding: 0, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center",
              gap: 4, position: "relative", transition: "color 160ms",
            }}>
              <span style={{ fontSize: 13, lineHeight: 1 }}>‹</span> {exitLabel}
              {exitHintVisible && (
                <span style={{
                  position: "absolute", top: "calc(100% + 10px)", left: "50%",
                  transform: "translateX(-50%)",
                  background: theme.ink, color: theme.bg,
                  padding: "6px 10px", borderRadius: 4, fontSize: 10.5,
                  letterSpacing: "0.06em", fontFamily: theme.monoFont,
                  textTransform: "uppercase", whiteSpace: "nowrap",
                  pointerEvents: "none", zIndex: 20,
                }}>press again to leave</span>
              )}
            </button>
            <span style={{ color: theme.inkFaint }}>›</span>
          </>
        )}
        <BreadcrumbChain path={path} theme={theme} onJump={onJump} />
      </div>
    </div>
  );
}

function BreadcrumbChain({ path, theme, onJump }) {
  return (
    <>
      {path.map((id, i) => {
        const isLast = i === path.length - 1;
        return (
          <React.Fragment key={i}>
            <BreadcrumbDot id={id} theme={theme} isStory={i === 0} isLast={isLast}
              onClick={() => !isLast && onJump(path.slice(0, i + 1))}/>
            {!isLast && <span style={{ color: theme.inkFaint }}>›</span>}
          </React.Fragment>
        );
      })}
    </>
  );
}
function BreadcrumbDot({ id, theme, isStory, isLast, onClick }) {
  const { item } = useItem(id);
  const label = isStory ? "story" : (item ? (item.by || "anon") : "…");
  return (
    <button onClick={onClick} disabled={isLast} style={{
      background: "none", border: "none", fontFamily: theme.monoFont, fontSize: 11,
      letterSpacing: "0.06em", textTransform: "uppercase",
      color: isLast ? theme.ink : theme.inkSoft,
      cursor: isLast ? "default" : "pointer", padding: 0, whiteSpace: "nowrap",
    }}>{label}</button>
  );
}

// ─── Hints rail ─────────────────────────────────────────────────────────────
function Hints({ theme, hasParent, numChildren, numPairs, page, focus, hasRight, canExit }) {
  const Pill = ({ children, dim }) => (
    <span style={{
      padding: "3px 8px", border: `1px ${theme.strokeStyle} ${dim ? theme.inkFaint : theme.ink}`,
      borderRadius: theme.cellRadius, fontFamily: theme.monoFont, fontSize: 10,
      letterSpacing: "0.06em", textTransform: "uppercase",
      color: dim ? theme.inkFaint : theme.ink, opacity: dim ? 0.55 : 1,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
  const leftLabel = focus === "right" ? "focus left" : (page > 0 ? "prev pair" : "—");
  const rightLabel = focus === "left" && hasRight ? "focus right" : (page < numPairs - 1 ? "next pair" : "—");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Pill dim={!numChildren}>↓ dive in</Pill>
      <Pill dim={!hasParent}>↑ back up</Pill>
      <Pill dim={leftLabel === "—"}>← {leftLabel}</Pill>
      <Pill dim={rightLabel === "—"}>→ {rightLabel}</Pill>
      <Pill dim={!canExit}>esc library</Pill>
    </div>
  );
}

// ─── Progress bar (per-thread % seen) ───────────────────────────────────────
function ProgressBar({ theme, seen, total }) {
  // We can't enumerate the whole tree without fetching it (which would defeat
  // caching). Use story.descendants + 1 (root) as the denominator and count
  // any seen ids that we've actually loaded.
  const seenInThread = useMemo(() => {
    let n = 0;
    for (const id of seen) if (memCache.has(+id) || memCache.has(id)) n++;
    return n;
  }, [seen, total]);
  const denom = Math.max(1, total);
  const pct = Math.min(100, Math.round((seenInThread / denom) * 100));
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontFamily: theme.monoFont, fontSize: 10, letterSpacing: "0.06em",
      textTransform: "uppercase", color: theme.inkSoft,
    }}>
      <span>read</span>
      <div style={{
        width: 96, height: 6, background: theme.cellBgActive,
        border: `1px ${theme.strokeStyle} ${theme.ink}`, borderRadius: 3, overflow: "hidden",
      }}>
        <div style={{ width: `${pct}%`, height: "100%", background: theme.accent, transition: "width 240ms" }}/>
      </div>
      <span>{pct}%</span>
    </div>
  );
}

function CacheBadge({ theme }) {
  const [n, setN] = useState(memCache.size);
  useEffect(() => {
    const t = setInterval(() => setN(memCache.size), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div title="Items cached this session" style={{
      fontFamily: theme.monoFont, fontSize: 10, letterSpacing: "0.06em",
      textTransform: "uppercase", color: theme.inkFaint,
      padding: "3px 8px", border: `1px ${theme.strokeStyle} ${theme.inkFaint}`,
      borderRadius: theme.cellRadius,
    }}>cache · {n}</div>
  );
}

// ─── Mount ──────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
