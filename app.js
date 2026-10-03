(() => {
"use strict";

/* ============================================================
   基础
   ============================================================ */
const KINDS = [
  {k:"note",  zh:"想法", en:"Note"},
  {k:"quote", zh:"引语", en:"Quote"},
  {k:"link",  zh:"链接", en:"Link"},
  {k:"image", zh:"图片", en:"Image"},
  {k:"color", zh:"色彩", en:"Palette", legacy:true},   // 旧版本留下的配色卡：只显示，不再新建
];
const CREATE_KINDS = KINDS.filter(k => !k.legacy);
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
const pad = n => String(n).padStart(3, "0");
const fmtDate = t => { const d = new Date(t); return `${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`; };
const fmtFull = t => new Date(t).toLocaleString("zh-CN", {year:"numeric", month:"long", day:"numeric", hour:"2-digit", minute:"2-digit"});
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const haptic = () => { try { navigator.vibrate?.(8); } catch {} };

let toastT;
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 1800); }
async function copy(text, label){
  try { await navigator.clipboard.writeText(text); toast(label || "已复制"); }
  catch { toast("复制失败，请长按文字手动复制"); }
}

function lum(hex){
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
}
const onColor = hex => lum(hex) > .4 ? "#151821" : "#FFFFFF";
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
// ask the browser not to evict our data
try { navigator.storage?.persist?.(); } catch {}

const urlCache = new Map();
function imgSrc(it){
  if (it.src) return it.src;
  if (!it.blob) return "";
  if (!urlCache.has(it.id)) urlCache.set(it.id, URL.createObjectURL(it.blob));
  return urlCache.get(it.id);
}

/* ============================================================
   图片：压缩（保留一份未裁剪的原图，方便以后重新裁剪）
   ============================================================ */
function loadImg(src){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
const toBlob = (cv, q = .88) => new Promise(r => cv.toBlob(r, "image/jpeg", q));
async function prepImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const s = Math.min(1, 2400 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    return await toBlob(cv);
  } finally { URL.revokeObjectURL(url); }
}
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const dataUrlToBlob = async u => (await fetch(u)).blob();

/* ============================================================
   示例（仅在没有任何收藏时显示，不写入存储）
   ============================================================ */
function sampleImage(){
  const c = document.createElement("canvas"); c.width = 600; c.height = 440;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 440); g.addColorStop(0, "#F2B48C"); g.addColorStop(.55, "#C77B7F"); g.addColorStop(1, "#3D3B63");
  x.fillStyle = g; x.fillRect(0, 0, 600, 440);
  x.fillStyle = "#FBE3B8"; x.beginPath(); x.arc(400, 260, 64, 0, Math.PI * 2); x.fill();
  x.fillStyle = "#2A2A4A"; x.beginPath(); x.moveTo(0, 340);
  for (let i = 0; i <= 600; i += 20) x.lineTo(i, 310 + Math.sin(i / 45) * 18 + Math.cos(i / 17) * 6);
  x.lineTo(600, 440); x.lineTo(0, 440); x.fill();
  const id = x.getImageData(0, 0, 600, 440);
  for (let i = 0; i < id.data.length; i += 4) { const n = (Math.random() - .5) * 22; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return c.toDataURL("image/jpeg", .85);
}
const now = Date.now();
const SAMPLES = [
  {id:"s1", type:"quote", text:"少，但是更好。", source:"迪特·拉姆斯 · Weniger, aber besser", tags:["设计原则"], createdAt: now - 1 * DAY},
  {id:"s2", type:"note", text:"地铁里有人用便利贴给陌生人留言：“今天也辛苦了。”可以做成一个线下装置。", tags:["装置","城市"], createdAt: now - 2 * DAY},
  {id:"s3", type:"image", caption:"傍晚七点的海边，粉色退到紫色只用了四分钟。", tags:["日落","摄影"], createdAt: now - 3 * DAY, src: ""},
  {id:"s4", type:"note", text:"空状态别只放插画。给用户一个可以直接点下去的第一步。", tags:["交互"], createdAt: now - 4 * DAY},
  {id:"s5", type:"link", url:"https://www.are.na", note:"频道而不是信息流，一种慢速的收藏方式。", tags:["工具"], createdAt: now - 5 * DAY},
  {id:"s6", type:"quote", text:"Design is not just what it looks like and feels like. Design is how it works.", source:"Steve Jobs", tags:["设计原则"], createdAt: now - 6 * DAY},
];
SAMPLES.forEach(s => s.sample = true);

