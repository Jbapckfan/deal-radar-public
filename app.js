/* Deal Radar frontend — fetch the published deals.json and render it.
   The frontend makes NO stock/discount decisions; it renders what the NAS
   crawler already decided. It only handles display: filtering, sorting,
   freshness, and the (read-only) notification status. */

const CFG = window.DEAL_RADAR_CONFIG || {};
const SIZE_LABELS = { medium: "Medium", "34x32": "34×32", short_34: "34 Shorts", shoe_12: "Size 12", one_size: "One size" };
const TRIAL_BRANDS = new Set(["Myles Apparel", "Straight Down", "Cuts", "Linksoul", "True Classic"]);
const TRIAL_PREF = "dealRadar.includeTrialBrands";
const DISABLED_BRANDS_PREF = "dealRadar.disabledBrands";
const ENABLED_TRIAL_BRANDS_PREF = "dealRadar.enabledTrialBrands";

const state = {
  data: null,
  brands: new Set(),
  size: "all",
  sort: "score",
  includeTrialBrands: localStorage.getItem(TRIAL_PREF) === "1",
  disabledBrands: loadSet(DISABLED_BRANDS_PREF),
  enabledTrialBrands: loadSet(ENABLED_TRIAL_BRANDS_PREF),
};

const $ = (sel) => document.querySelector(sel);

init();

async function init() {
  setupNotify();
  try {
    const res = await fetch(CFG.DEALS_URL || "./deals.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $("#freshness").textContent = "could not load deals";
    $("#freshness").classList.add("stale");
    return;
  }
  renderFreshness();
  renderSources();
  buildChips();
  setupTrialBrands();
  setupBrandManager();
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  $("#controls").hidden = false;
  renderGrid();
}

/* ---------- freshness / staleness ---------- */
function renderFreshness() {
  const { generated_at, stale_after_minutes, deals } = state.data;
  const gen = new Date(generated_at);
  const ageMin = (Date.now() - gen.getTime()) / 60000;
  const el = $("#freshness");
  el.textContent = `checked ${formatAge(ageMin)}`;
  if (ageMin > (stale_after_minutes ?? 360)) {
    el.classList.add("stale");
    el.textContent = `data stale — last checked ${formatAge(ageMin)}`;
  }
  $("#count").textContent = `${deals.length} ${deals.length === 1 ? "deal" : "deals"}`;
  $("#generated").textContent = `Scanned ${gen.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function formatAge(min) {
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)} min ago`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

/* ---------- sources panel ---------- */
const REASON_LABELS = {
  no_compare_price: "no sale prices in feed — tracking baseline",
  zero_discounts: "on sale, but under 30% off",
  zero_matching_sizes: "nothing in your sizes",
  empty_feed: "feed returned nothing",
};

function renderSources() {
  const ul = $("#sources");
  ul.innerHTML = "";
  for (const s of (state.data.sources || []).filter((src) => isBrandVisibleName(src.brand))) {
    const li = document.createElement("li");
    li.className = "source" + (s.status === "blocked" ? " is-blocked" : "");
    // A healthy fetch that found 0 deals gets a neutral dot (not the green "api" dot)
    // plus the reason, so it reads differently from a brand actually delivering deals.
    const zeroHealthy = s.status !== "blocked" && s.deal_count === 0;
    const dotClass = zeroHealthy ? "idle" : s.status;
    const reason = s.deal_count === 0 && s.reason ? REASON_LABELS[s.reason] || s.reason : "";
    li.innerHTML =
      `<span class="sdot ${dotClass}"></span>` +
      `<span class="sname">${escapeHtml(s.brand)}` +
        (reason ? `<span class="sreason">${escapeHtml(reason)}</span>` : "") +
      `</span>` +
      `<span class="scount">${s.status === "blocked" ? "blocked" : s.deal_count}</span>`;
    ul.appendChild(li);
  }
}

/* ---------- filter chips ---------- */
function buildChips() {
  const deals = configuredDeals();
  const brandCounts = countBy(deals, (d) => d.brand);
  const defaultDeals = deals.filter(isDefaultVisible);
  const sizeCounts = countBy(defaultDeals, (d) => d.size_bucket);

  // Brand: multi-select. Show every configured brand (from sources), so
  // zero-deal brands still appear. "All" clears the selection.
  const sourceBrands = (state.data.sources || []).map((s) => s.brand);
  const brandNames = [...new Set(sourceBrands)]
    .filter((b) => isBrandVisibleName(b) || state.brands.has(b))
    .sort((a, b) => (brandCounts[b] || 0) - (brandCounts[a] || 0) || a.localeCompare(b));
  buildBrandChips($("#brand-chips"),
    [["all", "All", defaultDeals.length, false],
      ...brandNames.map((b) => [b, b, brandCounts[b] || 0, TRIAL_BRANDS.has(b)])]);

  // Size: single-select (only four buckets).
  buildSizeChips($("#size-chips"),
    [["all", "All", defaultDeals.length], ...Object.entries(sizeCounts)
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, SIZE_LABELS[k] || k, n])]);
}

