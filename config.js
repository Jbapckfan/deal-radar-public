// Runtime config. Production and local dashboards use their sibling feed; this
// falls back to ./deals.json. Override DEALS_URL at deploy time (or via a
// generated config.js) without rebuilding the app.
window.DEAL_RADAR_CONFIG = {
  DEALS_URL: "./deals.json",
  SOURCE_MANAGER_URL: "http://100.70.109.113:8087/manage-sources",
  NTFY_TOPIC: "james-deals",
  NTFY_BASE: "https://ntfy.sh",
};
