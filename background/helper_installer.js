// Hands the user a ready-to-run Windows installer for the ComboBreaker Helper.
//
// native/install.cmd ships inside the extension with two placeholders; this
// fills in the extension id (so the native host's allowed_origins is right
// without the user typing anything) and saves it through chrome.downloads.
// macOS / Linux use the terminal one-liner from lib/helper.js instead: a
// downloaded script would be quarantined and Gatekeeper makes running it a
// three-dialog affair, while pasting one line into Terminal is not.

import { HELPER_SOURCE, WINDOWS_INSTALLER_FILENAME } from "../lib/helper.js";

export async function downloadWindowsInstaller() {
  const res = await fetch(chrome.runtime.getURL("native/install.cmd"));
  if (!res.ok) throw new Error(`installer template missing (${res.status})`);
  let text = await res.text();
  text = text.replace(/__CB_EXT_ID__/g, chrome.runtime.id).replace(/__CB_SOURCE__/g, HELPER_SOURCE);
  // cmd.exe wants CRLF; the PowerShell part doesn't care.
  text = text.replace(/\r?\n/g, "\r\n");
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const url = `data:application/octet-stream;base64,${btoa(bin)}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename: WINDOWS_INSTALLER_FILENAME,
    saveAs: false,
    conflictAction: "overwrite",
  });
  return { downloadId, filename: WINDOWS_INSTALLER_FILENAME };
}
