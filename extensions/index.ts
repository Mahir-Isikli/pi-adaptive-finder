import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_CANDIDATES = 72;
const DEFAULT_MAX_SELECTED = 8;
const DEFAULT_MAX_EVIDENCE_LINES = 3;
const DEFAULT_MAX_RG_LINES = 1800;
const DEFAULT_MAX_PROMPT_CHARS = 12000;
const DEFAULT_MAX_COMPLETION_TOKENS = 700;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RERANKERS = 2;

const SKIP_DIR_GLOBS = [
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/.next/**",
  "!**/.nuxt/**",
  "!**/.svelte-kit/**",
  "!**/.turbo/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/.git/**",
  "!**/*.map",
  "!**/pnpm-lock.yaml",
  "!**/package-lock.json",
  "!**/yarn.lock",
];

const SOURCE_FILE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.py",
  "*.go",
  "*.rs",
  "*.swift",
  "*.kt",
  "*.java",
  "*.rb",
  "*.php",
  "*.cs",
  "*.md",
  "*.mdx",
  "*.json",
  "*.yaml",
  "*.yml",
  "*.toml",
  "*.sql",
  "*.prisma",
  "*.graphql",
  "*.css",
  "*.scss",
  "*.html",
  "*.vue",
  "*.svelte",
];

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "api",
  "are",
  "bug",
  "can",
  "code",
  "component",
  "does",
  "file",
  "files",
  "find",
  "flow",
  "for",
  "from",
  "hook",
  "how",
  "impl",
  "implemented",
  "into",
  "logic",
  "map",
  "need",
  "page",
  "path",
  "return",
  "service",
  "show",
  "task",
  "that",
  "the",
  "this",
  "through",
  "to",
  "use",
  "used",
  "where",
  "which",
  "with",
]);

type Candidate = {
  path: string;
  score: number;
  evidence: string[];
};

type ModelPick = {
  path: string;
  reason?: string;
  confidence?: number;
};

type RerankerConfig = {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  apiKey?: string;
  keychainService?: string;
  reasoningEffort?: "none" | "low" | "medium";
  maxCompletionTokens?: number;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
};

type RerankerRun = {
  name: string;
  label: string;
  ok: boolean;
  elapsedMs: number;
  picks: ModelPick[];
  usage?: Record<string, unknown>;
  error?: string;
};

type FinderStatus = "done" | "error";

type FinderDetails = {
  status: FinderStatus;
  workspace: string;
  mode: "adaptive";
  rerankers: Array<{
    name: string;
    model: string;
    ok: boolean;
    elapsedMs: number;
    error?: string;
    usage?: Record<string, unknown>;
  }>;
  candidates: number;
  selected: string[];
  elapsedMs: number;
};