function buildBrandChips(container, entries) {
  container.innerHTML = "";
  for (const [value, label, n, isTrial] of entries) {
    const btn = document.createElement("button");
    btn.className = "chip" + (isTrial ? " is-trial" : "");
    btn.dataset.value = value;
    const pressed = value === "all" ? state.brands.size === 0 : state.brands.has(value);
    btn.setAttribute("aria-pressed", String(pressed));
    btn.innerHTML = `${escapeHtml(label)}<span class="n">${n}</span>`;
    btn.addEventListener("click", () => {
      if (value === "all") state.brands.clear();
      else state.brands.has(value) ? state.brands.delete(value) : state.brands.add(value);
      refreshBrandPressed(container);
      renderGrid();
    });
    container.appendChild(btn);
  }
}

function refreshBrandPressed(container) {
  [...container.children].forEach((c) => {
    const value = c.dataset.value;
    const pressed = value === "all" ? state.brands.size === 0 : state.brands.has(value);
    c.setAttribute("aria-pressed", String(pressed));
  });
}

function buildSizeChips(container, entries) {
  container.innerHTML = "";
  for (const [value, label, n] of entries) {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.setAttribute("aria-pressed", String(state.size === value));
    btn.innerHTML = `${escapeHtml(label)}<span class="n">${n}</span>`;
    btn.addEventListener("click", () => {
      state.size = value;
      [...container.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      renderGrid();
    });
    container.appendChild(btn);
  }
}

/* ---------- grid ---------- */
function renderGrid() {
  const grid = $("#grid");
  let deals = configuredDeals().filter((d) =>
    isBrandVisibleName(d.brand) &&
    (state.brands.size > 0 ? state.brands.has(d.brand) : true) &&
    (state.size === "all" || d.size_bucket === state.size));

  deals = sortDeals(deals, state.sort);
  $("#count").textContent = `${deals.length} ${deals.length === 1 ? "deal" : "deals"}`;

  grid.innerHTML = "";
  $("#empty").hidden = deals.length > 0;
  if (!deals.length) {
    $("#empty-sub").textContent = anyActiveFilter()
      ? "Nothing matches these filters right now."
      : "The last scan found nothing 30%+ off in your sizes.";
    return;
  }

  const frag = document.createDocumentFragment();
  deals.forEach((d, i) => frag.appendChild(card(d, i)));
  grid.appendChild(frag);
}

function sortDeals(deals, mode) {
  const by = {
    score: (a, b) => (b.score || 0) - (a.score || 0) || b.discount_percent - a.discount_percent,
    discount: (a, b) => b.discount_percent - a.discount_percent || a.sale_price - b.sale_price,
    "price-asc": (a, b) => a.sale_price - b.sale_price,
    "price-desc": (a, b) => b.sale_price - a.sale_price,
    brand: (a, b) => a.brand.localeCompare(b.brand) || b.discount_percent - a.discount_percent,
  };
  return [...deals].sort(by[mode] || by.score);
}

function card(d, i) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = d.url; a.target = "_blank"; a.rel = "noopener";
  a.style.animationDelay = `${Math.min(i * 28, 600)}ms`;
  const hot = d.discount_percent >= 50 ? " hot" : "";
  const img = d.image
    ? `<img src="${escapeAttr(d.image)}" alt="${escapeAttr(d.title)}" loading="lazy" />`
    : `<div style="width:100%;height:100%"></div>`;
  a.innerHTML =
    `<div class="card-media">
       ${img}
       <span class="badge${hot}">-${d.discount_percent}%</span>
       <span class="size-pill">${escapeHtml(SIZE_LABELS[d.size_bucket] || d.size_label)}</span>
     </div>
     <div class="card-body">
       <span class="card-brand">${escapeHtml(d.brand)}</span>
       <span class="card-title">${escapeHtml(d.title)}</span>
       <div class="price-row">
         <span class="price-now">$${fmt(d.sale_price)}</span>
         <span class="price-was">$${fmt(d.list_price)}</span>
         <span class="confidence">${escapeHtml(d.confidence)}</span>
       </div>
     </div>`;
  return a;
}

