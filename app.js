/* Deal Radar frontend — fetch the published deals.json and render it.
   The frontend makes NO stock/discount decisions; it renders what the NAS
   crawler already decided. It only handles display: filtering, sorting,
   freshness, and the (read-only) notification status. */

const CFG = window.DEAL_RADAR_CONFIG || {};
const SIZE_LABELS = { medium: "Medium", "34x32": "34×32", short_34: "34 Shorts", shoe_12: "Size 12", one_size: "One size" };
const VERTICAL_LABELS = { apparel: "Clothes", gear: "Gear", electronics: "Tech", localllm: "Local LLM" };
const LOCALLLM_LABELS = { apple: "Apple", nvidia: "NVIDIA", amd: "AMD", pc: "PC" };
const GARMENT_LABELS = {
  tee: "Tees",
  polo: "Polos",
  shirt: "Shirts",
  long_sleeve: "Long sleeve",
  quarter_zip: "Quarter zips",
  hoodie: "Hoodies",
  sweatshirt: "Sweatshirts",
  sweater: "Sweaters",
  outerwear: "Outerwear",
  shorts: "Shorts",
  pants: "Pants",
  joggers: "Joggers",
  footwear: "Shoes",
  hat: "Hats",
  accessory: "Accessories",
  other: "Other",
};
const GEAR_LABELS = {
  knife: "Knives",
  light: "Lights",
  flashlight: "Flashlights",
  cooler: "Coolers",
  drinkware: "Drinkware",
  hat: "Hats",
  case: "Cases",
  camp: "Camp",
  bag: "Bags",
  accessory: "Accessories",
  tech: "Tech",
  other: "Other",
};
const TRIAL_BRANDS = new Set(["Myles Apparel", "Straight Down", "Cuts", "Linksoul", "True Classic"]);
const TRIAL_PREF = "dealRadar.includeTrialBrands";
const DISABLED_BRANDS_PREF = "dealRadar.disabledBrands";
const ENABLED_TRIAL_BRANDS_PREF = "dealRadar.enabledTrialBrands";
const HIDDEN_IDS_PREF = "dealRadar.hiddenIds";
const WATCHED_IDS_PREF = "dealRadar.watchedIds";
const SEEN_IDS_PREF = "dealRadar.seenIds";
const LAST_OPEN_AT_PREF = "dealRadar.lastOpenAt";
const WATCHED_ONLY_PREF = "dealRadar.watchedOnly";
const NEW_ONLY_PREF = "dealRadar.newOnly";
const BRANDS_EXPANDED_PREF = "dealRadar.brandsExpanded";

const state = {
  data: null,
  brands: new Set(),
  vertical: "all",
  garment: "all",
  gearType: "all",
  size: "all",
  sort: "score",
  watchedOnly: localStorage.getItem(WATCHED_ONLY_PREF) === "1",
  newOnly: localStorage.getItem(NEW_ONLY_PREF) === "1",
  includeTrialBrands: localStorage.getItem(TRIAL_PREF) === "1",
  disabledBrands: loadSet(DISABLED_BRANDS_PREF),
  enabledTrialBrands: loadSet(ENABLED_TRIAL_BRANDS_PREF),
  hiddenIds: loadSet(HIDDEN_IDS_PREF),
  watchedIds: loadSet(WATCHED_IDS_PREF),
  seenIds: loadSet(SEEN_IDS_PREF),
  newIds: new Set(),
};

const $ = (sel) => document.querySelector(sel);

init();

async function init() {
  setupNotify();
  const brandFilter = $("#brand-filter");
  brandFilter.open = localStorage.getItem(BRANDS_EXPANDED_PREF) === "1";
  brandFilter.addEventListener("toggle", () => {
    localStorage.setItem(BRANDS_EXPANDED_PREF, brandFilter.open ? "1" : "0");
  });
  const feedURL = CFG.DEALS_URL || "./deals.json";
  const cacheKey = "dealRadar.lastGoodFeed:" + new URL(feedURL, location.href).href;
  let saved = false;
  try {
    const res = await fetch(feedURL, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!validFeed(data)) throw new Error("Invalid feed");
    state.data = data;
    try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) {}
    captureNewSinceLastOpen();
  } catch (err) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey));
      if (validFeed(cached)) { state.data = cached; saved = true; }
    } catch (_) {}
    if (!state.data) {
      $("#freshness").textContent = `could not load deals: ${err.message}`;
      $("#freshness").classList.add("stale");
      return;
    }
  }
  renderFreshness();
  if (saved) {
    $("#freshness").textContent = "saved deals — " + $("#freshness").textContent;
    $("#freshness").classList.add("stale");
  }
  renderSources();
  buildChips();
  setupTrialBrands();
  setupBrandManager();
  setupPersonalization();
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  $("#controls").hidden = false;
  renderGrid();
}

