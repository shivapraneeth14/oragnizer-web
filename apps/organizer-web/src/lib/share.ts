import { env } from "../config"

const MOBILE_RE = /Mobi|Android|iPhone|iPad/i;

export function isMobileDevice(): boolean {
  return MOBILE_RE.test(navigator.userAgent);
}

export function shareBase(): string {
  if (isMobileDevice()) {
    return env.appDeepLinkBase.endsWith("/") ? env.appDeepLinkBase : `${env.appDeepLinkBase}/`;
  }
  const base = env.appUrl;
  return base.endsWith("/") ? base : `${base}/`;
}