/* ============================================================
   状态
   ============================================================ */
let items = [];
const view = {kind: "all", tag: null, q: ""};
const pool = () => items.length ? items : SAMPLES;
const numberOf = (() => {
  let cache = new Map(), key = "";
  return id => {
    const p = pool(), k = p.length + ":" + (p[0]?.id || "");
    if (k !== key) { key = k; cache = new Map([...p].sort((a, b) => a.createdAt - b.createdAt).map((x, i) => [x.id, i + 1])); }
    return cache.get(id) || 0;
  };
})();

async function reload(){
  try { items = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt); }
  catch { items = []; toast("无法读取本机存储，可能处于无痕模式"); }
  renderAll();
}

/* ============================================================
   卡片
   ============================================================ */
function cardBody(it, big){
  switch (it.type) {
    case "quote": return [h("div", {class:"body"}, h("div", {class:"q-mark", "aria-hidden":"true"}, "“"), h("p", {class:"q-text"}, it.text), it.source && h("div", {class:"q-src"}, "— " + it.source))];
    case "note": return [h("div", {class:"body"}, h("p", {class:"n-text"}, it.text))];
    case "link": return [h("div", {class:"body"},
      h("div", {class:"l-domain"}, h("span", {}, domainOf(it.url)), h("span", {class:"arrow"}, "↗")),
      h("div", {class:"l-url mono"}, it.url),
      it.note && h("p", {class:"n-text"}, it.note))];
    case "color": return [
      h("div", {class:"bands"}, it.colors.map(c => h("div", {class:"mono", style:`background:${c};color:${onColor(c)}`, onclick: big ? () => copy(c, "已复制 " + c) : null}, c))),
      it.name && h("div", {class:"body"}, h("div", {class:"c-name"}, it.name))];
    case "image": return [
      h("img", {class:"img", src: imgSrc(it), alt: it.caption || "收藏的图片", loading:"lazy", decoding:"async"}),
      it.caption && h("div", {class:"body"}, h("p", {class:"caption"}, it.caption))];
  }
  return [];
}
function card(it, onTap){
  return h("article", {class:"card" + (it.sample ? " sample" : ""), tabindex:"0", "data-id": it.id,
      onclick: onTap, onkeydown: e => { if (e.key === "Enter") onTap(); }},
    ...cardBody(it, false),
    it.tags?.length ? h("div", {class:"tags"}, it.tags.map(t => h("span", {}, "#" + t))) : null,
    h("div", {class:"meta mono"}, h("span", {class:"no"}, "No." + pad(numberOf(it.id))), h("span", {class:"kind"}, it.sample ? "示例" : fmtDate(it.createdAt))));
}

/* ============================================================
   灵感墙
   ============================================================ */
function renderWall(){
  const p = pool(), empty = !items.length;
  const weekAgo = Date.now() - 7 * DAY;
  $("#st-total").textContent = items.length;
  $("#st-week").textContent = items.filter(x => x.createdAt > weekAgo).length;
  $("#st-tags").textContent = new Set(items.flatMap(x => x.tags || [])).size;

  const counts = Object.fromEntries(KINDS.map(k => [k.k, p.filter(x => x.type === k.k).length]));
  $("#kinds").replaceChildren(
    h("button", {class:"chip", type:"button", "aria-pressed": String(view.kind === "all"), onclick: () => { view.kind = "all"; renderWall(); }}, "全部", h("span", {class:"mono"}, p.length)),
    ...KINDS.filter(k => !k.legacy || counts[k.k]).map(k => h("button", {class:"chip", type:"button", "aria-pressed": String(view.kind === k.k), onclick: () => { view.kind = view.kind === k.k ? "all" : k.k; renderWall(); }}, k.zh, h("span", {class:"mono"}, counts[k.k]))));

  const at = $("#activeTag");
  at.hidden = !view.tag;
  if (view.tag) at.replaceChildren(h("span", {}, "正在看 #" + view.tag), h("button", {class:"text-btn", type:"button", onclick: () => { view.tag = null; renderWall(); }}, "清除"));

  const q = view.q.toLowerCase();
  const shown = p.filter(x =>
    (view.kind === "all" || x.type === view.kind) &&
    (!view.tag || (x.tags || []).includes(view.tag)) &&
    (!q || [x.text, x.source, x.note, x.url, x.name, x.caption, ...(x.tags || []), ...(x.colors || [])].join(" ").toLowerCase().includes(q)));
  $("#board").replaceChildren(...shown.map(x => card(x, () => openDetail(x))));
  $("#emptyNote").hidden = !empty;
  $("#none").hidden = shown.length > 0;
}

