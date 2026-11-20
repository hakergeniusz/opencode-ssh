/**
 * Remote `ls`, `grep` and `find`.
 *
 * These are standalone tool implementations that run the search on the remote
 * side and rewrite results into the local path space.
 */

import nodePath from "node:path"
import type { PathMapper } from "./path-map.ts"
import { resolveToolPath, type RemoteContext } from "./remote-ops.ts"
import { shellQuote } from "./shell.ts"

const DEFAULT_LS_LIMIT = 500
const DEFAULT_GREP_LIMIT = 100
const DEFAULT_FIND_LIMIT = 1000
/** Upper bound for a single remote search, in bytes. */
const DEFAULT_MAX_BYTES = 30_000
/** Seconds a single remote search may take. */
const SEARCH_TIMEOUT_SECONDS = 120

export interface LsParams {
  path?: string
  limit?: number
}
export interface GrepParams {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}
export interface FindParams {
  pattern: string
  path?: string
  limit?: number
}

/* ---------------------------------------------------------------- truncation */

export interface Truncation {
  content: string
  truncated: boolean
}

/** Line-oriented head truncation with a byte budget, mirroring pi's helper. */
export function truncateHead(
  text: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): Truncation {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER
  const kept: string[] = []
  let bytes = 0
  let truncated = false
  for (const line of text.split("\n")) {
    if (kept.length >= maxLines) {
      truncated = true
      break
    }
    const size = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0)
    if (bytes + size > maxBytes) {
      truncated = true
      break
    }
    kept.push(line)
    bytes += size
  }
  return { content: kept.join("\n"), truncated }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function withNotices(body: string, notices: string[]): string {
  return notices.length > 0 ? `${body}\n\n[${notices.join(". ")}]` : body
}

/* ------------------------------------------------------------------------ ls */

export async function listRemote(context: RemoteContext, params: LsParams, cwd: string, signal?: AbortSignal): Promise<string> {
  const localDir = resolveToolPath(params.path, cwd)
  const remoteDir = context.mapper.toRemote(localDir)
  const limit = params.limit ?? DEFAULT_LS_LIMIT

  const script = [
    `if [ ! -e ${shellQuote(remoteDir)} ]; then echo ${shellQuote(`Path not found: ${localDir}`)} >&2; exit 1; fi`,
    `if [ ! -d ${shellQuote(remoteDir)} ]; then echo ${shellQuote(`Not a directory: ${localDir}`)} >&2; exit 1; fi`,
    `cd ${shellQuote(remoteDir)} && ls -A -p`,
  ].join("; ")

  const raw = await context.session.capture(script, { signal, timeout: SEARCH_TIMEOUT_SECONDS })
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

  const limitReached = entries.length > limit
  const selected = limitReached ? entries.slice(0, limit) : entries
  if (selected.length === 0) return "(empty directory)"

  const truncation = truncateHead(selected.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER })
  const notices: string[] = []
  if (limitReached) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`)
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
  return withNotices(truncation.content, notices)
}

/* ---------------------------------------------------------------------- grep */

export interface SearchArgvInput {
  pattern: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  contextLines?: number
  searchPath: string
}

/**
 * Build the remote search command for the tool that actually exists on the host.
 * ripgrep and grep disagree about nearly every flag, so each gets its own argv.
 */
export function buildSearchArgv(tool: "rg" | "grep", input: SearchArgvInput): string[] {
  const { pattern, glob, ignoreCase, literal, contextLines, searchPath } = input
  if (searchPath.includes("\n")) throw new Error("Invalid search path")
  const contextCount = contextLines && contextLines > 0 ? Math.floor(contextLines) : 0

  if (tool === "rg") {
    const argv = [
      "--line-number",
      "--color=never",
      "--no-heading",
      "--with-filename",
      "--hidden",
      "--no-messages",
    ]
    if (ignoreCase) argv.push("--ignore-case")
    if (literal) argv.push("--fixed-strings")
    if (glob) argv.push("--glob", shellQuote(glob))
    if (contextCount > 0) argv.push("--context", String(contextCount))
    argv.push("-e", shellQuote(pattern), "--", shellQuote(searchPath))
    return argv
  }

  const argv = ["-rn", "--binary-files=without-match", "--exclude-dir=.git"]
  if (ignoreCase) argv.push("-i")
  if (literal) argv.push("-F")
  if (glob) argv.push(`--include=${shellQuote(glob)}`)
  if (contextCount > 0) argv.push("-C", String(contextCount))
  argv.push("-e", shellQuote(pattern), "--", shellQuote(searchPath))
  return argv
}

interface SearchResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

async function runSearch(
  context: RemoteContext,
  tool: "rg" | "grep",
  argv: string[],
  signal: AbortSignal | undefined,
): Promise<SearchResult> {
  const result = await context.session.exec(`${tool} ${argv.join(" ")}`, {
    signal,
    timeout: SEARCH_TIMEOUT_SECONDS,
  })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr }
}

async function classifyPath(
  context: RemoteContext,
  remotePath: string,
  localPath: string,
  signal: AbortSignal | undefined,
): Promise<"dir" | "file"> {
  const script = [
    `if [ -d ${shellQuote(remotePath)} ]; then echo dir`,
    `elif [ -e ${shellQuote(remotePath)} ]; then echo file`,
    `else echo ${shellQuote(`Path not found: ${localPath}`)} >&2; exit 1; fi`,
  ].join("; ")
  const out = await context.session.capture(script, { signal, timeout: SEARCH_TIMEOUT_SECONDS })
  return out.trim() === "dir" ? "dir" : "file"
}

/** Rewrite `path:line:text` output from the remote path space into the local one. */
export function mapGrepOutput(
  output: string,
  { mapper, searchRoot }: { mapper: PathMapper; searchRoot?: string },
): string {
  return output
    .split("\n")
    .map((line) => {
      // Match lines look like `path:12:text`, context lines like `path-12-text`.
      const match = /^(.*?[:-])(\d+)([:-])([\s\S]*)$/.exec(line)
      if (!match) return line
      const rawPath = match[1]!.slice(0, -1)
      const mappedRoot = searchRoot ? mapper.toLocal(searchRoot) : undefined
      let localPath = mapper.toLocal(rawPath)
      if (mappedRoot) {
        if (localPath === mappedRoot) localPath = "."
        else if (localPath.startsWith(`${mappedRoot}/`)) localPath = localPath.slice(mappedRoot.length + 1)
      }
      return `${localPath}:${match[2]}:${match[4]}`
    })
    .filter((line) => line.length > 0)
    .join("\n")
}

function grepResult(body: string, limit: number): string {
  if (body.trim() === "") return "(no matches)"
  const lines = body.split("\n")
  const limitReached = lines.length > limit
  const truncation = truncateHead((limitReached ? lines.slice(0, limit) : lines).join("\n"))
  const notices: string[] = []
  if (limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more`)
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
  return withNotices(truncation.content, notices)
}

