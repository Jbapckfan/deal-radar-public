// Public GitHub Pages config. deals.json is relayed here from the NAS by a Mini
// cron job, so the site (and the iOS app) work anywhere — no Tailscale needed.
window.DEAL_RADAR_CONFIG = {
  DEALS_URL: "./deals.json",
  NTFY_TOPIC: "james-deals",
  NTFY_BASE: "https://ntfy.sh",
};
