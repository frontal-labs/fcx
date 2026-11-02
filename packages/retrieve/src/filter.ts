import { isAbsolute, relative } from "node:path";

export function isInside(workspace: string, file: string): boolean {
  const rel = relative(workspace, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isLibrary(fileName: string): boolean {
  return fileName.includes("/node_modules/") || fileName.includes("/typescript/lib/");
}