function validFeed(data) {
  return data && Array.isArray(data.deals) && Array.isArray(data.sources)
    && Number.isFinite(Date.parse(data.generated_at)) && data.stale_after_minutes > 0;
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
  const defaultDeals = deals.filter((d) => isDefaultVisible(d) && passesItemFilters(d));
  const taxonomyDeals = defaultDeals.filter(passesTaxonomyFilters);
  const apparelDeals = taxonomyDeals.filter((d) => verticalOf(d) === "apparel");
  const sizeCounts = countBy(apparelDeals, (d) => d.size_bucket);
  const verticalCounts = countBy(defaultDeals, verticalOf);
  const garmentBase = defaultDeals.filter((d) => verticalOf(d) === "apparel");
  const gearBase = defaultDeals.filter((d) =>
    ["gear", "electronics", "localllm"].includes(state.vertical)
      ? verticalOf(d) === state.vertical
      : verticalOf(d) !== "apparel");
  const garmentCounts = countBy(garmentBase, garmentOf);
  const gearCounts = countBy(gearBase, gearTypeOf);

  // Brand: multi-select. Source names are merchant health identities, while a
  // multi-brand retailer's deals use the product vendor (for example, source
  // "Gazelle Sports" -> deal brand "On"). Include both or retailer deals would
  // be silently hidden and impossible to select. "All" clears the selection.
  const brandNames = [...configuredBrandNames()]
    .filter((b) => isBrandVisibleName(b) || state.brands.has(b))
    .sort((a, b) => (brandCounts[b] || 0) - (brandCounts[a] || 0) || a.localeCompare(b));
  buildBrandChips($("#brand-chips"),
    [["all", "All", defaultDeals.length, false],
      ...brandNames.map((b) => [b, b, brandCounts[b] || 0, TRIAL_BRANDS.has(b)])]);

  buildFilterChips($("#vertical-chips"),
    [["all", "All", defaultDeals.length],
      ...Object.entries(verticalCounts)
        .sort(([a], [b]) => verticalOrder(a) - verticalOrder(b))
        .map(([k, n]) => [k, VERTICAL_LABELS[k] || titleCase(k), n]),
      ["macbook128", "MacBook Pro 16″ · 128 GB", (state.data.hardware_watches || []).length]],
    state.vertical,
    (value) => {
      state.vertical = value;
      state.garment = "all";
      state.gearType = "all";
      if (state.vertical !== "apparel") state.size = "all";
      if (value === "localllm") setSort("price-asc");
      else if (state.sort === "price-asc") setSort("score");
      buildChips();
      renderGrid();
    });

  const showGarments = state.vertical === "all" || state.vertical === "apparel";
  const watch = state.vertical === "macbook128";
  const showGearTypes = !watch && (state.vertical === "all" || state.vertical !== "apparel");
  $("#brand-chips").closest(".control-group").hidden = watch;
  $("#new-filter").closest(".control-group").hidden = watch;
  $("#sort").closest(".control-group").hidden = watch;
  $("#size-group").hidden = state.vertical !== "all" && state.vertical !== "apparel";
  $("#garment-group").hidden = !showGarments || Object.keys(garmentCounts).length === 0;
  $("#gear-group").hidden = !showGearTypes || Object.keys(gearCounts).length === 0;
  buildFilterChips($("#garment-chips"),
    [["all", "All", garmentBase.length],
      ...Object.entries(garmentCounts)
        .sort((a, b) => b[1] - a[1] || labelForGarment(a[0]).localeCompare(labelForGarment(b[0])))
        .map(([k, n]) => [k, labelForGarment(k), n])],
    state.garment,
    (value) => {
      state.garment = value;
      if (value !== "all") state.vertical = "apparel";
      buildChips();
      renderGrid();
    });
  buildFilterChips($("#gear-chips"),
    [["all", "All", gearBase.length],
      ...Object.entries(gearCounts)
        .sort((a, b) => b[1] - a[1] || labelForGear(a[0]).localeCompare(labelForGear(b[0])))
        .map(([k, n]) => [k, labelForGear(k), n])],
    state.gearType,
    (value) => {
      state.gearType = value;
      if (value !== "all" && state.vertical === "apparel") state.vertical = "all";
      buildChips();
      renderGrid();
    });

  // Size: single-select (only four buckets).
  buildSizeChips($("#size-chips"),
    [["all", "All", apparelDeals.length], ...Object.entries(sizeCounts)
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, SIZE_LABELS[k] || k, n])]);
  updateQuickFilterButtons();
}

