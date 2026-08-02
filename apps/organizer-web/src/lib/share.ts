const MOBILE_RE = /Mobi|Android|iPhone|iPad/i;

export function isMobileDevice(): boolean {
  return MOBILE_RE.test(navigator.userAgent);
}

export function shareBase(): string {
  if (isMobileDevice()) {
    return import.meta.env.VITE_APP_DEEPLINK_BASE || "cluvo://";
  }
  const base = import.meta.env.VITE_APP_URL || "https://cluvo-nu.vercel.app";
  return base.endsWith("/") ? base : `${base}/`;
}
