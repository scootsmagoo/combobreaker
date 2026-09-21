// Shared facts about the ComboBreaker Helper: the optional native-messaging
// host (native/host.js + a private Node, Python/yt-dlp and ffmpeg) that makes
// YouTube, DASH and split-audio HLS downloads one click. Used by the service
// worker, the setup page, the popup and the options page.

export const HELPER_NAME = "ComboBreaker Helper";

// Where the setup page and the Windows installer fetch the host from. The
// installer scripts live in the repo, so `git push` ships them.
export const HELPER_SOURCE = "https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native";

// Terminal one-liner for macOS / Linux.
export function helperInstallCommand(extensionId) {
  return `curl -fsSL ${HELPER_SOURCE}/install.sh | bash -s -- ${extensionId}`;
}

export function helperFolderFor(os) {
  if (os === "win") return "%LOCALAPPDATA%\\ComboBreaker\\helper";
  if (os === "mac") return "~/Library/Application Support/ComboBreaker/helper";
  return "~/.local/share/combobreaker/helper";
}

export function helperUninstallFor(os) {
  if (os === "win") return "%LOCALAPPDATA%\\ComboBreaker\\Uninstall ComboBreaker Helper.cmd";
  return `${helperFolderFor(os)}/uninstall.sh`;
}

export const WINDOWS_INSTALLER_FILENAME = "Install ComboBreaker Helper.cmd";

// ---------- optional nativeMessaging permission ----------

// nativeMessaging is an optional permission, so three things can be true at
// once: Chrome has granted it, the running service worker was started before
// the grant and so has no chrome.runtime.connectNative, and the Helper is
// already installed. Chrome never adds the API to a worker that is already
// running; only a reload of the extension does. This decides what the bridge
// should do about it. Pure so it can be unit-tested.
//
//   granted       chrome.permissions.contains({ permissions: ["nativeMessaging"] })
//   bound         typeof chrome.runtime.connectNative === "function"
//   lastReloadAt  when the bridge last reloaded the extension for this reason
//                 (0 = never, or the reload has since been confirmed to work)
//
// Returns one of:
//   "ready"                 talk to the Helper
//   "needs-permission"      show the Allow button
//   "needs-reload"          granted but not usable yet: reload the extension
//   "needs-browser-restart" a reload just happened and did not help; only a
//                           full browser restart is left
export const RELOAD_COOLDOWN_MS = 2 * 60_000;

export function helperPermissionState({ granted, bound, lastReloadAt = 0, now = Date.now() }) {
  if (bound) return "ready";
  if (!granted) return "needs-permission";
  if (lastReloadAt && now - lastReloadAt < RELOAD_COOLDOWN_MS) return "needs-browser-restart";
  return "needs-reload";
}

// storage.local keys the reload dance uses.
export const RELOAD_AT_KEY = "cb_helper_reload_at";
export const REOPEN_KEY = "cb_helper_setup_reopen";
