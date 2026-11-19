/**
 * Remote implementations of the file and shell tool operations.
 *
 * Adapted from pi-ssh's `remote-ops.ts`: the pi `ReadOperations`/`WriteOperations`
 * interfaces and `createLocalBashOperations` are gone, replaced by plain async
 * functions that the OpenCode tool executors call directly. Everything else
 * (path mapping, POSIX quoting, stdin delivery, remote abort) is preserved.
 */

import { spawn } from "node:child_process"
import nodePath from "node:path"
import type { PathMapper } from "./path-map.ts"
import { shellQuote } from "./shell.ts"
import type { SshSession } from "./ssh-session.ts"

export interface RemoteContext {
  readonly session: SshSession
  readonly mapper: PathMapper
  /** Local working directory tool paths were resolved against. */
  readonly localCwd: string
  /** Allow `local: <command>` in the bash tool to run on this machine. */
  readonly allowLocalBash: boolean
}

/** Prefix that routes a bash command to the local machine instead of the remote one. */
export const LOCAL_ESCAPE_PREFIX = "local:"

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
}

/** Resolve a tool path argument against a working directory, like the original tools do. */
export function resolveToolPath(input: string | undefined, cwd: string): string {
  if (!input || input === ".") return cwd
  if (nodePath.isAbsolute(input)) return nodePath.resolve(input)
  return nodePath.resolve(cwd, input)
}

const remoteArg = (context: RemoteContext, localPath: string) => shellQuote(context.mapper.toRemote(localPath))

/** Read a file on the remote host, mapped from a local path. */
export async function readRemoteFile(context: RemoteContext, localPath: string): Promise<Buffer> {
  const arg = remoteArg(context, localPath)
  const script = [
    `if [ ! -e ${arg} ]; then echo ${shellQuote(`Path not found: ${localPath}`)} >&2; exit 1; fi`,
    `if [ -d ${arg} ]; then echo ${shellQuote(`Not a file: ${localPath}`)} >&2; exit 1; fi`,
    `cat -- ${arg}`,
  ].join("; ")
  const result = await context.session.exec(script)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Cannot read ${localPath} (exit ${result.exitCode})`)
  }
  return result.stdout
}

/** Assert a local path is readable on the remote host. */
export async function accessRemoteFile(context: RemoteContext, localPath: string): Promise<void> {
  const arg = remoteArg(context, localPath)
  const script = `test -r ${arg} || { echo ${shellQuote(`Cannot read: ${localPath}`)} >&2; exit 1; }`
  const result = await context.session.exec(script)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Cannot access: ${localPath}`)
}

/** Assert a local path exists, is readable and is writable on the remote host. */
export async function accessRemoteForEdit(context: RemoteContext, localPath: string): Promise<void> {
  const remote = remoteArg(context, localPath)
  const script = `test -e ${remote} && test -r ${remote} && test -w ${remote} || { echo ${shellQuote(`Not editable: ${localPath}`)} >&2; exit 1; }`
  const result = await context.session.exec(script)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Cannot edit: ${localPath}`)
}

/** Best-effort image MIME detection, by extension and (when available) remote `file(1)`. */
export async function detectImageMimeType(context: RemoteContext, localPath: string): Promise<string | null> {
  const guessed = IMAGE_MIME_BY_EXTENSION[nodePath.extname(localPath).toLowerCase()]
  if (!context.session.capabilities.file) return guessed ?? null
  try {
    const mime = (
      await context.session.capture(`file -b --mime-type -- ${remoteArg(context, localPath)}`, { timeout: 20 })
    ).trim()
    return mime.startsWith("image/") ? mime : null
  } catch {
    return guessed ?? null
  }
}

/** Write content over the remote command's stdin (no command-line length limit). */
export async function writeRemoteFile(context: RemoteContext, localPath: string, content: string): Promise<void> {
  const remote = context.mapper.toRemote(localPath)
  const parent = shellQuote(nodePath.posix.dirname(remote))
  const exitCode = await context.session.run(`mkdir -p -- ${parent} && cat > ${remoteArg(context, localPath)}`, {
    stdin: Buffer.from(content, "utf-8"),
  })
  if (exitCode !== 0) throw new Error(`Cannot write ${localPath} (remote exit ${exitCode})`)
}

/** Create a directory (and parents) on the remote host. */
export async function mkdirRemote(context: RemoteContext, dir: string): Promise<void> {
  const exitCode = await context.session.run(`mkdir -p -- ${shellQuote(context.mapper.toRemote(dir))}`)
  if (exitCode !== 0) throw new Error(`Cannot create directory ${dir} (remote exit ${exitCode})`)
}

/** Split a bash command into its local-escape prefix, if any. */
export function splitLocalEscape(command: string):
  | { local: true; command: string }
  | { local: false; command: string } {
  const match = /^\s*local:\s?([\s\S]*)$/.exec(command)
  if (!match) return { local: false, command }
  return { local: true, command: match[1] ?? "" }
}

export interface BashExecOptions {
  readonly signal?: AbortSignal
  /** Seconds. */
  readonly timeout?: number
}

export interface BashResult {
  readonly exitCode: number | null
  readonly output: string
}

/** Run a command remotely (or locally for the `local:` escape hatch), collecting output. */
export async function runBash(
  context: RemoteContext,
  command: string,
  cwd: string,
  options: BashExecOptions = {},
): Promise<BashResult> {
  const escape = context.allowLocalBash ? splitLocalEscape(command) : { local: false as const, command }
  if (escape.local) return runLocalBash(escape.command, cwd, options)

  let output = ""
  try {
    const exitCode = await context.session.run(command, {
      cwd: context.mapper.toRemote(cwd),
      onData: (data) => {
        output += data.toString()
      },
      signal: options.signal,
      timeout: options.timeout,
    })
    return { exitCode, output }
  } catch (error) {
    throw decorateRemoteError(error, context)
  }
}

/** Run a command on this machine, used only by the `local:` escape hatch. */
export function runLocalBash(command: string, cwd: string, options: BashExecOptions = {}): Promise<BashResult> {
  return new Promise<BashResult>((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (data: Buffer) => (output += data.toString()))
    child.stderr.on("data", (data: Buffer) => (output += data.toString()))

    const onAbort = () => child.kill("SIGTERM")
    options.signal?.addEventListener("abort", onAbort, { once: true })

    if (options.timeout && options.timeout > 0) {
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout * 1000)
      timer.unref?.()
    }

    child.on("error", reject)
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort)
      resolve({ exitCode: code, output })
    })
  })
}

function decorateRemoteError(error: unknown, context: RemoteContext): unknown {
  if (!(error instanceof Error)) return error
  if (error.message === "aborted" || error.message.startsWith("timeout:")) return error
  const remoteRoot = context.mapper.remoteRoot
  if (error.message.includes(remoteRoot)) {
    return new Error(`${error.message} (remote working directory: ${remoteRoot})`)
  }
  return error
}