type FinderConfig = {
  toolName: string;
  maxCandidates: number;
  maxSelected: number;
  maxEvidenceLines: number;
  maxRgLines: number;
  maxPromptChars: number;
  timeoutMs: number;
  maxRerankers: number;
  preset: string;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getConfig(): FinderConfig {
  const toolName = (process.env.PI_ADAPTIVE_FINDER_TOOL_NAME ?? "adaptive_finder").trim();
  return {
    toolName: /^[a-zA-Z_][a-zA-Z0-9_-]*$/u.test(toolName) ? toolName : "adaptive_finder",
    maxCandidates: envInt("PI_ADAPTIVE_FINDER_MAX_CANDIDATES", DEFAULT_MAX_CANDIDATES),
    maxSelected: envInt("PI_ADAPTIVE_FINDER_MAX_SELECTED", DEFAULT_MAX_SELECTED),
    maxEvidenceLines: envInt("PI_ADAPTIVE_FINDER_MAX_EVIDENCE_LINES", DEFAULT_MAX_EVIDENCE_LINES),
    maxRgLines: envInt("PI_ADAPTIVE_FINDER_MAX_RG_LINES", DEFAULT_MAX_RG_LINES),
    maxPromptChars: envInt("PI_ADAPTIVE_FINDER_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS),
    timeoutMs: envInt("PI_ADAPTIVE_FINDER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    maxRerankers: envInt("PI_ADAPTIVE_FINDER_MAX_RERANKERS", DEFAULT_MAX_RERANKERS),
    preset: (process.env.PI_ADAPTIVE_FINDER_PRESET ?? "auto").trim().toLowerCase(),
  };
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlash(baseUrl.trim());
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|JSON)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function normalizePath(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replace(/^\.\//u, "");
}

function tokenize(query: string): string[] {
  const raw = query.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  const pieces = raw.flatMap((token) => {
    const split = token
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[-_\s]+/g)
      .filter(Boolean);
    return [token, ...split];
  });

  return uniq(
    pieces
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
      .sort((a, b) => b.length - a.length),
  ).slice(0, 32);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function commandExists(command: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-lc", `command -v ${command}`], { cwd, timeout: 2000, maxBuffer: 16 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function getWorkspaceFiles(cwd: string): Promise<string[]> {
  if (!(await commandExists("rg", cwd))) return [];

  const args = [
    "--files",
    ...SKIP_DIR_GLOBS.flatMap((glob) => ["--glob", glob]),
    ...SOURCE_FILE_GLOBS.flatMap((glob) => ["--glob", glob]),
  ];

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      timeout: 12000,
      maxBuffer: 6 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !path.isAbsolute(file));
  } catch {
    return [];
  }
}

function scorePath(file: string, tokens: string[]): number {
  const lower = file.toLowerCase();
  const base = path.basename(file).toLowerCase();
  let score = 0;

  for (const token of tokens) {
    const variants = uniq([token, token.replace(/_/g, "-"), token.replace(/-/g, "_")]);
    for (const variant of variants) {
      if (!variant) continue;
      if (lower.includes(variant)) score += 3;
      if (base.includes(variant)) score += 5;
    }
  }

  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/u.test(file)) score += 0.5;
  if (/\.(md|mdx)$/u.test(file)) score -= 0.25;
  return score;
}

async function buildCandidateMap(cwd: string, query: string, config: FinderConfig): Promise<{ candidates: Candidate[]; tokens: string[] }> {
  const files = await getWorkspaceFiles(cwd);
  if (files.length === 0) return { candidates: [], tokens: [] };

  const filesSet = new Set(files);
  const tokens = tokenize(query);
  if (tokens.length === 0) return { candidates: [], tokens };

  const candidateMap = new Map<string, Candidate>();
  for (const file of files) {
    const score = scorePath(file, tokens);
    if (score > 0) candidateMap.set(file, { path: file, score, evidence: [] });
  }

  const patterns = tokens.filter((token) => token.length >= 4).slice(0, 24);
  if (patterns.length > 0 && (await commandExists("rg", cwd))) {
    const args = [
      "-n",
      "-i",
      "-S",
      ...SKIP_DIR_GLOBS.flatMap((glob) => ["--glob", glob]),
      ...SOURCE_FILE_GLOBS.flatMap((glob) => ["--glob", glob]),
      patterns.map(escapeRegex).join("|"),
      ".",
    ];

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd,
        timeout: 14000,
        maxBuffer: 8 * 1024 * 1024,
      });

      for (const line of stdout.split("\n").slice(0, config.maxRgLines)) {
        const match = line.match(/^\.\/([^:]+):(\d+):(.*)$/u) ?? line.match(/^([^:]+):(\d+):(.*)$/u);
        if (!match) continue;
        const file = normalizePath(match[1] ?? "");
        if (!filesSet.has(file)) continue;

        const candidate = candidateMap.get(file) ?? { path: file, score: 0, evidence: [] };
        candidate.score += 1;

        const text = (match[3] ?? "").trim().replace(/\s+/g, " ");
        const lowerText = text.toLowerCase();
        for (const token of patterns.slice(0, 12)) {
          if (lowerText.includes(token)) candidate.score += 0.25;
        }

        if (candidate.evidence.length < config.maxEvidenceLines) {
          candidate.evidence.push(`${match[2]}: ${text.slice(0, 220)}`);
        }
        candidateMap.set(file, candidate);
      }
    } catch {
      // rg exits non-zero when there are no matches. Path scoring can still work.
    }
  }

  const candidates = [...candidateMap.values()]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, config.maxCandidates);

  return { candidates, tokens };
}

