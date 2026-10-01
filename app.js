(() => {
"use strict";

/* ============================================================
   基础
   ============================================================ */
const KINDS = [
  {k:"note",  zh:"札记",     en:"Notes"},
  {k:"quote", zh:"摘句",     en:"Quotes"},
  {k:"link",  zh:"延伸阅读", en:"Reading"},
  {k:"color", zh:"色票",     en:"Swatches"},
  {k:"image", zh:"图像",     en:"Plates"},
];
const kindOf = k => KINDS.find(x => x.k === k) || KINDS[0];
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [a, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (a === "class") el.className = v;
    else if (a.startsWith("on")) el.addEventListener(a.slice(2), v);
    else el.setAttribute(a, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const DAY = 864e5;
const CN_NUM = ["〇","一","二","三","四","五","六","七","八","九","十","十一","十二"];
const WEEK = ["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];
const pad = (n, l = 3) => String(n).padStart(l, "0");
const folio = n => "P. " + pad(n);
const cnMonth = m => CN_NUM[m + 1] + "月";
const cnDay = d => d <= 10 ? (d === 10 ? "十" : CN_NUM[d]) : d < 20 ? "十" + CN_NUM[d - 10] : d % 10 === 0 ? CN_NUM[d / 10] + "十" : CN_NUM[Math.floor(d / 10)] + "十" + CN_NUM[d % 10];
const fmtFull = t => new Date(t).toLocaleString("zh-CN", {year:"numeric", month:"long", day:"numeric", hour:"2-digit", minute:"2-digit"});
const enDate = t => new Date(t).toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric"});
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const haptic = () => { try { navigator.vibrate?.(8); } catch {} };
const isLatin = s => !!s && !/[㐀-鿿]/.test(s);

let toastT;
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 1800); }
async function copy(text, label){
  try { await navigator.clipboard.writeText(text); toast(label || "已复制"); }
  catch { toast("复制失败，请长按文字手动复制"); }
}

const HEX = /#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
function parseHexes(s){
  const out = [];
  for (const m of (s || "").matchAll(HEX)) {
    let v = m[1].toLowerCase();
    if (v.length === 3) v = [...v].map(c => c + c).join("");
    out.push("#" + v.toUpperCase());
  }
  return out.slice(0, 8);
}
function rgb(hex){ const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function cmyk(hex){
  const [r, g, b] = rgb(hex).map(v => v / 255), k = 1 - Math.max(r, g, b);
  if (k >= 1) return "C0 M0 Y0 K100";
  const f = v => Math.round((1 - v - k) / (1 - k) * 100);
  return `C${f(r)} M${f(g)} Y${f(b)} K${Math.round(k * 100)}`;
}
const parseTags = s => [...new Set((s || "").split(/[\s,，、#]+/).map(t => t.trim()).filter(Boolean))].slice(0, 8);
function domainOf(u){ try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }
function normUrl(u){ u = (u || "").trim(); if (!u) return ""; return /^https?:\/\//i.test(u) ? u : "https://" + u; }

/* ============================================================
   存储：IndexedDB（图片以 Blob 保存）
   ============================================================ */
const DB = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("shiyi", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("items", {keyPath: "id"});
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("items", mode), s = t.objectStore("items");
      const out = fn(s);
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    all: () => tx("readonly", s => s.getAll()),
    put: item => tx("readwrite", s => s.put(item)),
    putMany: list => tx("readwrite", s => list.forEach(i => s.put(i))),
    del: id => tx("readwrite", s => s.delete(id)),
    clear: () => tx("readwrite", s => s.clear()),
  };
})();
const settings = {
  get(k, d){ try { return localStorage.getItem("shiyi." + k) ?? d; } catch { return d; } },
  set(k, v){ try { localStorage.setItem("shiyi." + k, v); } catch {} },
};
try { navigator.storage?.persist?.(); } catch {}

const urlCache = new Map();
function imgSrc(it){
  if (it.src) return it.src;
  if (!it.blob) return "";
  if (!urlCache.has(it.id)) urlCache.set(it.id, URL.createObjectURL(it.blob));
  return urlCache.get(it.id);
}

/* ============================================================
   图片：压缩 + 提取主色
   ============================================================ */
function loadImg(src){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function prepImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const s = Math.min(1, 1800 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0, cv.width, cv.height);
    const colors = palette(cx, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", .86));
    return {blob, preview: URL.createObjectURL(blob), colors, w: cv.width, h: cv.height};
  } finally { URL.revokeObjectURL(url); }
}
function palette(cx, w, hgt){
  const step = Math.max(1, Math.floor(Math.sqrt(w * hgt / 4000)));
  const d = cx.getImageData(0, 0, w, hgt).data, buckets = new Map();
  for (let y = 0; y < hgt; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4; if (d[i + 3] < 128) continue;
    const key = (d[i] >> 5) << 6 | (d[i + 1] >> 5) << 3 | (d[i + 2] >> 5);
    const b = buckets.get(key) || [0, 0, 0, 0]; b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++; buckets.set(key, b);
  }
  const sorted = [...buckets.values()].sort((a, b) => b[3] - a[3]).map(b => [b[0] / b[3], b[1] / b[3], b[2] / b[3]]);
  const out = [];
  for (const c of sorted) {
    if (out.every(o => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) > 48)) out.push(c);
    if (out.length === 5) break;
  }
  return out.map(c => "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase());
}
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const dataUrlToBlob = async u => (await fetch(u)).blob();

/* ============================================================
   样刊（没有任何收录时显示，不写入存储）
   ============================================================ */
function sampleImage(){
  const W = 800, H = 1000, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#E9C2A6"); g.addColorStop(.5, "#C98A86"); g.addColorStop(1, "#38365C");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = "#F8E6C4"; x.beginPath(); x.arc(520, 560, 92, 0, Math.PI * 2); x.fill();
  x.fillStyle = "#26264A"; x.beginPath(); x.moveTo(0, 720);
  for (let i = 0; i <= W; i += 20) x.lineTo(i, 690 + Math.sin(i / 60) * 26 + Math.cos(i / 23) * 8);
  x.lineTo(W, H); x.lineTo(0, H); x.fill();
  x.fillStyle = "rgba(248,230,196,.35)";
  for (let i = 0; i < 9; i++) x.fillRect(430 + Math.sin(i) * 30, 740 + i * 22, 180 - i * 14, 3);
  const id = x.getImageData(0, 0, W, H);
  for (let i = 0; i < id.data.length; i += 4) { const n = (Math.random() - .5) * 26; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return c.toDataURL("image/jpeg", .82);
}
const now = Date.now();
const SAMPLES = [
  {id:"s7", type:"image", caption:"傍晚七点的海边，粉色退到紫色只用了四分钟。", colors:["#E9C2A6","#C98A86","#38365C","#F8E6C4","#26264A"], tags:["日落","配色"], w:800, h:1000, createdAt: now - 0.1 * DAY},
  {id:"s1", type:"quote", text:"少，但是更好。", source:"迪特·拉姆斯", tags:["设计原则"], createdAt: now - 0.2 * DAY},
  {id:"s4", type:"note", text:"空状态别只放插画。给用户一个可以直接点下去的第一步，比任何文案都更能让人留下来。", tags:["交互"], createdAt: now - 0.3 * DAY},
  {id:"s5", type:"link", url:"https://www.are.na", note:"频道而不是信息流，一种慢速的收藏方式。", tags:["工具"], createdAt: now - 1.1 * DAY},
  {id:"s2", type:"color", name:"雨后的地铁站", colors:["#5E6472","#8E9AAF","#C9BBA9","#D8D3CD","#A3A79B"], tags:["配色","城市"], createdAt: now - 1.2 * DAY},
  {id:"s6", type:"quote", text:"Design is not just what it looks like and feels like. Design is how it works.", source:"Steve Jobs", tags:["设计原则"], createdAt: now - 2.2 * DAY},
  {id:"s3", type:"note", text:"杂志的节奏来自留白和反差：一页满版大图，下一页只有一句话。", tags:["版式"], createdAt: now - 2.3 * DAY},
];
SAMPLES.forEach(s => s.sample = true);

/* ============================================================
   状态
   ============================================================ */
let items = [];
const view = {kind: "all", tag: null, q: ""};
const pool = () => items.length ? items : SAMPLES;
let pageNo = new Map();
function renumber(){ pageNo = new Map([...pool()].sort((a, b) => a.createdAt - b.createdAt).map((x, i) => [x.id, i + 1])); }
const pg = it => pageNo.get(it.id) || 0;

async function reload(){
  try { items = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt); }
  catch { items = []; toast("无法读取本机存储，可能处于无痕模式"); }
  renderAll();
}

/* ============================================================
   版面：每种内容的排法
   ============================================================ */
function chipsEl(colors, big){
  return h("div", {class:"chips"}, colors.map((c, i) => h("div", {class:"chip", onclick: big ? () => copy(c, "已复制 " + c) : null, title: big ? "复制色值" : null},
    h("i", {style:"background:" + c}),
    h("span", {}, c, h("small", {}, big ? cmyk(c) : "SHIYI " + pad(i + 1, 2))))));
}
function colorbarEl(colors, big){
  return h("div", {class:"colorbar", "aria-hidden": big ? null : "true"},
    colors.map(c => h("i", {style:"background:" + c, title: c, onclick: big ? () => copy(c, "已复制 " + c) : null})),
    h("span", {class:"reg"}));
}
function content(it, big){
  switch (it.type) {
    case "quote": return h("div", {class:"e-quote"},
      h("span", {class:"mark", "aria-hidden":"true"}, "“"),
      h("p", {class: isLatin(it.text) ? "latin" : null}, it.text),
      it.source && h("cite", {}, it.source));
    case "note": return h("div", {class:"e-note"}, h("p", {}, it.text));
    case "link": return h("div", {class:"e-link"},
      h("p", {class:"dom"}, domainOf(it.url)),
      h("div", {class:"url"}, it.url.replace(/^https?:\/\//, "")),
      it.note && h("p", {class:"why"}, it.note),
      !big && h("span", {class:"go"}, "READ →"));
    case "color": return h("div", {class:"e-color"},
      chipsEl(it.colors, big),
      it.name && h("p", {class:"e-cname"}, it.name, h("em", {}, it.colors.length + " colours")));
    case "image": return h("div", {class:"e-img"},
      h("img", {src: imgSrc(it), alt: it.caption || "收录的图像", loading:"lazy", decoding:"async", width: it.w, height: it.h}),
      h("div", {class:"e-side"},
        it.colors?.length && colorbarEl(it.colors, big),
        h("p", {class:"e-cap"}, h("b", {}, "图 " + pg(it)), it.caption || "")));
  }
  return h("div");
}
function spans(it){
  if (it.type === "quote") return true;
  if (it.type === "image") return true;
  if (it.type === "color") return (it.colors || []).length >= 4;
  if (it.type === "note") return (it.text || "").length > 70;
  return false;
}
function entry(it, {forceSpan, onTap} = {}){
  const k = kindOf(it.type);
  const tap = onTap || (() => openDetail(it));
  const wide = forceSpan || spans(it);
  const portrait = it.type === "image" && it.w && it.h && it.h > it.w * 1.15;
  return h("article", {class:"entry" + (wide ? " span" : "") + (portrait ? " portrait" : "") + (it.sample ? " sample" : ""), tabindex:"0", "data-id": it.id,
      onclick: tap, onkeydown: e => { if (e.key === "Enter") tap(); }},
    h("div", {class:"e-kick"}, h("span", {class:"kick"}, wide ? k.zh + " · " + k.en : k.zh), h("span", {class:"folio"}, folio(pg(it)))),
    content(it, false),
    it.tags?.length ? h("div", {class:"e-tags"}, it.tags.map(t => h("span", {}, "#" + t))) : null);
}

/* ============================================================
   本期：封面 + 目录 + 正文
   ============================================================ */
function issueInfo(){
  const d = new Date();
  const first = items.length ? new Date(Math.min(...items.map(x => x.createdAt))) : d;
  const vol = d.getFullYear() - first.getFullYear() + 1;
  const no = (d.getFullYear() - first.getFullYear()) * 12 + d.getMonth() - first.getMonth() + 1;
  return {vol, no, month: cnMonth(d.getMonth()) + "刊", year: d.getFullYear(), first};
}
function renderCover(){
  const p = pool(), info = issueInfo();
  $("#coverVol").textContent = "VOL. " + pad(info.vol, 2);
  $("#coverMonth").textContent = info.month;
  $("#coverNo").textContent = "NO. " + pad(info.no, 2);
  $("#runnerIssue").textContent = info.year + " · " + info.month;
  const weekAgo = Date.now() - 7 * DAY;
  $("#st-total").textContent = pad(items.length, 2);
  $("#st-week").textContent = pad(items.filter(x => x.createdAt > weekAgo).length, 2);
  $("#st-tags").textContent = pad(new Set(items.flatMap(x => x.tags || [])).size, 2);

  const recent = p.slice(0, 12);
  const it = recent.find(x => x.type === "image") || recent.find(x => x.type === "quote") || p[0];
  const box = $("#coverStory");
  if (!it) { box.replaceChildren(); return; }
  const kick = h("div", {class:"cs-kick kick"}, h("span", {}, "封面故事 · Cover Story"), h("span", {class:"folio"}, folio(pg(it))));
  let visual = null, head = "", by = "", latin = false;
  if (it.type === "image") { visual = h("img", {class:"cs-img", src: imgSrc(it), alt: it.caption || "封面图像"}); head = it.caption || "无题"; by = (it.tags || []).map(t => "#" + t).join("  "); }
  if (it.type === "quote") { head = "“" + it.text + "”"; by = it.source ? "—— " + it.source : ""; latin = isLatin(it.text); }
  if (it.type === "note") { head = it.text.length > 48 ? it.text.slice(0, 48) + "……" : it.text; by = "札记"; }
  if (it.type === "link") { head = domainOf(it.url); by = it.note || ""; latin = true; }
  if (it.type === "color") { visual = h("div", {class:"cs-chips"}, it.colors.map(c => h("i", {style:"background:" + c}))); head = it.name || "无名色票"; by = it.colors.join("  "); }
  box.replaceChildren(h("button", {type:"button", onclick: () => openDetail(it)},
    kick, visual, h("h2", {class:"cs-head" + (latin ? " latin" : "")}, head), by && h("p", {class:"cs-by"}, by)));
}
function renderToc(){
  const p = pool();
  const rows = [{k:"all", zh:"全部", en:"All", c:p.length}, ...KINDS.map(k => ({...k, c: p.filter(x => x.type === k.k).length}))];
  $("#toc").replaceChildren(...rows.map((r, i) => h("li", {}, h("button", {type:"button", "aria-pressed": String(view.kind === r.k),
      onclick: () => { view.kind = view.kind === r.k ? "all" : r.k; renderWall(); scrollToFeature(); }},
    h("span", {class:"n"}, pad(i, 2)),
    h("span", {class:"t"}, r.zh, h("em", {}, r.en)),
    h("span", {class:"c"}, pad(r.c, 2))))));
}
function scrollToFeature(){
  const target = $("#readingBar").hidden ? $("#feature") : $("#readingBar");
  $("#wallScroll").scrollTo({top: target.offsetTop - 60, behavior: "smooth"});
}
function renderFeature(){
  const p = pool(), q = view.q.toLowerCase();
  const shown = p.filter(x =>
    (view.kind === "all" || x.type === view.kind) &&
    (!view.tag || (x.tags || []).includes(view.tag)) &&
    (!q || [x.text, x.source, x.note, x.url, x.name, x.caption, ...(x.tags || []), ...(x.colors || [])].join(" ").toLowerCase().includes(q)));

  const filters = [view.kind !== "all" && kindOf(view.kind).zh, view.tag && "#" + view.tag, view.q && "“" + view.q + "”"].filter(Boolean);
  const bar = $("#readingBar");
  bar.hidden = !filters.length;
  if (filters.length) bar.replaceChildren(h("span", {}, "正在阅读：" + filters.join(" · ") + "（" + shown.length + "）"),
    h("button", {class:"link-btn", type:"button", onclick: () => { view.kind = "all"; view.tag = null; view.q = ""; $("#q").value = ""; renderWall(); }}, "看全部"));

  const out = [];
  let lastDay = "";
  for (const it of shown) {
    const d = new Date(it.createdAt), key = d.toDateString();
    if (key !== lastDay) {
      lastDay = key;
      out.push(h("div", {class:"dateline"}, h("b", {}, cnMonth(d.getMonth()) + cnDay(d.getDate()) + "日 · " + WEEK[d.getDay()]), h("span", {}, enDate(it.createdAt))));
    }
    out.push(entry(it));
  }
  $("#feature").replaceChildren(...out);
  $("#none").hidden = shown.length > 0;
  $("#sampleNote").hidden = items.length > 0;
}
function renderWall(){ renumber(); renderCover(); renderToc(); renderFeature(); }

$("#wallScroll").addEventListener("scroll", e => $("#wallRunner").classList.toggle("show", e.target.scrollTop > 260), {passive: true});
$("#searchToggle").onclick = () => { $("#searchRow").hidden = false; $("#wallRunner").classList.remove("show"); $("#q").focus(); };
$("#searchCancel").onclick = () => { $("#searchRow").hidden = true; $("#q").value = ""; view.q = ""; renderWall(); };
$("#q").addEventListener("input", e => { view.q = e.target.value.trim(); renderFeature(); });
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") { e.target.blur(); scrollToFeature(); } });

/* ============================================================
   底部导航
   ============================================================ */
let currentTab = "wall";
function go(tab){
  if (tab === currentTab) {
    if (tab === "wall") $("#wallScroll").scrollTo({top: 0, behavior: "smooth"});
    return;
  }
  currentTab = tab;
  document.querySelectorAll(".screen").forEach(s => s.hidden = s.dataset.tab !== tab);
  document.querySelectorAll(".tab").forEach(b => b.dataset.go === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  if (tab === "wander" && !deckCur) nextWander();
  haptic();
}
document.querySelectorAll(".tab").forEach(b => b.onclick = () => go(b.dataset.go));
function filterByTag(t){ view.tag = t; view.kind = "all"; go("wall"); renderWall(); setTimeout(scrollToFeature, 30); }

/* 索引 */
function renderTags(){
  const map = new Map();
  for (const it of items) for (const t of it.tags || []) { if (!map.has(t)) map.set(t, []); map.get(t).push(it); }
  const coll = new Intl.Collator("zh-Hans-CN");
  const rows = [...map.entries()].sort((a, b) => coll.compare(a[0], b[0]));
  $("#tagList").hidden = !rows.length;
  $("#tagsNone").hidden = !!rows.length;
  $("#tagList").replaceChildren(...rows.map(([t, list]) => {
    const sorted = list.sort((a, b) => pg(a) - pg(b));
    const shown = sorted.slice(0, 6);
    return h("li", {},
      h("button", {class:"term", type:"button", onclick: () => filterByTag(t)}, t),
      h("span", {class:"leader"}),
      h("span", {class:"pages"}, shown.map(it => h("button", {type:"button", onclick: () => openDetail(it), "aria-label": "翻到第 " + pg(it) + " 页"}, pg(it))),
        sorted.length > shown.length ? h("button", {type:"button", onclick: () => filterByTag(t)}, "…") : null));
  }));
}

/* 版权页 */
function renderMe(){
  const info = issueInfo();
  $("#coCount").textContent = items.length + " 则";
  $("#coSince").textContent = items.length ? info.first.toLocaleDateString("zh-CN", {year:"numeric", month:"long", day:"numeric"}) : "今天";
  $("#coIssues").textContent = "第 " + info.no + " 期 · 第 " + info.vol + " 卷";
  const th = settings.get("theme", "system");
  document.querySelectorAll("#themeSeg button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.themeVal === th)));
}

/* ============================================================
   漫游
   ============================================================ */
let deckCur = null, lastWanderId = null;
function nextWander(dir = -1){
  const p = pool();
  if (!p.length) return;
  let pick;
  do { pick = p[Math.floor(Math.random() * p.length)]; } while (p.length > 1 && pick.id === lastWanderId);
  lastWanderId = pick.id; deckCur = pick;
  const deck = $("#deck");
  const old = deck.querySelector(".entry:not(.under)");
  const c = entry(pick, {forceSpan: true});
  c.classList.add("under");
  deck.append(c);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    c.classList.remove("under");
    if (old) {
      old.style.transform = `translateX(${dir * 120}%) rotate(${dir * 8}deg)`;
      old.style.opacity = "0";
      setTimeout(() => old.remove(), 380);
    }
  }));
  const days = Math.max(0, Math.floor((Date.now() - pick.createdAt) / DAY));
  $("#wanderLede").textContent = pick.sample ? "这是样刊里的一页。收录多了以后，这里会翻出你忘掉的东西。"
    : days === 0 ? "今天刚收进来的一页" : `翻到第 ${pg(pick)} 页，${days} 天前收录`;
  enableSwipe(c);
  haptic();
}
function enableSwipe(el){
  let x0 = null, dx = 0;
  el.addEventListener("pointerdown", e => { x0 = e.clientX; dx = 0; el.style.transition = "none"; });
  el.addEventListener("pointermove", e => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    if (Math.abs(dx) > 6) el.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
  });
  const end = () => {
    if (x0 == null) return;
    el.style.transition = "";
    if (Math.abs(dx) > 90) nextWander(dx > 0 ? 1 : -1);
    else el.style.transform = "";
    x0 = null;
  };
  el.addEventListener("pointerup", () => { if (Math.abs(dx) > 6) el.addEventListener("click", ev => ev.stopPropagation(), {capture: true, once: true}); end(); });
  el.addEventListener("pointercancel", end);
}
$("#wanderNext").onclick = () => nextWander();
$("#wanderOpen").onclick = () => deckCur && openDetail(deckCur);

/* ============================================================
   文章页
   ============================================================ */
let detailItem = null;
function openDetail(it){
  detailItem = it;
  const k = kindOf(it.type);
  $("#detailNo").textContent = folio(pg(it));
  const copyText = it.type === "color" || it.type === "image" ? (it.colors || []).join(" ")
    : it.type === "link" ? it.url : [it.text, it.source && "—— " + it.source].filter(Boolean).join("\n");
  const actions = [
    it.type === "link" && h("a", {class:"solid-btn", href: it.url, target:"_blank", rel:"noopener"}, "阅读原文 ↗"),
    copyText && h("button", {class:"ghost-btn", type:"button", onclick: () => copy(copyText, "已复制")}, it.type === "color" || it.type === "image" ? "复制色值" : "复制"),
    !it.sample && h("button", {class:"ghost-btn danger", type:"button", onclick: () => confirmDelete(it)}, "删除"),
  ];
  const body = $("#detailBody");
  body.replaceChildren(...[
    h("div", {class:"a-kick"}, h("span", {class:"kick"}, k.zh + " · " + k.en + (it.sample ? " · 样刊" : "")), h("span", {class:"folio"}, enDate(it.createdAt))),
    h("div", {class:"a-body"}, content(it, true)),
    (it.type === "color" || it.type === "image") && it.colors?.length ? h("p", {class:"a-hint"}, "轻点色块即可复制色值") : null,
    h("dl", {class:"a-meta"},
      h("dt", {}, "收录"), h("dd", {}, fmtFull(it.createdAt)),
      h("dt", {}, "页码"), h("dd", {}, folio(pg(it)) + " / " + pad(pool().length)),
      it.tags?.length ? [h("dt", {}, "索引"), h("dd", {}, it.tags.map(t => h("button", {type:"button", onclick: () => { closeDetail(); filterByTag(t); }}, "#" + t)))] : null,
      it.type === "link" ? [h("dt", {}, "原址"), h("dd", {style:"overflow-wrap:anywhere"}, it.url)] : null),
    h("div", {class:"a-actions"}, actions.filter(Boolean)),
    h("p", {class:"a-end"}, "■"),
  ].filter(Boolean));
  body.scrollTop = 0;
  $("#detail").hidden = false;
  history.pushState({detail: it.id}, "");
  $("#detailBack").focus({preventScroll: true});
}
function closeDetail(){ $("#detail").hidden = true; if (history.state?.detail) history.back(); }
$("#detailBack").onclick = closeDetail;
window.addEventListener("popstate", () => {
  if (!$("#composeScrim").hidden && !history.state?.compose) hideCompose();
  if (!$("#detail").hidden && !history.state?.detail) $("#detail").hidden = true;
});
$("#detailShare").onclick = async () => {
  const it = detailItem; if (!it) return;
  const text = it.type === "quote" ? `“${it.text}”${it.source ? " —— " + it.source : ""}`
    : it.type === "note" ? it.text
    : it.type === "link" ? [it.note, it.url].filter(Boolean).join("\n")
    : [it.name || it.caption, (it.colors || []).join(" ")].filter(Boolean).join("\n");
  const data = {title: "拾遗", text};
  try {
    if (it.type === "image" && it.blob) {
      const f = new File([it.blob], "shiyi.jpg", {type: "image/jpeg"});
      if (navigator.canShare?.({files: [f]})) data.files = [f];
    }
    if (navigator.share) await navigator.share(data);
    else copy(text, "已复制，可以粘贴分享");
  } catch (e) { if (e?.name !== "AbortError") copy(text, "已复制，可以粘贴分享"); }
};

/* 确认框 */
let pendingConfirm = null;
function askConfirm(text, okLabel, fn){
  $("#confirmText").textContent = text;
  $("#confirmOk").textContent = okLabel;
  pendingConfirm = fn;
  $("#confirmScrim").hidden = false;
}
$("#confirmCancel").onclick = () => { $("#confirmScrim").hidden = true; pendingConfirm = null; };
$("#confirmScrim").onclick = e => { if (e.target.id === "confirmScrim") $("#confirmCancel").click(); };
$("#confirmOk").onclick = async () => { $("#confirmScrim").hidden = true; const f = pendingConfirm; pendingConfirm = null; await f?.(); };
function confirmDelete(it){
  askConfirm(`撤下第 ${pg(it)} 页？删除后无法恢复。`, "删除", async () => {
    try {
      await DB.del(it.id);
      if (urlCache.has(it.id)) { URL.revokeObjectURL(urlCache.get(it.id)); urlCache.delete(it.id); }
      closeDetail();
      if (deckCur?.id === it.id) deckCur = null;
      await reload();
      toast("已撤下");
    } catch { toast("没能删除，请再试一次"); }
  });
}

/* ============================================================
   收录
   ============================================================ */
let draftKind = "note", draftImage = null;
function showCompose(kind){
  if (kind) draftKind = kind;
  draftImage = null;
  $("#composeFolio").textContent = folio(items.length + 1);
  renderPicker(); renderFields();
  $("#composeScrim").hidden = false;
  history.pushState({compose: 1}, "");
  haptic();
}
function hideCompose(){ $("#composeScrim").hidden = true; document.activeElement?.blur(); }
function closeCompose(){ hideCompose(); if (history.state?.compose) history.back(); }
$("#addBtn").onclick = () => showCompose();
$("#composeCancel").onclick = closeCompose;
$("#composeScrim").addEventListener("click", e => { if (e.target.id === "composeScrim") closeCompose(); });

function renderPicker(){
  $("#kindPicker").replaceChildren(...KINDS.map((k, i) => h("button", {type:"button", role:"tab", "aria-selected": String(k.k === draftKind),
    onclick: () => { draftKind = k.k; renderPicker(); renderFields(); }}, h("i", {}, pad(i + 1, 2)), k.zh)));
}
function field(label, id, attrs){
  const el = h(attrs.rows ? "textarea" : "input", {id, ...attrs});
  if (attrs.rows) el.rows = attrs.rows;
  return h("label", {class:"f", for: id}, h("span", {}, label), el);
}
function renderFields(focus = true){
  const f = $("#fields");
  const tags = field("索引 · Tags", "f-tags", {placeholder:"用空格分开：配色 字体 海报", enterkeyhint:"done"});
  let rows = [];
  if (draftKind === "note") rows = [field("正文 · Text", "f-text", {rows:4, class:"big", placeholder:"刚刚想到的……"})];
  if (draftKind === "quote") rows = [field("摘句 · Quote", "f-text", {rows:3, class:"big", placeholder:"摘下那句打动你的话"}), field("出处 · Source", "f-source", {placeholder:"作者《书名》"})];
  if (draftKind === "link") rows = [field("网址 · URL", "f-url", {type:"url", inputmode:"url", placeholder:"https://", autocapitalize:"off"}), field("推荐语 · Why", "f-note", {rows:2, placeholder:"为什么值得一读？"})];
  if (draftKind === "color") {
    const prev = h("div", {class:"prev-chips", id:"f-prev"});
    const lab = field("色值 · Hex", "f-hex", {placeholder:"#1F2A44 #E3C08D #F6F1E7", class:"hex", autocapitalize:"characters"});
    const inp = lab.querySelector("input");
    inp.addEventListener("input", () => { const c = parseHexes(inp.value); prev.replaceChildren(...(c.length ? [chipsEl(c, false)] : [])); });
    rows = [lab, prev, field("色票名 · Name", "f-name", {placeholder:"给这组颜色起个名字"})];
  }
  if (draftKind === "image") {
    const file = h("input", {type:"file", accept:"image/*", id:"f-file", hidden:true});
    const drop = h("button", {class:"drop", id:"f-drop", type:"button"});
    const paint = () => drop.replaceChildren(...(draftImage
      ? [h("img", {src: draftImage.preview, alt:"待收录的图像"}), h("div", {style:"width:100%"}, colorbarEl(draftImage.colors, false)), h("span", {}, "轻点更换")]
      : [h("strong", {}, "选择一张图像"), h("span", {}, "从相册选取或拍照，会自动印出五色色带")]));
    paint();
    const take = async fl => {
      if (!fl || !/^image\//.test(fl.type)) return toast("请选择图片文件");
      drop.replaceChildren(h("span", {}, "正在制版……"));
      try { draftImage = await prepImage(fl); } catch { toast("这张图片打不开，换一张试试"); }
      paint();
    };
    drop.onclick = () => file.click();
    file.onchange = () => take(file.files[0]);
    f._take = take;
    rows = [file, drop, field("图注 · Caption", "f-caption", {placeholder:"一句说明"})];
  }
  f.replaceChildren(...rows, tags);
  if (focus && draftKind !== "image") setTimeout(() => f.querySelector("textarea,input:not([type=file])")?.focus(), 60);
}
const val = id => (document.getElementById(id)?.value || "").trim();

async function save(){
  const base = {id: uid(), type: draftKind, tags: parseTags(val("f-tags")), createdAt: Date.now()};
  let item;
  if (draftKind === "note") { if (!val("f-text")) return toast("先写点什么"); item = {...base, text: val("f-text")}; }
  if (draftKind === "quote") { if (!val("f-text")) return toast("摘句不能为空"); item = {...base, text: val("f-text"), source: val("f-source")}; }
  if (draftKind === "link") { const u = normUrl(val("f-url")); if (!/\./.test(u)) return toast("请填一个有效的网址"); item = {...base, url: u, note: val("f-note")}; }
  if (draftKind === "color") { const c = parseHexes(val("f-hex")); if (!c.length) return toast("至少填一个色值，例如 #1F3BD8"); item = {...base, colors: c, name: val("f-name")}; }
  if (draftKind === "image") { if (!draftImage) return toast("先选一张图像"); item = {...base, blob: draftImage.blob, colors: draftImage.colors, w: draftImage.w, h: draftImage.h, caption: val("f-caption")}; }
  try { await DB.put(item); }
  catch (e) { return toast(e?.name === "QuotaExceededError" ? "设备存储空间不足" : "没能保存，请再试一次"); }
  draftImage = null;
  closeCompose();
  view.kind = "all"; view.tag = null;
  await reload();
  if (currentTab !== "wall") go("wall");
  setTimeout(scrollToFeature, 50);
  toast("已收进本期 · " + folio(items.length));
  haptic();
}
$("#compose").addEventListener("submit", e => { e.preventDefault(); save(); });
$("#compose").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });

/* 在任意位置粘贴：图片 / 链接 / 色值 / 文字 */
document.addEventListener("paste", e => {
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) { e.preventDefault(); if ($("#composeScrim").hidden) showCompose("image"); else { draftKind = "image"; renderPicker(); renderFields(false); } $("#fields")._take(file); return; }
  if (inField) return;
  const text = e.clipboardData?.getData("text")?.trim(); if (!text) return;
  e.preventDefault();
  if (/^https?:\/\/\S+$/i.test(text)) { showCompose("link"); $("#f-url").value = text; }
  else if (parseHexes(text).length && text.replace(HEX, "").replace(/[\s,，]/g, "") === "") { showCompose("color"); const i = $("#f-hex"); i.value = text; i.dispatchEvent(new Event("input")); }
  else { showCompose("note"); $("#f-text").value = text; }
});

/* 从其他 App 分享进来 */
(function handleShareTarget(){
  const p = new URLSearchParams(location.search);
  const url = p.get("url") || (p.get("text") || "").match(/https?:\/\/\S+/)?.[0];
  const text = [p.get("title"), p.get("text")].filter(Boolean).join("\n").replace(url || "\u0000", "").trim();
  if (!url && !text) return;
  history.replaceState(null, "", location.pathname);
  setTimeout(() => {
    if (url) { showCompose("link"); $("#f-url").value = url; if (text) $("#f-note").value = text; }
    else { showCompose("note"); $("#f-text").value = text; }
  }, 300);
})();

/* ============================================================
   版权页：版式 / 档案 / 订阅
   ============================================================ */
function applyTheme(){
  const t = settings.get("theme", "system");
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", dark ? "#0F0F11" : "#FBFBF8"));
}
document.querySelectorAll("#themeSeg button").forEach(b => b.onclick = () => { settings.set("theme", b.dataset.themeVal); applyTheme(); renderMe(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

$("#exportBtn").onclick = async () => {
  if (!items.length) return toast("还没有可导出的内容");
  toast("正在装订……");
  const out = [];
  for (const it of items) {
    const { blob, ...rest } = it;
    out.push(blob ? {...rest, image: await blobToDataUrl(blob)} : rest);
  }
  const file = new Blob([JSON.stringify({app: "shiyi", version: 1, exportedAt: Date.now(), items: out})], {type: "application/json"});
  const name = `拾遗合订本-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const f = new File([file], name, {type: "application/json"});
    if (navigator.canShare?.({files: [f]})) { await navigator.share({files: [f], title: name}); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  const a = h("a", {href: URL.createObjectURL(file), download: name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("合订本已导出");
};
$("#importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data?.app !== "shiyi" || !Array.isArray(data.items)) throw new Error("format");
    const list = [];
    for (const it of data.items) {
      if (!it?.id || !KINDS.some(k => k.k === it.type)) continue;
      const { image, ...rest } = it;
      list.push(image ? {...rest, blob: await dataUrlToBlob(image)} : rest);
    }
    await DB.putMany(list);
    await reload();
    toast(`已恢复 ${list.length} 则`);
  } catch { toast("这个文件不是拾遗的合订本"); }
};
$("#clearBtn").onclick = () => {
  if (!items.length) return toast("已经是空的了");
  askConfirm(`停刊并清空全部 ${items.length} 则收录？建议先导出合订本。`, "全部清空", async () => {
    await DB.clear(); urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear(); deckCur = null;
    await reload(); toast("已清空");
  });
};

let installEvt = null;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });
if (standalone) $("#installBlock").hidden = true;
$("#installBtn").onclick = async () => {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome === "accepted") toast("已添加到主屏幕"); return; }
  $("#installHint").textContent = isIOS ? "Safari 底部「分享」→「添加到主屏幕」" : "浏览器菜单 →「安装应用」";
};

/* ============================================================
   启动
   ============================================================ */
function renderAll(){ renderWall(); renderTags(); renderMe(); }
SAMPLES.find(s => s.id === "s7").src = sampleImage();
applyTheme();
renderAll();
reload();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
})();