// 滚动时收起大标题 → 显示小标题
$("#wallScroll").addEventListener("scroll", e => $("#wallbar").classList.toggle("scrolled", e.target.scrollTop > 90), {passive: true});
document.querySelectorAll(".screen:not(#screen-wall) .scroll").forEach(s =>
  s.addEventListener("scroll", () => s.previousElementSibling?.classList.toggle("scrolled", s.scrollTop > 4), {passive: true}));

$("#searchToggle").onclick = () => { $("#searchRow").hidden = false; $("#q").focus(); };
$("#searchCancel").onclick = () => { $("#searchRow").hidden = true; $("#q").value = ""; view.q = ""; renderWall(); };
$("#q").addEventListener("input", e => { view.q = e.target.value.trim(); renderWall(); });

/* ============================================================
   标签页 / 底部导航
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
$("#meBtn").onclick = () => go("me");
$("#meBack").onclick = () => go("wall");

function renderMe(){
  $("#meCount").textContent = items.length + " 枚收藏";
  const first = items.length ? Math.min(...items.map(x => x.createdAt)) : null;
  $("#meSince").textContent = first ? "从 " + new Date(first).toLocaleDateString("zh-CN", {year:"numeric", month:"long", day:"numeric"}) + " 开始收集" : "从今天开始收集";
  const th = settings.get("theme", "system");
  document.querySelectorAll("#themeSeg button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.themeVal === th)));
}

/* ============================================================
   漫游
   ============================================================ */
let deckCur = null, lastWanderId = null;
function nextWander(){
  const p = pool();
  if (!p.length) return;
  let pick;
  do { pick = p[Math.floor(Math.random() * p.length)]; } while (p.length > 1 && pick.id === lastWanderId);
  lastWanderId = pick.id;
  deckCur = pick;
  const deck = $("#deck");
  const old = deck.querySelector(".card:not(.under)");
  const c = card(pick, () => openDetail(pick));
  c.classList.add("under");
  deck.append(c);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    c.classList.remove("under");
    if (old) {
      old.style.transform = `translateX(${(old._dir || -1) * 120}%) rotate(${(old._dir || -1) * 12}deg)`;
      old.style.opacity = "0";
      setTimeout(() => old.remove(), 380);
    }
  }));
  const days = Math.max(0, Math.round((Date.now() - pick.createdAt) / DAY));
  $("#wanderLede").textContent = pick.sample ? "这是一枚示例。收藏多了以后，这里会翻出你忘掉的东西。"
    : days === 0 ? "今天刚收进来的" : `${days} 天前的你，收下了这一枚`;
  enableSwipe(c);
  haptic();
}
function enableSwipe(el){
  let x0 = null, dx = 0;
  el.addEventListener("pointerdown", e => { x0 = e.clientX; dx = 0; el.style.transition = "none"; });
  el.addEventListener("pointermove", e => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    if (Math.abs(dx) > 6) el.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
  });
  const end = () => {
    if (x0 == null) return;
    el.style.transition = "";
    if (Math.abs(dx) > 90) { el._dir = dx > 0 ? 1 : -1; nextWander(); }
    else el.style.transform = "";
    x0 = null;
  };
  el.addEventListener("pointerup", e => { if (Math.abs(dx) > 6) { e.preventDefault(); el.addEventListener("click", ev => ev.stopPropagation(), {capture: true, once: true}); } end(); });
  el.addEventListener("pointercancel", end);
}
$("#wanderNext").onclick = nextWander;
$("#wanderOpen").onclick = () => deckCur && openDetail(deckCur);