function formatCandidatePrompt(query: string, candidates: Candidate[], config: FinderConfig): string {
  const lines = candidates.map((candidate, index) => {
    const evidence = candidate.evidence.length > 0 ? ` evidence: ${candidate.evidence.slice(0, 2).join(" | ")}` : "";
    return `${index + 1}. ${candidate.path} [score=${candidate.score.toFixed(1)}]${evidence}`;
  });

  return `You are a fast read-only codebase Finder reranker. Select the repo files most likely to answer the task.\n\nTask:\n${query.trim()}\n\nCandidate files from grouped path + ripgrep retrieval:\n${lines.join("\n").slice(0, config.maxPromptChars)}\n\nReturn only JSON, no markdown. Format:\n[{"path":"relative/path.ts","reason":"short reason","confidence":0.0}]\n\nRules:\n- Choose 3 to ${config.maxSelected} existing candidate paths only.\n- Prefer implementation entrypoints, hooks/services/API clients, tests, config, and docs that directly unblock the task.\n- Do not invent paths.\n- Keep reasons under 14 words.`;
}

function parseModelPicks(text: string): ModelPick[] {
  const cleaned = stripCodeFence(text);
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/u);
  const source = jsonMatch ? jsonMatch[0] : cleaned;

  try {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return { path: normalizePath(item) };
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const rawPath = typeof record.path === "string" ? record.path : undefined;
        if (!rawPath) return undefined;
        const confidence = typeof record.confidence === "number" ? record.confidence : undefined;
        return {
          path: normalizePath(rawPath),
          reason: typeof record.reason === "string" ? record.reason.trim() : undefined,
          confidence,
        } satisfies ModelPick;
      })
      .filter((pick): pick is ModelPick => Boolean(pick?.path));
  } catch {
    const paths = cleaned.match(/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g) ?? [];
    return uniq(paths.map(normalizePath)).map((p) => ({ path: p }));
  }
}

async function getKeychainPassword(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 4000,
      maxBuffer: 8 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function resolveApiKey(config: RerankerConfig): Promise<string | undefined> {
  if (config.apiKey?.trim()) return config.apiKey.trim();
  if (config.apiKeyEnv) {
    const value = process.env[config.apiKeyEnv]?.trim();
    if (value) return value;
  }
  if (config.keychainService) return getKeychainPassword(config.keychainService);
  return undefined;
}

function parseJsonRerankers(): RerankerConfig[] | undefined {
  const raw = process.env.PI_ADAPTIVE_FINDER_RERANKERS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((item): item is RerankerConfig => {
      const record = item as Partial<RerankerConfig> | undefined;
      return Boolean(record?.name && record.baseUrl && record.model);
    });
  } catch {
    return undefined;
  }
}

function presetRerankers(preset: string): RerankerConfig[] {
  const cerebras = [
    {
      name: "cerebras-oss-120b",
      baseUrl: "https://api.cerebras.ai/v1",
      apiKeyEnv: "CEREBRAS_API_KEY",
      keychainService: "cerebras-api-key",
      model: "gpt-oss-120b",
      reasoningEffort: "low",
    },
    {
      name: "cerebras-glm-4.7",
      baseUrl: "https://api.cerebras.ai/v1",
      apiKeyEnv: "CEREBRAS_API_KEY",
      keychainService: "cerebras-api-key",
      model: "zai-glm-4.7",
      reasoningEffort: "none",
      extraBody: { clear_thinking: false },
    },
  ] satisfies RerankerConfig[];

  const groq = [
    {
      name: "groq-oss-120b",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      keychainService: "groq-api-key",
      model: "openai/gpt-oss-120b",
      reasoningEffort: "low",
    },
    {
      name: "groq-oss-20b",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      keychainService: "groq-api-key",
      model: "openai/gpt-oss-20b",
      reasoningEffort: "low",
    },
  ] satisfies RerankerConfig[];

  if (preset === "local" || preset === "off" || preset === "none") return [];
  if (preset === "groq") return groq;
  if (preset === "cerebras") return cerebras;
  return [...cerebras, ...groq];
}

