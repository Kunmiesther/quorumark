// Mobile / embedded-browser detection for the social sign-in buttons.
//
// Why this exists: on a real phone the Lovable auth helper performs a
// SAME-TAB redirect (verified against turtlebot.app with an iPhone user
// agent), which works in Safari and Chrome. It only uses window.open when
// the app is running inside an iframe. The genuinely broken case on a phone
// is an EMBEDDED webview (ChatGPT, Instagram, Facebook, TikTok, …): Google
// refuses OAuth in those user agents ("disallowed_useragent") and some of
// them silently swallow window.open, so the button looks dead.
//
// Pure functions only — no DOM writes — so they are unit-testable.

export interface BrowserEnv {
  isIOS: boolean;
  isAndroid: boolean;
  isMobile: boolean;
  /** Embedded webview inside another app (not Safari/Chrome/Firefox). */
  isInAppBrowser: boolean;
  /** Friendly host-app name when we can identify it. */
  inAppName: string | null;
}

const IN_APP_PATTERNS: Array<[RegExp, string]> = [
  [/ChatGPT/i, "ChatGPT"],
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB|Messenger/i, "Facebook"],
  [/Line\//i, "LINE"],
  [/TikTok|BytedanceWebview|musical_ly/i, "TikTok"],
  [/Twitter|X11Webview/i, "X"],
  [/Snapchat/i, "Snapchat"],
  [/LinkedInApp/i, "LinkedIn"],
  [/WhatsApp/i, "WhatsApp"],
  [/Pinterest/i, "Pinterest"],
  [/Slack/i, "Slack"],
  [/Discord/i, "Discord"],
  [/Telegram/i, "Telegram"],
  [/MicroMessenger/i, "WeChat"],
];

export function detectBrowserEnv(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): BrowserEnv {
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid;

  // The Lovable native shell handles OAuth itself — never treat it as broken.
  const isLovableShell = /LovableApp\//i.test(ua);

  let inAppName: string | null = null;
  if (!isLovableShell) {
    for (const [re, name] of IN_APP_PATTERNS) {
      if (re.test(ua)) {
        inAppName = name;
        break;
      }
    }
    // Generic iOS webview: WebKit without "Safari" and without a known
    // third-party browser token.
    if (
      !inAppName &&
      isIOS &&
      /AppleWebKit/i.test(ua) &&
      !/Safari/i.test(ua) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)
    ) {
      inAppName = "this app";
    }
    // Generic Android webview marker.
    if (!inAppName && isAndroid && /; wv\)/i.test(ua)) {
      inAppName = "this app";
    }
  }

  return {
    isIOS,
    isAndroid,
    isMobile,
    isInAppBrowser: inAppName !== null,
    inAppName,
  };
}

export function inAppBrowserMessage(env: BrowserEnv): string {
  const where = env.isIOS ? "Safari" : "Chrome";
  const host = env.inAppName && env.inAppName !== "this app" ? env.inAppName : "this app";
  return `Google blocks sign-in inside ${host}. Tap the ⋯ menu and choose “Open in ${where}” to continue with Google, or use email sign-in below.`;
}

/** True when the auth helper failed because a popup/new window was suppressed. */
export function isPopupBlockedError(message: string): boolean {
  return /popup|blocked|new window/i.test(message);
}