/* ---------- notifications (read-only status) ---------- */
function setupNotify() {
  const topic = CFG.NTFY_TOPIC || "james-deals";
  const base = CFG.NTFY_BASE || "https://ntfy.sh";
  $("#notify-state").innerHTML = `Topic <b>${escapeHtml(topic)}</b>`;
  $("#notify-link").href = `${base}/${encodeURIComponent(topic)}`;
}

function setupTrialBrands() {
  const toggle = $("#trial-toggle");
  if (!toggle) return;
  toggle.checked = state.includeTrialBrands;
  toggle.addEventListener("change", () => {
    state.includeTrialBrands = toggle.checked;
    localStorage.setItem(TRIAL_PREF, state.includeTrialBrands ? "1" : "0");
    refreshBrandSettings();
  });
}

function setupBrandManager() {
  renderBrandManager();
  $("#enable-all-brands")?.addEventListener("click", () => {
    state.disabledBrands.clear();
    state.includeTrialBrands = true;
    localStorage.setItem(TRIAL_PREF, "1");
    saveSet(DISABLED_BRANDS_PREF, state.disabledBrands);
    refreshBrandSettings();
  });
  $("#main-brands")?.addEventListener("click", () => {
    state.disabledBrands.clear();
    state.enabledTrialBrands.clear();
    state.includeTrialBrands = false;
    state.brands.clear();
    localStorage.setItem(TRIAL_PREF, "0");
    saveSet(DISABLED_BRANDS_PREF, state.disabledBrands);
    saveSet(ENABLED_TRIAL_BRANDS_PREF, state.enabledTrialBrands);
    refreshBrandSettings();
  });
}

function renderBrandManager() {
  const root = $("#brand-manager");
  if (!root || !state.data) return;
  const deals = configuredDeals();
  const counts = countBy(deals, (d) => d.brand);
  const brands = [...configuredBrandNames()]
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  root.innerHTML = "";
  for (const brand of brands) {
    const row = document.createElement("div");
    row.className = "brand-toggle-row";
    const visible = isBrandVisibleName(brand);
    row.innerHTML =
      `<label class="brand-toggle-main">
         <input type="checkbox" ${visible ? "checked" : ""} />
         <span>
           <span class="brand-toggle-name">${escapeHtml(brand)}</span>
           ${TRIAL_BRANDS.has(brand) ? `<span class="brand-toggle-tag">trial</span>` : ""}
           <span class="brand-toggle-meta">${counts[brand] || 0} deals</span>
         </span>
       </label>
       <button type="button" class="brand-toggle-remove" ${visible ? "" : "disabled"}>Remove</button>`;
    row.querySelector("input").addEventListener("change", (e) => {
      setBrandVisible(brand, e.target.checked);
    });
    row.querySelector("button").addEventListener("click", () => setBrandVisible(brand, false));
    root.appendChild(row);
  }
}

function setBrandVisible(brand, visible) {
  if (visible) {
    state.disabledBrands.delete(brand);
    if (TRIAL_BRANDS.has(brand)) state.enabledTrialBrands.add(brand);
  } else {
    state.disabledBrands.add(brand);
    state.enabledTrialBrands.delete(brand);
    state.brands.delete(brand);
  }
  saveSet(DISABLED_BRANDS_PREF, state.disabledBrands);
  saveSet(ENABLED_TRIAL_BRANDS_PREF, state.enabledTrialBrands);
  refreshBrandSettings();
}

function refreshBrandSettings() {
  for (const brand of [...state.brands]) {
    if (!isBrandVisibleName(brand)) state.brands.delete(brand);
  }
  const toggle = $("#trial-toggle");
  if (toggle) toggle.checked = state.includeTrialBrands;
  buildChips();
  renderSources();
  renderBrandManager();
  renderGrid();
}

/* ---------- helpers ---------- */
function isDefaultVisible(deal) {
  return isBrandVisibleName(deal.brand);
}
function isBrandVisibleName(brand) {
  if (!configuredBrandNames().has(brand)) return false;
  if (state.disabledBrands.has(brand)) return false;
  if (TRIAL_BRANDS.has(brand)) {
    return state.includeTrialBrands || state.enabledTrialBrands.has(brand);
  }
  return true;
}
function configuredBrandNames() {
  return new Set((state.data?.sources || []).map((s) => s.brand));
}
function configuredDeals() {
  const configured = configuredBrandNames();
  return (state.data?.deals || []).filter((d) =>
    d.in_stock === true && (configured.size === 0 || configured.has(d.brand)));
}
function loadSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}
function saveSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set].sort()));
}
function countBy(arr, fn) {
  return arr.reduce((acc, x) => { const k = fn(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}
function anyActiveFilter() {
  return state.brands.size > 0 || state.size !== "all" || state.disabledBrands.size > 0;
}
function fmt(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
