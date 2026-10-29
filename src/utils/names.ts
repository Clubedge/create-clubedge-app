import { basename } from "node:path";

// Windows reserves these names (and the CONIN$/CONOUT$ console handles) for legacy devices,
// in any case and regardless of extension, even though the Win32 namespace can bypass the
// check and leave an undeletable directory behind. COM/LPT also reserve the ¹²³ superscript
// digits Windows treats as equivalent to 1, 2, 3.
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$/i;

export function isReservedDeviceName(name: string): boolean {
  const dotIndex = name.indexOf(".");
  const base = dotIndex === -1 ? name : name.slice(0, dotIndex);
  const extension = dotIndex === -1 ? "" : name.slice(dotIndex);
  return RESERVED_DEVICE_NAMES.test(base.replace(/ +$/, "") + extension);
}

export function packageNameFromDirectory(directory: string): string {
  return (
    basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "") || "my-app"
  );
}

export function displayNameFromPackageName(packageName: string): string {
  return packageName
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
