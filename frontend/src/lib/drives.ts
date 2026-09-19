import type { LiveDrive } from "@/lib/api";

export function driveForPath(path: string | null | undefined, drives: LiveDrive[] | undefined): LiveDrive | undefined {
  if (!path) return undefined;
  return (drives ?? []).filter((drive) => path === drive.mount || path.startsWith(`${drive.mount.endsWith("/") ? drive.mount : `${drive.mount}/`}`)).sort((left, right) => right.mount.length - left.mount.length)[0];
}