/* ============================================================
   详情页
   ============================================================ */
let detailItem = null;
function openDetail(it, fromHistory){
  detailItem = it;
  const k = kindOf(it.type);
  $("#detailNo").textContent = "No." + pad(numberOf(it.id));
  const body = $("#detailBody");
  const actions = [];
  if (it.type === "link") actions.push(h("a", {class:"pill wide", href: it.url, target:"_blank", rel:"noopener"}, "打开链接 ↗"));
  if (!it.sample && it.type !== "color") actions.push(h("button", {class:"pill", type:"button", onclick: () => showCompose(it.type, it)}, "编辑"));
  const copyText = it.type === "color" ? (it.colors || []).join(" ")
    : it.type === "link" ? it.url : it.type === "image" ? it.caption : [it.text, it.source && "— " + it.source].filter(Boolean).join("\n");
  if (copyText) actions.push(h("button", {class:"pill ghost", type:"button", onclick: () => copy(copyText, "已复制")}, it.type === "image" ? "复制说明" : "复制"));
  if (!it.sample) actions.push(h("button", {class:"pill danger", type:"button", onclick: () => confirmDelete(it)}, "删除"));
  body.replaceChildren(...[
    h("p", {class:"d-eyebrow mono"}, k.en + " · " + k.zh + (it.sample ? " · 示例" : "")),
    h("div", {class:"d-card"}, ...cardBody(it, true)),
    it.type === "color" ? h("p", {class:"d-hint"}, "点色块即可复制色值") : null,
    it.tags?.length ? h("div", {class:"d-tags"}, it.tags.map(t => h("button", {type:"button", onclick: () => { closeDetail(); view.tag = t; view.kind = "all"; go("wall"); renderWall(); }}, "#" + t))) : null,
    h("p", {class:"d-time"}, "收于 " + fmtFull(it.createdAt) + (it.updatedAt ? " · 改于 " + fmtFull(it.updatedAt) : "")),
    h("div", {class:"d-actions"}, actions)].filter(Boolean));
  body.scrollTop = 0;
  $("#detail").hidden = false;
  if (!fromHistory) history.pushState({detail: it.id}, "");
  $("#detailBack").focus({preventScroll: true});
}
function closeDetail(){
  $("#detail").hidden = true;
  if (history.state?.detail) history.back();
}
$("#detailBack").onclick = closeDetail;
window.addEventListener("popstate", () => {
  if (!$("#cropper").hidden) $("#cropCancel").click();
  if (!$("#composeScrim").hidden && !history.state?.compose) { hideCompose(); return; }
  if (!$("#detail").hidden && !history.state?.detail) $("#detail").hidden = true;
});
$("#detailShare").onclick = async () => {
  const it = detailItem; if (!it) return;
  const text = it.type === "quote" ? `“${it.text}”${it.source ? " — " + it.source : ""}`
    : it.type === "note" ? it.text
    : it.type === "link" ? [it.note, it.url].filter(Boolean).join("\n")
    : it.type === "image" ? it.caption || "来自拾遗的一张图"
    : [it.name, (it.colors || []).join(" ")].filter(Boolean).join("\n");
  const data = {title: "拾遗", text};
  try {
    if (it.type === "image" && it.blob && navigator.canShare?.({files: [new File([it.blob], "shiyi.jpg", {type: "image/jpeg"})]}))
      data.files = [new File([it.blob], "shiyi.jpg", {type: "image/jpeg"})];
    if (navigator.share) await navigator.share(data);
    else copy(text, "已复制，可以粘贴分享");
  } catch (e) { if (e?.name !== "AbortError") copy(text, "已复制，可以粘贴分享"); }
};

/* 删除确认（动作面板） */
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
  askConfirm("删除这枚收藏？删除后无法恢复。", "删除", async () => {
    try {
      await DB.del(it.id);
      if (urlCache.has(it.id)) { URL.revokeObjectURL(urlCache.get(it.id)); urlCache.delete(it.id); }
      closeDetail();
      if (deckCur?.id === it.id) deckCur = null;
      await reload();
      toast("已删除");
    } catch { toast("没能删除，请再试一次"); }
  });
}

