// Turns a yt-dlp failure into something a person can act on. Used by the
// service worker when a Helper job fails, so the popup, the on-page badge and
// the system notification all say the same thing and offer the same button.
//
//   describeDownloadError(error, { cookiesSent })
//     -> { kind, title, hint, action } | null   (null = nothing special)
//
// action is what the UI's button does: "options-downloads" opens Options ›
// Downloads, where "Use my browser's cookies" lives.

export const BOT_CHECK = /sign in to confirm|not a bot|cookies-from-browser|--cookies for the authentication/i;
export const SIGN_IN_REQUIRED = /login required|members-only|private video|sign in to (?:view|access)|confirm your age|age.restricted/i;

export function describeDownloadError(error, { cookiesSent = false } = {}) {
  const err = String(error || "");
  if (!err) return null;
  if (BOT_CHECK.test(err)) {
    if (cookiesSent) {
      return {
        kind: "bot-check",
        title: "YouTube still wants a sign-in check",
        hint: "Your browser's cookies were sent, but YouTube did not accept them. Sign in to YouTube in this browser (or sign out and back in), then retry.",
        action: null,
      };
    }
    return {
      kind: "bot-check",
      title: "YouTube wants a sign-in check",
      hint: "Turn on “Use my browser’s cookies” in ComboBreaker options › Downloads, then retry. This is YouTube's bot check for your network, not a broken Helper.",
      action: "options-downloads",
    };
  }
  if (SIGN_IN_REQUIRED.test(err)) {
    return {
      kind: "sign-in",
      title: "This video needs a signed-in account",
      hint: cookiesSent
        ? "Sign in to the site in this browser with an account that can watch it, then retry."
        : "Sign in to the site in this browser, turn on “Use my browser’s cookies” in ComboBreaker options › Downloads, then retry.",
      action: cookiesSent ? null : "options-downloads",
    };
  }
  return null;
}

// Short form for places that show one line (job rows, notifications).
export function shortDownloadError(error) {
  return String(error || "")
    .replace(/^yt-dlp exited with code \d+\.\s*/, "")
    .replace(/^ERROR:\s*/, "")
    .replace(/\s*(?:See|Also see)\s+https?:\/\/\S+.*$/i, "")
    .trim();
}
