import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

export type PrivateFilesRuntime = {
  platform: string;
  environment: Readonly<Record<string, string | undefined>>;
  executablePath: string;
  uid: number | undefined;
};

type AncestorStat = { uid: number; mode: number };
const ANDROID_SYSTEM_UID = 1000;

function defaultRuntime(): PrivateFilesRuntime {
  return {
    platform: process.platform,
    environment: process.env,
    executablePath: process.execPath,
    uid: process.getuid?.(),
  };
}

function termuxFilesRoot(runtime: PrivateFilesRuntime): string | undefined {
  const { environment, executablePath, platform } = runtime;
  const android =
    platform === "android" ||
    environment["ANDROID_ROOT"] === "/system" ||
    environment["ANDROID_DATA"] === "/data" ||
    environment["TERMUX_VERSION"] !== undefined ||
    executablePath.startsWith("/data/data/com.termux/") ||
    executablePath.startsWith("/data/user/0/com.termux/");
  if (!android) return undefined;

  for (const root of ["/data/data/com.termux/files", "/data/user/0/com.termux/files"] as const) {
    if (
      environment["PREFIX"] === `${root}/usr` ||
      environment["HOME"] === `${root}/home` ||
      executablePath.startsWith(`${root}/`)
    )
      return root;
  }
  return undefined;
}

export function allowsAndroidTermuxAncestor(
  path: string,
  stat: AncestorStat,
  runtime: PrivateFilesRuntime,
  protectedByAppBoundary: boolean,
): boolean {
  const filesRoot = termuxFilesRoot(runtime);
  if (!filesRoot) return false;
  const permissions = stat.mode & 0o777;
  if (path === "/data" || (filesRoot.startsWith("/data/data/") && path === "/data/data"))
    return stat.uid === ANDROID_SYSTEM_UID && permissions === 0o771;
  return (
    path === filesRoot &&
    protectedByAppBoundary &&
    stat.uid === runtime.uid &&
    permissions === 0o771
  );
}

/** Refuse writable/redirected ancestors before creating application-owned state. */
export function safeAncestors(path: string, runtime = defaultRuntime()): void {
  if (!isAbsolute(path) || normalize(path) !== path || path === "/")
    throw new Error(`Expected an absolute normalized path: ${path}`);
  const filesRoot = termuxFilesRoot(runtime);
  const appRoot = filesRoot?.slice(0, -"/files".length);
  let protectedByAppBoundary = false;
  let current = "";
  for (const part of path.slice(1).split("/")) {
    current += `/${part}`;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (
      runtime.platform === "darwin" &&
      (current === "/tmp" || current === "/var") &&
      stat.isSymbolicLink() &&
      stat.uid === 0 &&
      realpathSync(current) === `/private${current}`
    )
      continue;
    const androidException =
      stat.isDirectory() &&
      allowsAndroidTermuxAncestor(current, stat, runtime, protectedByAppBoundary);
    if (
      !stat.isDirectory() ||
      (!androidException &&
        ((stat.uid !== 0 && stat.uid !== runtime.uid) ||
          ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))))
    )
      throw new Error(`Unsafe directory: ${current}`);
    if (
      current === appRoot &&
      stat.isDirectory() &&
      stat.uid === runtime.uid &&
      (stat.mode & 0o777) === 0o700
    )
      protectedByAppBoundary = true;
  }
}

export function ownedDirectory(path: string, mode = 0o700): void {
  safeAncestors(path);
  mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== mode)
    throw new Error(`Directory must be owned by this user with mode ${mode.toString(8)}: ${path}`);
}

export function ownedFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error(`Unsafe private file: ${path}`);
  return true;
}
