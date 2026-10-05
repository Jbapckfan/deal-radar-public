/* Stable, local product exclusions shared by the dashboard and its tests. */
(function (root) {
  const normalize = value => String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
  function keys(deal) {
    const result = [];
    if (deal.canonical_product_id) result.push("canonical:" + deal.canonical_product_id);
    try {
      const url = new URL(deal.url);
      if (/^https?:$/.test(url.protocol)) result.push("url:" + normalize(deal.brand) + "|" +
        normalize(url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "")));
    } catch (_) {}
    // Some shops give each color its own URL and SKU. Exact brand + displayed
    // product name intentionally hides those repetitions too (never fuzzy).
    if (normalize(deal.title)) result.push("title:" + normalize(deal.brand) + "|" + normalize(deal.title));
    return result;
  }
  const words = value => normalize(value).replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  function matchesPhrase(deal, phrase) {
    const needle = words(phrase);
    if (!needle) return false;
    const text = words([deal.title, deal.category, deal.garment, deal.gear_type].filter(Boolean).join(" "));
    return (" " + text + " ").includes(" " + needle + " ");
  }
  function matchesProduct(deal, record) {
    const current = keys(deal);
    return (record.keys || []).some(key => current.includes(key));
  }
  const api = { normalize, keys, words, matchesPhrase, matchesProduct };
  if (typeof module !== "undefined") module.exports = api;
  else root.DealPreferences = api;
})(typeof window === "undefined" ? globalThis : window);