/* ============================================================
   新建 / 编辑（底部抽屉）
   ============================================================ */
let draftKind = "note", draftImage = null, editing = null;
// draftImage: {blob: 裁剪后的图, orig: 原图, crop: 上次的裁剪参数}
function showCompose(kind, item){
  editing = item || null;
  if (kind) draftKind = kind;
  draftImage = item?.type === "image" && item.blob ? {blob: item.blob, orig: item.orig || item.blob, crop: item.crop || null} : null;
  $("#composeTitle").textContent = editing ? "编辑灵感" : "收藏新灵感";
  $("#composeSave").textContent = editing ? "保存" : "收进来";
  $("#kindPicker").hidden = !!editing;
  renderPicker(); renderFields();
  if (editing) fillFields(editing);
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
  $("#kindPicker").replaceChildren(...CREATE_KINDS.map(k => h("button", {type:"button", role:"tab", "aria-selected": String(k.k === draftKind),
    onclick: () => { draftKind = k.k; renderPicker(); renderFields(); }}, k.zh, h("span", {class:"mono"}, k.en.toUpperCase()))));
}
function field(id, attrs){ const el = h(attrs.rows ? "textarea" : "input", {id, ...attrs}); if (attrs.rows) el.rows = attrs.rows; return el; }
function fillFields(it){
  const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  set("f-text", it.text); set("f-source", it.source); set("f-url", it.url); set("f-note", it.note);
  set("f-caption", it.caption); set("f-tags", (it.tags || []).join(" "));
}
const draftUrl = (() => { let u = null, b = null; return blob => { if (blob !== b) { if (u) URL.revokeObjectURL(u); b = blob; u = URL.createObjectURL(blob); } return u; }; })();