async function getAvailableRerankers(config: FinderConfig): Promise<RerankerConfig[]> {
  const explicit = parseJsonRerankers();
  const source = explicit ?? presetRerankers(config.preset);
  const available: RerankerConfig[] = [];

  for (const reranker of source) {
    const apiKey = await resolveApiKey(reranker);
    if (!apiKey) continue;
    available.push({ ...reranker, apiKey });
    if (available.length >= config.maxRerankers) break;
  }

  return available;
}

async function runReranker(
  reranker: RerankerConfig,
  prompt: string,
  config: FinderConfig,
  signal?: AbortSignal,
): Promise<RerankerRun> {
  const startedAt = Date.now();
  const apiKey = await resolveApiKey(reranker);
  if (!apiKey) {
    return {
      name: reranker.name,
      label: `${reranker.name} (${reranker.model})`,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      picks: [],
      error: `missing API key${reranker.apiKeyEnv ? ` in ${reranker.apiKeyEnv}` : ""}`,
    };
  }

  const body: Record<string, unknown> = {
    model: reranker.model,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: reranker.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    temperature: 0.1,
    ...(reranker.extraBody ?? {}),
  };
  if (reranker.reasoningEffort) body.reasoning_effort = reranker.reasoningEffort;

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs);
  const onAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(chatCompletionsUrl(reranker.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "pi-adaptive-finder/0.1.0",
        ...(reranker.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: timeoutController.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      return {
        name: reranker.name,
        label: `${reranker.name} (${reranker.model})`,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        picks: [],
        error: payload?.error?.message ?? response.statusText,
      };
    }

    const text = payload?.choices?.[0]?.message?.content ?? "";
    return {
      name: reranker.name,
      label: `${reranker.name} (${reranker.model})`,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      picks: parseModelPicks(text),
      usage: payload?.usage,
    };
  } catch (error) {
    return {
      name: reranker.name,
      label: `${reranker.name} (${reranker.model})`,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      picks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function pathExists(cwd: string, relativePath: string): Promise<boolean> {
  try {
    const absolutePath = path.resolve(cwd, relativePath);
    const root = path.resolve(cwd);
    if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) return false;
    await access(absolutePath);
    const st = await stat(absolutePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function evidenceCitation(candidate: Candidate | undefined): string | undefined {
  if (!candidate || candidate.evidence.length === 0) return undefined;
  const first = candidate.evidence[0];
  const lineMatch = first.match(/^(\d+):/u);
  return lineMatch ? `${candidate.path}:${lineMatch[1]}` : candidate.path;
}

function modelReasonFor(pathValue: string, runs: RerankerRun[]): string | undefined {
  for (const run of runs) {
    const pick = run.picks.find((candidate) => candidate.path === pathValue);
    if (pick?.reason) return pick.reason;
  }
  return undefined;
}

function selectedBy(pathValue: string, runs: RerankerRun[]): string {
  return runs
    .filter((run) => run.picks.some((pick) => pick.path === pathValue))
    .map((run) => run.name)
    .join("+");
}

async function selectPaths(cwd: string, candidates: Candidate[], modelRuns: RerankerRun[], config: FinderConfig): Promise<string[]> {
  const candidateByPath = new Map(candidates.map((candidate, index) => [candidate.path, { candidate, index }]));
  const localTop = candidates.slice(0, Math.max(10, config.maxSelected)).map((candidate) => candidate.path);
  const rawModelPaths = uniq(modelRuns.flatMap((run) => run.picks.map((pick) => pick.path)));
  const candidatePathSet = new Set(candidates.map((candidate) => candidate.path));
  const existingModelPaths = (
    await Promise.all(
      rawModelPaths.map(async (pathValue) =>
        candidatePathSet.has(pathValue) && (await pathExists(cwd, pathValue)) ? pathValue : undefined,
      ),
    )
  ).filter((value): value is string => Boolean(value));

  const scored = new Map<string, number>();
  const addScore = (pathValue: string, score: number) => scored.set(pathValue, (scored.get(pathValue) ?? 0) + score);

  for (const pathValue of localTop) addScore(pathValue, Math.max(0.1, 2 - (candidateByPath.get(pathValue)?.index ?? 0) * 0.12));
  for (const run of modelRuns) {
    for (const [index, pick] of run.picks.entries()) {
      if (!existingModelPaths.includes(pick.path)) continue;
      addScore(pick.path, 4 - index * 0.25 + (pick.confidence ?? 0));
    }
  }
  for (const [pathValue, { candidate }] of candidateByPath.entries()) {
    if (scored.has(pathValue)) addScore(pathValue, Math.min(2, candidate.score / 10));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, config.maxSelected)
    .map(([pathValue]) => pathValue);
}

function formatMarkdown(
  query: string,
  candidates: Candidate[],
  selectedPaths: string[],
  modelRuns: RerankerRun[],
  elapsedMs: number,
): string {
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const successful = modelRuns.filter((run) => run.ok && run.picks.length > 0).map((run) => run.label);
  const failed = modelRuns.filter((run) => !run.ok);

  const lines: string[] = [];
  lines.push("## Summary");
  lines.push(
    `Adaptive Finder used grouped rg/path retrieval plus ${successful.length > 0 ? successful.join(" + ") : "local ranking"}. It selected ${selectedPaths.length} likely file${selectedPaths.length === 1 ? "" : "s"} in ${(elapsedMs / 1000).toFixed(2)}s.`,
  );
  if (failed.length > 0) {
    lines.push(`Fallback note: ${failed.map((run) => `${run.label} failed (${run.error ?? "unknown error"})`).join("; ")}.`);
  }

  lines.push("");
  lines.push("## Locations");
  if (selectedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const selectedPath of selectedPaths) {
      const candidate = candidateByPath.get(selectedPath);
      const citation = evidenceCitation(candidate) ?? selectedPath;
      const pickedBy = selectedBy(selectedPath, modelRuns);
      const reason = modelReasonFor(selectedPath, modelRuns) ?? "high-ranked local candidate";
      const agreement = pickedBy ? `; picked by ${pickedBy}` : "; local candidate";
      lines.push(`- \`${citation}\` - ${reason}${agreement}`);
    }
  }

  lines.push("");
  lines.push("## Evidence");
  const evidenceLines: string[] = [];
  for (const selectedPath of selectedPaths) {
    const candidate = candidateByPath.get(selectedPath);
    if (!candidate) continue;
    const citation = evidenceCitation(candidate) ?? candidate.path;
    const evidence = candidate.evidence[0]?.replace(/^\d+:\s*/u, "");
    evidenceLines.push(
      `- \`${citation}\` - ${evidence ? evidence.slice(0, 180) : `path matched query tokens; local score ${candidate.score.toFixed(1)}`}`,
    );
  }
  lines.push(evidenceLines.length > 0 ? evidenceLines.join("\n") : "(none)");

  lines.push("");
  lines.push("## Searched");
  lines.push(`- Query: ${query.trim()}`);
  lines.push(`- Candidate retrieval: ${candidates.length} grouped files from rg/path scoring.`);
  lines.push(`- Rerankers: ${modelRuns.length > 0 ? modelRuns.map((run) => `${run.label}${run.ok ? "" : " failed"}`).join(", ") : "none, local ranking only"}.`);

  return lines.join("\n");
}

async function runAdaptiveFinder(query: string, ctx: ExtensionContext, signal: AbortSignal | undefined, config: FinderConfig) {
  const startedAt = Date.now();
  const { candidates } = await buildCandidateMap(ctx.cwd, query, config);
  if (candidates.length === 0) {
    const text = "No candidate files found. Adaptive Finder needs ripgrep (`rg`) and a query with concrete terms.";
    return {
      content: [{ type: "text" as const, text }],
      details: {
        status: "error",
        workspace: ctx.cwd,
        mode: "adaptive",
        rerankers: [],
        candidates: 0,
        selected: [],
        elapsedMs: Date.now() - startedAt,
      } satisfies FinderDetails,
      isError: true,
    };
  }

  onProgress(ctx, `Adaptive Finder: ${candidates.length} candidates from rg/path retrieval`);

  const rerankers = await getAvailableRerankers(config);
  const prompt = formatCandidatePrompt(query, candidates, config);
  const modelRuns = await Promise.all(rerankers.map((reranker) => runReranker(reranker, prompt, config, signal)));
  const selectedPaths = await selectPaths(ctx.cwd, candidates, modelRuns, config);
  const elapsedMs = Date.now() - startedAt;
  const markdown = formatMarkdown(query, candidates, selectedPaths, modelRuns, elapsedMs);

  return {
    content: [{ type: "text" as const, text: markdown }],
    details: {
      status: "done",
      workspace: ctx.cwd,
      mode: "adaptive",
      rerankers: modelRuns.map((run) => ({
        name: run.name,
        model: run.label,
        ok: run.ok,
        elapsedMs: run.elapsedMs,
        error: run.error,
        usage: run.usage,
      })),
      candidates: candidates.length,
      selected: selectedPaths,
      elapsedMs,
    } satisfies FinderDetails,
  };
}

function onProgress(ctx: ExtensionContext, message: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("adaptive-finder", message);
}

export default function adaptiveFinderExtension(pi: ExtensionAPI) {
  const config = getConfig();

  pi.registerTool({
    name: config.toolName,
    label: config.toolName === "finder" ? "Finder" : "Adaptive Finder",
    description:
      "Read-only workspace scout for coding and personal-assistant tasks. Uses local rg/path retrieval first, then configurable fast OpenAI-compatible rerankers such as Cerebras or Groq when API keys are available. Give it one broad reconnaissance task and ask for entrypoints, core files, related tests/config/docs, and line-cited anchors.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Describe the end goal for reconnaissance, likely scope, search hints, and the deliverable you want. Example: 'Find where saved views are implemented in Nexus, including hooks, API clients, mocks, and tests.'",
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const rawQuery = (params as { query?: unknown }).query;
      const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Invalid parameters: expected `query` to be a non-empty string." }],
          details: {
            status: "error",
            workspace: ctx.cwd,
            mode: "adaptive",
            rerankers: [],
            candidates: 0,
            selected: [],
            elapsedMs: 0,
          } satisfies FinderDetails,
          isError: true,
        };
      }

      return runAdaptiveFinder(query, ctx, signal, config);
    },
  });

  pi.registerCommand("adaptive-finder", {
    description: "Show pi-adaptive-finder configuration",
    handler: async (_args, ctx) => {
      const rerankers = await getAvailableRerankers(config);
      const lines = [
        `Tool: ${config.toolName}`,
        `Preset: ${config.preset}`,
        `Max candidates: ${config.maxCandidates}`,
        `Max rerankers: ${config.maxRerankers}`,
        `Available rerankers: ${rerankers.length > 0 ? rerankers.map((r) => `${r.name} (${r.model})`).join(", ") : "none, local ranking only"}`,
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      else console.log(lines.join("\n"));
    },
  });
}