function buildBrandChips(container, entries) {
  updateBrandSelection();
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
      updateBrandSelection();
      renderGrid();
    });
    container.appendChild(btn);
  }
}

function updateBrandSelection() {
  $("#brand-selection").textContent = state.brands.size
    ? [...state.brands].sort().join(", ") : "All brands";
}

function refreshBrandPressed(container) {
  [...container.children].forEach((c) => {
    const value = c.dataset.value;
    const pressed = value === "all" ? state.brands.size === 0 : state.brands.has(value);
    c.setAttribute("aria-pressed", String(pressed));
  });
}

function buildFilterChips(container, entries, selected, select) {
  container.innerHTML = "";
  for (const [value, label, n] of entries) {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.dataset.value = value;
    btn.setAttribute("aria-pressed", String(selected === value));
    btn.innerHTML = `${escapeHtml(label)}<span class="n">${n}</span>`;
    btn.addEventListener("click", () => select(value));
    container.appendChild(btn);
  }
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
function renderHardwareWatch() {
  const grid = $("#grid");
  grid.innerHTML = "";
  $("#empty").hidden = true;
  const items = [...(state.data.hardware_watches || [])].sort((a, b) => a.price - b.price);
  $("#count").textContent = `${items.length} MacBook listings`;
  const section = document.createElement("section");
  section.className = "deal-section";
  section.innerHTML = `<div class="section-head"><h2>MacBook Pro 16″ · 128 GB</h2><span>${items.length}</span></div>
    <p class="watch-note">Available refurbished listings, including prices without a confirmed discount.</p>`;
  if (!items.length) section.innerHTML += '<p class="watch-note">No matching listings in the latest scan.</p>';
  const cards = document.createElement("div");
  cards.className = "section-grid";
  for (const w of items) {
    const article = document.createElement("article");
    article.className = "card is-gear";
    const specs = ["16-inch", "128 GB RAM", w.storage_gb ? `${w.storage_gb >= 1024 ? w.storage_gb / 1024 + " TB" : w.storage_gb + " GB"} SSD` : null, w.display_finish].filter(Boolean).join(" · ");
    article.innerHTML = `<a class="card-main" href="${escapeAttr(safeHttp(w.url) || "")}" target="_blank" rel="noopener">
      <div class="card-media">${imageTag(w)}<span class="badge ram">128 GB</span></div>
      <div class="card-body"><span class="card-brand">${escapeHtml(w.source)}</span>
      <span class="card-title">${escapeHtml(w.title)}</span><span class="card-kind">${escapeHtml(specs)}</span>
      <div class="price-row"><span class="price-now">$${fmt(w.price)}</span></div>
      <span class="watch-note">${w.list_price ? "Comparison price: $" + fmt(w.list_price) : "Discount unknown — no comparison price supplied"}</span></div></a>`;
    cards.appendChild(article);
  }
  section.appendChild(cards);
  grid.appendChild(section);
}

function renderGrid() {
  if (state.vertical === "macbook128") { renderHardwareWatch(); return; }
  const grid = $("#grid");
  let deals = configuredDeals().filter((d) =>
    isBrandVisibleName(d.brand) &&
    passesItemFilters(d) &&
    passesTaxonomyFilters(d) &&
    (state.brands.size > 0 ? state.brands.has(d.brand) : true) &&
    passesSizeFilter(d));

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

  let offset = 0;
  for (const section of dealSections(deals)) {
    const wrap = document.createElement("section");
    wrap.className = "deal-section";
    wrap.innerHTML =
      `<div class="section-head">
         <h2>${escapeHtml(section.title)}</h2>
         <span>${section.deals.length}</span>
       </div>`;
    const sectionGrid = document.createElement("div");
    sectionGrid.className = "section-grid";
    section.deals.forEach((d, i) => sectionGrid.appendChild(card(d, offset + i)));
    offset += section.deals.length;
    wrap.appendChild(sectionGrid);
    grid.appendChild(wrap);
  }
}

function setSort(mode) {
  state.sort = mode;
  const sel = $("#sort");
  if (sel) sel.value = mode;
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

/* Thumbnail through a free image proxy/CDN (weserv): resizes, re-encodes, and
   caches at the edge so a merchant CDN that hotlink-blocks or 404s a dead
   product doesn't leave a broken card. onerror falls back to the origin URL,
   then to an empty tile. */
function imageTag(d) {
  if (!d.image) return `<div class="card-img-empty"></div>`;
  const origin = escapeAttr(d.image);
  const proxied = "https://images.weserv.nl/?url=" +
    encodeURIComponent(d.image.replace(/^https?:\/\//, "")) + "&w=600&output=webp&we";
  return `<img src="${proxied}" alt="${escapeAttr(d.title)}" loading="lazy"
            data-origin="${origin}"
            onerror="if(this.dataset.origin){this.src=this.dataset.origin;this.removeAttribute('data-origin');}else{this.replaceWith(Object.assign(document.createElement('div'),{className:'card-img-empty'}));}" />`;
}

/* The honest, decision-grade price line — observed history beats the merchant's
   gameable compare_at. Priority: at a real low > just dropped > usual price. */
function honestSignal(d) {
  if (d.is_at_low && (d.history_days || 0) >= 3)
    return { cls: "is-low", text: `Lowest in ${d.history_days}d` };
  if (d.price_drop_percent && d.previous_price)
    return { cls: "is-drop", text: `Dropped ${d.price_drop_percent}% since last check` };
  if (d.typical_price && d.typical_price > d.sale_price)
    return { cls: "is-typical", text: `usually $${fmt(d.typical_price)}` };
  return null;
}

const TRUST_REASON_LABELS = {
  structured_source: "structured merchant feed",
  listing_source: "merchant listing page",
  merchant_markdown: "merchant supplied original and sale prices",
  tracked_price_baseline: "discount confirmed by tracked history",
  exact_variant_price: "price belongs to this exact variant",
  product_level_price: "product-level advertised price",
  identity_gtin: "global product identifier",
  identity_mpn: "manufacturer model number",
  identity_source_sku: "retailer SKU",
  identity_vendor_style: "brand and style identity",
  price_history_14d: "14+ days of price history",
  price_history_3d: "3+ days of price history",
  stock_rechecked: "stock rechecked before publication",
};

function trustLine(d) {
  const level = d.trust_level || "caution";
  const label = { verified: "Verified", high: "High confidence", medium: "Medium confidence",
                  caution: "Use caution" }[level] || "Use caution";
  const reasons = (d.trust_reasons || []).map((r) => TRUST_REASON_LABELS[r]).filter(Boolean);
  const title = reasons.length ? reasons.join(" · ") : "Detailed evidence arrives with schema v4";
  const score = Number.isInteger(d.trust_score) ? ` ${d.trust_score}` : "";
  return `<span class="trust-line ${escapeAttr(level)}" title="${escapeAttr(title)}">` +
    `<span aria-hidden="true">${level === "verified" ? "✓" : "◇"}</span> ` +
    `${escapeHtml(label)}${score}</span>`;
}

function card(d, i) {
  const article = document.createElement("article");
  const watched = state.watchedIds.has(d.id);
  const isNew = state.newIds.has(d.id);
  article.className = "card" + (watched ? " is-watched" : "") + (isNew ? " is-new" : "") +
    (verticalOf(d) !== "apparel" ? " is-gear" : "");
  article.style.animationDelay = `${Math.min(i * 28, 600)}ms`;
  const hot = d.discount_percent >= 50 ? " hot" : "";
  const signal = honestSignal(d);
  const signalLine = signal
    ? `<span class="card-signal ${signal.cls}">${escapeHtml(signal.text)}</span>` : "";
  const isRig = verticalOf(d) === "localllm";
  const badge = isRig && d.discount_percent === 0
    ? `<span class="badge ram">${escapeHtml(d.ram_gb ? d.ram_gb + "GB" : "")}</span>`
    : `<span class="badge${hot}">-${d.discount_percent}%</span>`;
  const wasPrice = d.list_price > d.sale_price
    ? `<span class="price-was">$${fmt(d.list_price)}</span>` : "";
  // Prefer the affiliate link so this (highest-traffic) surface earns attribution;
  // fall back to the clean merchant URL, and only ever emit an http(s) href.
  const affHref = safeHttp(d.affiliate_url);
  const outHref = affHref || safeHttp(d.url);
  const cardMain = outHref
    ? `<a class="card-main" href="${escapeAttr(outHref)}" target="_blank" rel="${affHref ? "noopener sponsored nofollow" : "noopener"}">`
    : `<a class="card-main">`;
  article.innerHTML =
    `${cardMain}
       <div class="card-media">
         ${imageTag(d)}
         ${badge}
         <span class="size-pill">${escapeHtml(cardTypeLabel(d))}</span>
         <span class="item-markers">
           ${d.restocked ? `<span class="marker restock">Restocked</span>` : ""}
           ${d.price_drop_percent ? `<span class="marker drop">↓ ${d.price_drop_percent}%</span>` : ""}
           ${isNew ? `<span class="marker new">New</span>` : ""}
           ${watched ? `<span class="marker watched">★</span>` : ""}
         </span>
       </div>
       <div class="card-body">
         <span class="card-brand">${escapeHtml(d.brand)}</span>
         <span class="card-title">${escapeHtml(d.title)}</span>
         <span class="card-kind">${escapeHtml(cardKindLabel(d))}</span>
         ${trustLine(d)}
         ${d.price_scope === "product" ? '<span class="watch-note">Confirm price for selected size and color</span>' : ""}
         <div class="price-row">
           <span class="price-now">$${fmt(d.sale_price)}</span>
           ${wasPrice}
           ${signalLine}
         </div>
       </div>
     </a>
     <div class="card-actions">
       <button type="button" class="card-menu-button" aria-expanded="false"
               aria-label="Actions for ${escapeAttr(d.title)}">⋯</button>
       <div class="card-menu" hidden>
         ${d.brand === "Lululemon" ? '<a href="https://shop.lululemon.com/c/men-we-made-too-much/n18mhdznrqw" target="_blank" rel="noopener">Open men’s sale page</a>' : ""}
         <button type="button" data-action="watch">${watched ? "Unwatch" : "Watch this"}</button>
         <button type="button" data-action="hide">Hide this</button>
       </div>
     </div>`;

  const menuButton = article.querySelector(".card-menu-button");
  const menu = article.querySelector(".card-menu");
  menuButton.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCardMenu(menuButton, menu);
  });
  article.querySelector('[data-action="watch"]').addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWatched(d.id);
  });
  article.querySelector('[data-action="hide"]').addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideDeal(d.id);
  });
  return article;
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

