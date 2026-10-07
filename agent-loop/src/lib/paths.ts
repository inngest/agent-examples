import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? path.join(REPO_ROOT, "workspace");
export const WORKSPACE_SRC = path.join(WORKSPACE_DIR, "src");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const CHECK_DIR = path.join(REPO_ROOT, "check");