export async function grepRemote(
  context: RemoteContext,
  params: GrepParams,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const localSearch = resolveToolPath(params.path, cwd)
  const remoteSearch = context.mapper.toRemote(localSearch)
  const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT)
  const kind = await classifyPath(context, remoteSearch, localSearch, signal)

  const searchInput: SearchArgvInput = {
    pattern: params.pattern,
    glob: params.glob,
    ignoreCase: params.ignoreCase,
    literal: params.literal,
    contextLines: params.context,
    searchPath: remoteSearch,
  }

  let tool: "rg" | "grep" = context.session.capabilities.rg ? "rg" : "grep"
  let result = await runSearch(context, tool, buildSearchArgv(tool, searchInput), signal)
  if (tool === "rg" && result.exitCode === 127) {
    // The probe saw ripgrep but running it failed: fall back instead of failing.
    tool = "grep"
    result = await runSearch(context, tool, buildSearchArgv(tool, searchInput), signal)
  }

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr.trim() || `Remote ${tool} failed (exit ${result.exitCode})`)
  }

  const body = mapGrepOutput(result.stdout, {
    mapper: context.mapper,
    searchRoot: kind === "dir" ? remoteSearch : undefined,
  })
  return grepResult(body, limit)
}

/* ---------------------------------------------------------------------- find */

async function runFd(
  context: RemoteContext,
  pattern: string,
  remoteSearch: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (pattern.includes("\n")) throw new Error("Invalid find pattern")

  const attempt = (extraFlag: string) =>
    context.session.exec(
      `fd --glob --type f --max-results ${maxResults} ${extraFlag} -- ${shellQuote(pattern)} .`,
      { cwd: remoteSearch, signal, timeout: SEARCH_TIMEOUT_SECONDS },
    )

  let result = await attempt("--no-require-git")
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    // Older fd releases do not know --no-require-git; retry without it.
    result = await attempt("")
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || `Remote fd failed (exit ${result.exitCode})`)
    }
  }
  return result.stdout.toString()
}

async function runFindFallback(
  context: RemoteContext,
  pattern: string,
  remoteSearch: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const script = [
    `cd ${shellQuote(remoteSearch)} || exit 1`,
    `find . -type f ${findPredicate(pattern)} -not -path '*/.git/*' | head -n ${maxResults}`,
  ].join("; ")
  return context.session.capture(script, { signal, timeout: SEARCH_TIMEOUT_SECONDS })
}

/** Translate a glob into a `find` predicate. `find` has no `**` and `-name` is basename-only. */
export function findPredicate(pattern: string): string {
  if (pattern.includes("/")) {
    const normalized = pattern.replaceAll("**/", "*/").replace(/^\.\//, "")
    return `-path ${shellQuote(`./${normalized}`)}`
  }
  return `-name ${shellQuote(pattern)}`
}

/** Small glob matcher (`*` and `**` only) used when the search path is one file. */
export function matchesGlob(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*")
  return new RegExp(`^${escaped}$`).test(name)
}

function normalizeFindPath(line: string, mapper: PathMapper): string {
  const relative = line.startsWith("./") ? line.slice(2) : line
  return nodePath.isAbsolute(relative) ? mapper.toLocal(relative) : relative
}

export async function findRemote(
  context: RemoteContext,
  params: FindParams,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const localSearch = resolveToolPath(params.path, cwd)
  const remoteSearch = context.mapper.toRemote(localSearch)
  const limit = params.limit ?? DEFAULT_FIND_LIMIT

  const kind = await classifyPath(context, remoteSearch, localSearch, signal)
  if (kind === "file") {
    // Single file: compare its basename to the pattern's last segment.
    const matches = matchesGlob(nodePath.posix.basename(localSearch), nodePath.posix.basename(params.pattern))
    return matches ? localSearch : "(no matches)"
  }

  const raw = context.session.capabilities.fd
    ? await runFd(context, params.pattern, remoteSearch, limit + 1, signal)
    : await runFindFallback(context, params.pattern, remoteSearch, limit + 1, signal)

  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeFindPath(line, context.mapper))
    .filter((line, index, all) => all.indexOf(line) === index)
    .sort((a, b) => a.localeCompare(b))

  const limitReached = entries.length > limit
  const selected = limitReached ? entries.slice(0, limit) : entries
  if (selected.length === 0) return "(no matches)"

  const truncation = truncateHead(selected.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER })
  const notices: string[] = []
  if (limitReached) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more`)
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
  return withNotices(truncation.content, notices)
}