function setupPersonalization() {
  $("#new-filter")?.addEventListener("click", () => {
    state.newOnly = !state.newOnly;
    localStorage.setItem(NEW_ONLY_PREF, state.newOnly ? "1" : "0");
    refreshPersonalization();
  });
  $("#watched-filter")?.addEventListener("click", () => {
    state.watchedOnly = !state.watchedOnly;
    localStorage.setItem(WATCHED_ONLY_PREF, state.watchedOnly ? "1" : "0");
    refreshPersonalization();
  });
  $("#mark-all-seen")?.addEventListener("click", markAllSeen);
  $("#clear-hidden")?.addEventListener("click", () => {
    state.hiddenIds.clear();
    saveSet(HIDDEN_IDS_PREF, state.hiddenIds);
    refreshPersonalization();
  });
  $("#clear-watched")?.addEventListener("click", () => {
    state.watchedIds.clear();
    saveSet(WATCHED_IDS_PREF, state.watchedIds);
    refreshPersonalization();
  });
  document.addEventListener("click", closeCardMenus);
  renderPersonalLists();
  updateQuickFilterButtons();
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
  renderPersonalLists();
  renderGrid();
}

function toggleCardMenu(button, menu) {
  const opening = menu.hidden;
  closeCardMenus();
  menu.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
}