function renderFields(focus = true){
  const f = $("#fields");
  const tags = field("f-tags", {placeholder:"标签，用空格分开：海报 字体 交互", enterkeyhint:"done"});
  let rows = [];
  if (draftKind === "note") rows = [field("f-text", {rows:4, class:"big", placeholder:"刚刚想到的……"})];
  if (draftKind === "quote") rows = [field("f-text", {rows:3, class:"big serif", placeholder:"摘下那句打动你的话"}), field("f-source", {placeholder:"出处：作者《书名》"})];
  if (draftKind === "link") rows = [field("f-url", {type:"url", inputmode:"url", placeholder:"https://", autocapitalize:"off"}), field("f-note", {rows:2, placeholder:"为什么收藏它？"})];
  if (draftKind === "image") {
    const file = h("input", {type:"file", accept:"image/*", id:"f-file", hidden:true});
    const box = h("div", {class:"img-box", id:"f-drop"});
    const paint = () => box.replaceChildren(...(draftImage
      ? [h("img", {class:"img-prev", src: draftUrl(draftImage.blob), alt:"待收藏的图片"}),
         h("div", {class:"img-tools"},
           h("button", {type:"button", class:"tool", onclick: async () => {
             const r = await openCropper(draftImage.orig, draftImage.crop);
             if (r) { draftImage = {...draftImage, blob: r.blob, crop: r.crop}; paint(); }
           }}, cropIcon(), "裁剪 / 旋转"),
           h("button", {type:"button", class:"tool", onclick: () => file.click()}, swapIcon(), "换一张"))]
      : [h("button", {type:"button", class:"drop", onclick: () => file.click()}, svgIcon(), h("strong", {}, "从相册选择或拍照"), h("span", {}, "选好后可以裁剪、旋转"))]));
    paint();
    const take = async fl => {
      if (!fl || !/^image\//.test(fl.type)) return toast("请选择图片文件");
      box.replaceChildren(h("div", {class:"drop"}, h("span", {}, "正在处理…")));
      try { const blob = await prepImage(fl); draftImage = {blob, orig: blob, crop: null}; }
      catch { toast("这张图片打不开，换一张试试"); }
      paint();
    };
    file.onchange = () => { take(file.files[0]); file.value = ""; };
    f._take = take;
    rows = [file, box, field("f-caption", {rows:2, placeholder:"写一句：它为什么打动你"})];
  }
  f.replaceChildren(...rows, tags);
  if (focus && draftKind !== "image" && !editing) setTimeout(() => f.querySelector("textarea,input:not([type=file])")?.focus(), 50);
}
function svgEl(paths){
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = paths; return s;
}
const svgIcon = () => svgEl('<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>');
const cropIcon = () => svgEl('<path d="M6 2v16h16"/><path d="M2 6h16v16"/>');
const swapIcon = () => svgEl('<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>');
const val = id => (document.getElementById(id)?.value || "").trim();

async function save(){
  const fields = {tags: parseTags(val("f-tags"))};
  if (draftKind === "note") { if (!val("f-text")) return toast("先写点什么"); fields.text = val("f-text"); }
  if (draftKind === "quote") { if (!val("f-text")) return toast("引语不能为空"); Object.assign(fields, {text: val("f-text"), source: val("f-source")}); }
  if (draftKind === "link") { const u = normUrl(val("f-url")); if (!/\./.test(u)) return toast("请填一个有效的网址"); Object.assign(fields, {url: u, note: val("f-note")}); }
  if (draftKind === "image") {
    if (!draftImage) return toast("先选一张图片");
    Object.assign(fields, {blob: draftImage.blob, caption: val("f-caption"), crop: draftImage.crop || undefined,
      // 原图只在裁剪过时单独保存，避免重复占用空间
      orig: draftImage.orig !== draftImage.blob ? draftImage.orig : undefined});
  }
  const item = editing
    ? {...editing, ...fields, updatedAt: Date.now()}
    : {id: uid(), type: draftKind, createdAt: Date.now(), ...fields};
  delete item.colors;
  if (item.type !== "color") delete item.name;
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  try { await DB.put(item); }
  catch (e) { return toast(e?.name === "QuotaExceededError" ? "设备存储空间不足" : "没能保存，请再试一次"); }
  if (urlCache.has(item.id)) { URL.revokeObjectURL(urlCache.get(item.id)); urlCache.delete(item.id); }
  const wasEditing = !!editing;
  draftImage = null; editing = null;
  closeCompose();
  if (wasEditing) {
    await reload();
    const fresh = items.find(x => x.id === item.id);
    if (fresh && !$("#detail").hidden) openDetail(fresh, true);
    if (deckCur?.id === item.id) deckCur = null;
    toast("已保存");
  } else {
    view.kind = "all"; view.tag = null;
    await reload();
    if (currentTab !== "wall") go("wall");
    $("#wallScroll").scrollTo({top: 0, behavior: "smooth"});
    toast("收好了");
  }
  haptic();
}
$("#compose").addEventListener("submit", e => { e.preventDefault(); save(); });
$("#compose").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });

/* ============================================================
   裁剪 / 旋转
   crop 参数保存在条目里：{rot, x, y, w, h, ratio}，x/y/w/h 是相对旋转后图片的比例
   ============================================================ */
