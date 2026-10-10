import { basename } from "node:path";

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