function closeCardMenus() {
  document.querySelectorAll(".card-menu").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll(".card-menu-button").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function hideDeal(id) {
  state.hiddenIds.add(id);
  saveSet(HIDDEN_IDS_PREF, state.hiddenIds);
  refreshPersonalization();
}

function restoreDeal(id) {
  state.hiddenIds.delete(id);
  saveSet(HIDDEN_IDS_PREF, state.hiddenIds);
  refreshPersonalization();
}

function toggleWatched(id) {
  if (state.watchedIds.has(id)) state.watchedIds.delete(id);
  else state.watchedIds.add(id);
  saveSet(WATCHED_IDS_PREF, state.watchedIds);
  refreshPersonalization();
}

function markAllSeen() {
  state.newIds.clear();
  state.seenIds = new Set(rawConfiguredDeals().map((d) => d.id));
  state.newOnly = false;
  saveSet(SEEN_IDS_PREF, state.seenIds);
  localStorage.setItem(LAST_OPEN_AT_PREF, new Date().toISOString());
  localStorage.setItem(NEW_ONLY_PREF, "0");
  refreshPersonalization();
}

function refreshPersonalization() {
  closeCardMenus();
  buildChips();
  renderBrandManager();
  renderPersonalLists();
  renderGrid();
}

function updateQuickFilterButtons() {
  const newButton = $("#new-filter");
  const watchedButton = $("#watched-filter");
  if (!newButton || !watchedButton) return;
  newButton.setAttribute("aria-pressed", String(state.newOnly));
  watchedButton.setAttribute("aria-pressed", String(state.watchedOnly));
  $("#new-count").textContent = String(itemCount((d) => state.newIds.has(d.id)));
  $("#watched-count").textContent = String(itemCount((d) => state.watchedIds.has(d.id)));
}

function renderPersonalLists() {
  renderItemList($("#hidden-items"), currentHiddenDeals(), {
    empty: "No hidden items.",
    action: "Restore",
    handler: restoreDeal,
  });
  renderItemList($("#watched-items"), currentWatchedDeals(), {
    empty: "No watched items.",
    action: "Unwatch",
    handler: toggleWatched,
  });
  const hiddenCount = $("#hidden-total");
  const watchedTotal = $("#watched-total");
  if (hiddenCount) hiddenCount.textContent = String(state.hiddenIds.size);
  if (watchedTotal) watchedTotal.textContent = String(state.watchedIds.size);
}

function renderItemList(root, entries, { empty, action, handler }) {
  if (!root) return;
  root.innerHTML = "";
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "item-list-empty";
    p.textContent = empty;
    root.appendChild(p);
    return;
  }
  for (const { id, deal } of entries) {
    const row = document.createElement("div");
    row.className = "item-row";
    const title = deal ? deal.title : id;
    const meta = deal
      ? `${deal.brand} · ${SIZE_LABELS[deal.size_bucket] || deal.size_label} · $${fmt(deal.sale_price)}`
      : "Not in current feed";
    row.innerHTML =
      `<span class="item-row-text">
         <span class="item-row-title">${escapeHtml(title)}</span>
         <span class="item-row-meta">${escapeHtml(meta)}</span>
       </span>
       <button type="button">${escapeHtml(action)}</button>`;
    row.querySelector("button").addEventListener("click", () => handler(id));
    root.appendChild(row);
  }
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
  const sourceBrands = (state.data?.sources || []).map((s) => s.brand);
  const dealBrands = (state.data?.deals || []).map((d) => d.brand);
  return new Set([...sourceBrands, ...dealBrands]);
}
function rawConfiguredDeals() {
  const configured = configuredBrandNames();
  return (state.data?.deals || []).filter((d) =>
    d.in_stock === true && (configured.size === 0 || configured.has(d.brand)));
}
function configuredDeals() {
  return rawConfiguredDeals().filter((d) => !state.hiddenIds.has(d.id));
}
function passesItemFilters(deal) {
  if (state.watchedOnly && !state.watchedIds.has(deal.id)) return false;
  if (state.newOnly && !state.newIds.has(deal.id)) return false;
  return true;
}
function passesTaxonomyFilters(deal) {
  const vertical = verticalOf(deal);
  if (state.vertical !== "all" && vertical !== state.vertical) return false;
  if (state.garment !== "all" && garmentOf(deal) !== state.garment) return false;
  if (state.gearType !== "all" && gearTypeOf(deal) !== state.gearType) return false;
  return true;
}
function passesSizeFilter(deal) {
  if (state.size === "all") return true;
  if (verticalOf(deal) !== "apparel") return true;
  return deal.size_bucket === state.size;
}
function itemCount(predicate) {
  return configuredDeals().filter((d) => isBrandVisibleName(d.brand) && predicate(d)).length;
}
function verticalOf(deal) {
  return deal.vertical || "apparel";
}
function garmentOf(deal) {
  return deal.garment || deal.category || "other";
}
function gearTypeOf(deal) {
  if (deal.gear_type) return deal.gear_type;
  if (verticalOf(deal) === "electronics") return "tech";
  if (verticalOf(deal) === "localllm") return "pc";
  return "other";
}
function labelForGarment(value) {
  return GARMENT_LABELS[value] || titleCase(value);
}
function labelForGear(value) {
  return GEAR_LABELS[value] || LOCALLLM_LABELS[value] || titleCase(value);
}
function verticalOrder(value) {
  return { apparel: 0, gear: 1, electronics: 2, localllm: 3 }[value] ?? 9;
}
function cardTypeLabel(deal) {
  if (verticalOf(deal) === "apparel") return SIZE_LABELS[deal.size_bucket] || deal.size_label;
  if (verticalOf(deal) === "localllm") return labelForGear(gearTypeOf(deal));
  return cardKindLabel(deal);
}
function cardKindLabel(deal) {
  if (verticalOf(deal) === "apparel") return labelForGarment(garmentOf(deal));
  if (verticalOf(deal) === "localllm") return deal.ram_gb ? `${deal.ram_gb}GB memory` : "Local LLM rig";
  if (verticalOf(deal) === "electronics") return labelForGear(gearTypeOf(deal));
  return labelForGear(gearTypeOf(deal));
}
function sortRigsByPrice(deals) {
  return [...deals].sort((a, b) => a.sale_price - b.sale_price);
}
function dealSections(deals) {
  if (state.vertical !== "all") {
    const ordered = state.vertical === "localllm" ? sortRigsByPrice(deals) : deals;
    return [{ title: VERTICAL_LABELS[state.vertical] || titleCase(state.vertical), deals: ordered }];
  }
  const apparel = deals.filter((d) => verticalOf(d) === "apparel");
  const rigs = deals.filter((d) => verticalOf(d) === "localllm");
  const gear = deals.filter((d) => verticalOf(d) !== "apparel" && verticalOf(d) !== "localllm");
  const sections = [];
  if (apparel.length) sections.push({ title: "Clothes", deals: apparel });
  if (gear.length) sections.push({ title: "Gear & Tech", deals: gear });
  if (rigs.length) sections.push({ title: "Local LLM rigs", deals: sortRigsByPrice(rigs) });
  return sections;
}
function currentHiddenDeals() {
  const byId = dealMap(rawConfiguredDeals());
  return [...state.hiddenIds].sort().map((id) => ({ id, deal: byId.get(id) || null }));
}
function currentWatchedDeals() {
  const byId = dealMap(rawConfiguredDeals());
  return [...state.watchedIds].sort().map((id) => ({ id, deal: byId.get(id) || null }));
}
function dealMap(deals) {
  return new Map(deals.map((d) => [d.id, d]));
}
function captureNewSinceLastOpen() {
  const currentIds = new Set(rawConfiguredDeals().map((d) => d.id));
  state.newIds = new Set([...currentIds].filter((id) => !state.seenIds.has(id)));
  state.seenIds = currentIds;
  saveSet(SEEN_IDS_PREF, state.seenIds);
  localStorage.setItem(LAST_OPEN_AT_PREF, new Date().toISOString());
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
  return state.brands.size > 0 || state.size !== "all" || state.disabledBrands.size > 0 ||
    state.watchedOnly || state.newOnly || state.hiddenIds.size > 0 ||
    state.vertical !== "all" || state.garment !== "all" || state.gearType !== "all";
}
function titleCase(s) {
  return String(s || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function fmt(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
// Only ever render http(s) URLs as an href — never a javascript:/data: scheme
// from the generated feed (defense-in-depth; mirrors the /try safeHttp helper).
function safeHttp(url) { return url && /^https?:\/\//i.test(url) ? url : null; }