const RATIOS = [{k:"free", t:"自由"}, {k:"orig", t:"原图"}, {k:"1", t:"1:1"}, {k:"0.8", t:"4:5"}, {k:"0.75", t:"3:4"}, {k:"1.7778", t:"16:9"}];
function openCropper(origBlob, prev){
  return new Promise(async resolve => {
    const scrim = $("#cropper"), stage = $("#cropStage"), box = $("#cropBox");
    let src;
    try { src = await loadImg(URL.createObjectURL(origBlob)); } catch { toast("图片打不开"); return resolve(null); }
    let rot = prev?.rot || 0, ratioKey = prev?.ratio || "free";
    let rotated, dw = 0, dh = 0, ox = 0, oy = 0;      // 显示尺寸与偏移
    let r = null;                                       // 裁剪框（显示像素）

    const ratioVal = () => ratioKey === "free" ? null : ratioKey === "orig" ? rotated.width / rotated.height : +ratioKey;
    function makeRotated(){
      const c = document.createElement("canvas"), sw = src.naturalWidth, sh = src.naturalHeight;
      const turn = rot % 180 !== 0;
      c.width = turn ? sh : sw; c.height = turn ? sw : sh;
      const x = c.getContext("2d");
      x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.drawImage(src, -sw / 2, -sh / 2);
      return c;
    }
    function layout(keep){
      const pad = 24, W = stage.clientWidth - pad * 2, H = stage.clientHeight - pad * 2;
      const s = Math.min(W / rotated.width, H / rotated.height);
      const odw = dw, odh = dh;
      dw = rotated.width * s; dh = rotated.height * s;
      ox = (stage.clientWidth - dw) / 2; oy = (stage.clientHeight - dh) / 2;
      const view = $("#cropImg");
      view.width = rotated.width; view.height = rotated.height;
      view.getContext("2d").drawImage(rotated, 0, 0);
      Object.assign(view.style, {left: ox + "px", top: oy + "px", width: dw + "px", height: dh + "px"});
      if (keep && r && odw) r = {x: r.x / odw * dw, y: r.y / odh * dh, w: r.w / odw * dw, h: r.h / odh * dh};
    }
    function fitRatio(){
      const q = ratioVal();
      if (!q) { r = {x: 0, y: 0, w: dw, h: dh}; return; }
      let w = dw, hh = w / q;
      if (hh > dh) { hh = dh; w = hh * q; }
      r = {x: (dw - w) / 2, y: (dh - hh) / 2, w, h: hh};
    }
    function paintBox(){
      Object.assign(box.style, {left: ox + r.x + "px", top: oy + r.y + "px", width: r.w + "px", height: r.h + "px"});
      $("#cropRatios").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.r === ratioKey)));
    }
    function setup(){
      rotated = makeRotated(); layout(false);
      if (prev && prev.rot === rot && r === null) r = {x: prev.x * dw, y: prev.y * dh, w: prev.w * dw, h: prev.h * dh};
      else fitRatio();
      paintBox();
    }

    $("#cropRatios").replaceChildren(...RATIOS.map(o => h("button", {type:"button", class:"chip", "data-r": o.k, onclick: () => { ratioKey = o.k; fitRatio(); paintBox(); }}, o.t)));

    // 拖动与缩放
    let drag = null;
    const MIN = 40;
    box.onpointerdown = e => {
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      drag = {mode: e.target.dataset.h || "move", x: e.clientX, y: e.clientY, r: {...r}};
    };
    box.onpointermove = e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, o = drag.r, q = ratioVal();
      if (drag.mode === "move") {
        r.x = Math.min(Math.max(0, o.x + dx), dw - o.w);
        r.y = Math.min(Math.max(0, o.y + dy), dh - o.h);
      } else {
        const m = drag.mode; // nw ne sw se
        const ax = m.includes("w") ? o.x + o.w : o.x, ay = m.includes("n") ? o.y + o.h : o.y; // 固定的对角
        let px = (m.includes("w") ? o.x : o.x + o.w) + dx, py = (m.includes("n") ? o.y : o.y + o.h) + dy;
        px = Math.min(Math.max(0, px), dw); py = Math.min(Math.max(0, py), dh);
        let w = Math.max(MIN, Math.abs(px - ax)), hh = Math.max(MIN, Math.abs(py - ay));
        if (q) {
          if (w / hh > q) w = hh * q; else hh = w / q;
          const maxW = m.includes("w") ? ax : dw - ax, maxH = m.includes("n") ? ay : dh - ay;
          if (w > maxW) { w = maxW; hh = w / q; }
          if (hh > maxH) { hh = maxH; w = hh * q; }
        } else {
          w = Math.min(w, m.includes("w") ? ax : dw - ax); hh = Math.min(hh, m.includes("n") ? ay : dh - ay);
        }
        r = {x: m.includes("w") ? ax - w : ax, y: m.includes("n") ? ay - hh : ay, w, h: hh};
      }
      paintBox();
    };
    box.onpointerup = box.onpointercancel = () => { drag = null; };

    const onResize = () => { layout(true); paintBox(); };
    const finish = async ok => {
      window.removeEventListener("resize", onResize);
      scrim.hidden = true;
      URL.revokeObjectURL(src.src);
      if (!ok) return resolve(null);
      const crop = {rot, x: r.x / dw, y: r.y / dh, w: r.w / dw, h: r.h / dh, ratio: ratioKey};
      const sx = crop.x * rotated.width, sy = crop.y * rotated.height, sw = crop.w * rotated.width, sh = crop.h * rotated.height;
      const s = Math.min(1, 1800 / Math.max(sw, sh));
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(sw * s)); out.height = Math.max(1, Math.round(sh * s));
      out.getContext("2d").drawImage(rotated, sx, sy, sw, sh, 0, 0, out.width, out.height);
      resolve({blob: await toBlob(out), crop});
    };
    $("#cropCancel").onclick = () => finish(false);
    $("#cropDone").onclick = () => finish(true);
    $("#cropRotate").onclick = () => { rot = (rot + 90) % 360; r = null; prev = null; setup(); haptic(); };
    $("#cropReset").onclick = () => { rot = 0; ratioKey = "free"; prev = null; r = null; setup(); };

    scrim.hidden = false;
    window.addEventListener("resize", onResize);
    requestAnimationFrame(setup);
  });
}

