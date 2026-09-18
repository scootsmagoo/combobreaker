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