/* 在任意位置粘贴：图片 / 链接 / 文字 */
document.addEventListener("paste", e => {
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) { e.preventDefault(); if ($("#composeScrim").hidden) showCompose("image"); else { draftKind = "image"; renderPicker(); renderFields(false); } $("#fields")._take(file); return; }
  if (inField) return;
  const text = e.clipboardData?.getData("text")?.trim(); if (!text) return;
  e.preventDefault();
  if (/^https?:\/\/\S+$/i.test(text)) { showCompose("link"); $("#f-url").value = text; }
  else { showCompose("note"); $("#f-text").value = text; }
});

/* 系统分享进来（安装后可从其他 App 分享到拾遗）*/
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
   我的：主题 / 备份 / 安装
   ============================================================ */
function applyTheme(){
  const t = settings.get("theme", "system");
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", dark ? "#0F1312" : "#E9ECEA"));
}
document.querySelectorAll("#themeSeg button").forEach(b => b.onclick = () => { settings.set("theme", b.dataset.themeVal); applyTheme(); renderMe(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

$("#exportBtn").onclick = async () => {
  if (!items.length) return toast("还没有可导出的收藏");
  toast("正在打包…");
  const out = [];
  for (const it of items) {
    const { blob, orig, ...rest } = it;
    if (blob) rest.image = await blobToDataUrl(blob);
    if (orig) rest.origImage = await blobToDataUrl(orig);
    out.push(rest);
  }
  const file = new Blob([JSON.stringify({app: "shiyi", version: 1, exportedAt: Date.now(), items: out})], {type: "application/json"});
  const name = `拾遗备份-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const f = new File([file], name, {type: "application/json"});
    if (navigator.canShare?.({files: [f]})) { await navigator.share({files: [f], title: name}); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  const a = h("a", {href: URL.createObjectURL(file), download: name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("备份已导出");
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
      const { image, origImage, ...rest } = it;
      if (image) rest.blob = await dataUrlToBlob(image);
      if (origImage) rest.orig = await dataUrlToBlob(origImage);
      list.push(rest);
    }
    await DB.putMany(list);
    await reload();
    toast(`已恢复 ${list.length} 枚收藏`);
  } catch { toast("这个文件不是拾遗的备份"); }
};
$("#clearBtn").onclick = () => {
  if (!items.length) return toast("已经是空的了");
  askConfirm(`清空全部 ${items.length} 枚收藏？建议先导出备份。`, "全部清空", async () => {
    await DB.clear(); urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear(); deckCur = null;
    await reload(); toast("已清空");
  });
};

let installEvt = null;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });
if (standalone) { $("#installBtn").closest("li").hidden = true; $("#installBtn").closest("ul").previousElementSibling.hidden = true; }
$("#installBtn").onclick = async () => {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome === "accepted") toast("已添加到主屏幕"); return; }
  $("#installHint").textContent = isIOS ? "在 Safari 点底部「分享」→「添加到主屏幕」" : "在浏览器菜单里选「安装应用」或「添加到主屏幕」";
};

/* ============================================================
   启动
   ============================================================ */
function renderAll(){ renderWall(); renderMe(); }
SAMPLES.find(s => s.id === "s3").src = sampleImage();
applyTheme();
renderAll();
reload();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
})();
