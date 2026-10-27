import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';

/** How the server shows a ticket ID it matched in a branch (`upper` gives "BB-40", `asis` keeps the matched text).
 *  Server-only: clients receive the finished label in `agentIdentity.ticket`, never the pattern or the case. */
export type TicketLabelCase = 'upper' | 'asis';

/** Optional agent-directory settings (roster, declared status, ticket label, activity history). They are hand-set in
 *  config.json and READ-ONLY to the app: they are deliberately absent from ADAPTER_SETTING_KEYS, so
 *  FileStateAdapter.setSetting ignores them and no client message can write them. Every key absent = the feature is
 *  off and the app behaves exactly as without it. The parse keeps them only type-checked (so the readConfig →
 *  writeConfig cycle of every other setting round-trips them untouched); resolveAgentDirectorySettings applies the
 *  semantic checks and defaults at use. */
export interface AgentDirectorySettings {
  /** Absolute path to the roster JSON (handle → {name, department, title, supervisor, tier}). */
  agentRosterPath?: string;
  /** Absolute path to the declared-status JSON (handle → {state, ticket?, reason?, updatedAt}). */
  agentStatusPath?: string;
  /** Regex that finds a ticket ID in an agent's git branch, e.g. `bb-\d+`. */
  ticketPattern?: string;
  ticketLabelCase?: TicketLabelCase;
  /** Activity-history entries kept per agent. */
  historySize?: number;
}

export interface AdapterSettings extends AgentDirectorySettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
}

/** All client-writable keys in AdapterSettings. Used by adapters to map `pixel-agents.foo` → `foo`.
 *  The hooks preference is NOT here: it is per-provider and machine-global
 *  (the hooks it governs live in one home-directory file per provider), so it
 *  lives beside `hooksConsent` at the config top level, not per namespace.
 *  The AgentDirectorySettings keys are NOT here either: they are config.json-only. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'ghostHeadlessAgents',
  'watchAllSessions',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Namespaces = adapter identities sharing the same config.json file. */
export type ConfigNamespace = 'vscode' | 'standalone';

/** What the user answered a provider's consent ask with, durably. `granted` is recorded BEFORE the install writes, so
 *  it can exist with nothing on disk; `declined` means the ANSWER itself turned hooks off, the provenance a revised
 *  "Not Now" needs to know the preference is its to take back (a Settings toggle never records consent). Absent =
 *  unanswered, the ask is still open. */
export type HooksConsentState = 'granted' | 'declined';

export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  /** Per-provider consent to modify that provider's settings file (Claude:
   *  ~/.claude/settings.json). Shared across surfaces — consent is per-human
   *  per-provider, not per-adapter. A provider absent from the map has never
   *  been answered. */
  hooksConsent: Record<string, HooksConsentState>;
  /** Per-provider hooks preference, machine-global for the same reason as the
   *  consent above. A provider absent from the map takes the default (true). */
  hooksEnabled: Record<string, boolean>;
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/** Coerce a loose object into the per-provider consent map, dropping entries whose value is not exactly 'granted' or
 *  'declined'. */
function parseHooksConsent(raw: unknown): Record<string, HooksConsentState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HooksConsentState> = {};
  for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
    if (state === 'granted' || state === 'declined') out[providerId] = state;
  }
  return out;
}

/** Coerce a loose object into the per-provider hooks-preference map, dropping non-boolean values. */
function parseHooksEnabled(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [providerId, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') out[providerId] = enabled;
  }
  return out;
}

/**
 * Coerce a loose object into `Record<string, string[]>`, dropping any entries whose value is not an array of strings.
 * Returns `{}` if the input isn't an object. Used to defensively load folder→area mappings from config.json, which
 * may have been hand-edited or written by an older build.
 */
export function parseAreaMappings(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [folder, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof folder !== 'string') {
      continue;
    }
    if (!Array.isArray(labels)) {
      continue;
    }
    const filtered = labels.filter((l): l is string => typeof l === 'string');
    out[folder] = filtered;
  }
  return out;
}

export const DEFAULT_HISTORY_SIZE = 50;
export const MAX_HISTORY_SIZE = 200;
/** Longest ticketPattern accepted; a longer one disables ticket matching. This caps pattern length only and does not
 *  prevent catastrophic backtracking: the bound on matching cost is that the pattern runs (server-side only) against a
 *  gitBranch of at most 128 characters, and the pattern itself comes from the owner's config.json. */
export const MAX_TICKET_PATTERN_LENGTH = 200;

/** Coerce the agent-directory keys of a loose namespace object, dropping wrong-typed values. Only keys that hold a
 *  usable type are set, so a config without them parses (and re-writes) without them. */
export function parseAgentDirectorySettings(raw: unknown): AgentDirectorySettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: AgentDirectorySettings = {};
  if (typeof obj.agentRosterPath === 'string' && obj.agentRosterPath !== '') {
    out.agentRosterPath = obj.agentRosterPath;
  }
  if (typeof obj.agentStatusPath === 'string' && obj.agentStatusPath !== '') {
    out.agentStatusPath = obj.agentStatusPath;
  }
  if (typeof obj.ticketPattern === 'string' && obj.ticketPattern !== '') {
    out.ticketPattern = obj.ticketPattern;
  }
  if (obj.ticketLabelCase === 'upper' || obj.ticketLabelCase === 'asis') {
    out.ticketLabelCase = obj.ticketLabelCase;
  }
  if (typeof obj.historySize === 'number' && Number.isInteger(obj.historySize)) {
    out.historySize = Math.min(MAX_HISTORY_SIZE, Math.max(1, obj.historySize));
  }
  return out;
}

/** The agent-directory settings as the runtime uses them: defaults applied, and anything unsafe or unusable turned
 *  off rather than thrown. A non-absolute path is null (paths are never resolved against the cwd); a ticketPattern
 *  that is too long or does not compile is null (no ticket matching). */
export interface ResolvedAgentDirectorySettings {
  agentRosterPath: string | null;
  agentStatusPath: string | null;
  ticketPattern: string | null;
  ticketLabelCase: TicketLabelCase;
  historySize: number;
}

export function resolveAgentDirectorySettings(
  settings: AgentDirectorySettings,
): ResolvedAgentDirectorySettings {
  const absolute = (p: string | undefined): string | null =>
    p !== undefined && path.isAbsolute(p) ? p : null;
  return {
    agentRosterPath: absolute(settings.agentRosterPath),
    agentStatusPath: absolute(settings.agentStatusPath),
    ticketPattern: compilableTicketPattern(settings.ticketPattern),
    ticketLabelCase: settings.ticketLabelCase ?? 'upper',
    historySize: settings.historySize ?? DEFAULT_HISTORY_SIZE,
  };
}

function compilableTicketPattern(pattern: string | undefined): string | null {
  if (pattern === undefined || pattern.length > MAX_TICKET_PATTERN_LENGTH) return null;
  try {
    new RegExp(pattern);
    return pattern;
  } catch {
    return null;
  }
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    ghostHeadlessAgents:
      typeof obj.ghostHeadlessAgents === 'boolean'
        ? obj.ghostHeadlessAgents
        : DEFAULT_ADAPTER_SETTINGS.ghostHeadlessAgents,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
    ...parseAgentDirectorySettings(obj),
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        vscode: { ...DEFAULT_ADAPTER_SETTINGS },
        standalone: { ...DEFAULT_ADAPTER_SETTINGS },
        externalAssetDirectories: [],
        hooksConsent: {},
        hooksEnabled: {},
      };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      hooksConsent: parseHooksConsent(parsed.hooksConsent),
      hooksEnabled: parseHooksEnabled(parsed.hooksEnabled),
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return {
      vscode: { ...DEFAULT_ADAPTER_SETTINGS },
      standalone: { ...DEFAULT_ADAPTER_SETTINGS },
      externalAssetDirectories: [],
      hooksConsent: {},
      hooksEnabled: {},
    };
  }
}

// ── Per-provider hooks consent + preference ─────────────────
// The provider id keys these maps (HookProvider.id — 'claude' today). All
// writers go through readConfig→writeConfig, so a hand-edited or older file
// degrades to "unanswered"/default rather than crashing.

/** What the user durably answered this provider's ask with, or 'unanswered'. */
export function getHooksConsent(providerId: string): HooksConsentState | 'unanswered' {
  return readConfig().hooksConsent[providerId] ?? 'unanswered';
}

/** Persist the one-time approval for modifying this provider's settings file. A grant REPLACING a decline also
 *  deletes that decline's hooks-off remnant in the same write: without it, an install that then FAILS leaves a grant
 *  beside the retracted hooks-off, and a later "Not Now" (which leaves the preference alone, since the grant never
 *  wrote it) ends at unanswered + hooks-off — an ask that never returns. A successful install persists hooks-on
 *  anyway, so this only changes the failure path. */
export function grantHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'granted') {
    const replacingDecline = cfg.hooksConsent[providerId] === 'declined';
    cfg.hooksConsent[providerId] = 'granted';
    if (replacingDecline) delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Record a durable decline ("Don't Ask Again"): consent 'declined' AND hooks-off, in ONE readConfig→writeConfig
 *  cycle. They are one logical answer — split across two writes, a failed second leaves a state the answer disavows
 *  (a decline with the default-on preference, or a hooks-off with no provenance). */
export function recordHooksDecline(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'declined' || cfg.hooksEnabled[providerId] !== false) {
    cfg.hooksConsent[providerId] = 'declined';
    cfg.hooksEnabled[providerId] = false;
    writeConfig(cfg);
  }
}

/** Un-record an answer AND restore the preference default in ONE cycle — the revised-notNow revert over a decline.
 *  Both keys go together so "never answered" and "answered and reverted" are indistinguishable on disk, and no
 *  partial-write order can leave a half-reverted answer. */
export function clearHooksAnswer(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent || providerId in cfg.hooksEnabled) {
    delete cfg.hooksConsent[providerId];
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Un-record an answer entirely, so the ask genuinely returns. Used when the
 *  user walks the Intro back from its closing step and revises an earlier
 *  answer down to "Not Now": whatever that answer left (a grant, a decline)
 *  must go, or the consent gate reads it as asked-and-answered forever.
 *  Callers only clear a grant after any uninstall verifiably landed. */
export function clearHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent) {
    delete cfg.hooksConsent[providerId];
    writeConfig(cfg);
  }
}

/** The per-provider hooks preference. Absent = the default, true. */
export function getHooksEnabled(providerId: string): boolean {
  return readConfig().hooksEnabled[providerId] ?? true;
}

export function setHooksEnabled(providerId: string, enabled: boolean): void {
  const cfg = readConfig();
  if (cfg.hooksEnabled[providerId] !== enabled) {
    cfg.hooksEnabled[providerId] = enabled;
    writeConfig(cfg);
  }
}

/** Restore the provider's preference to its default (true) by REMOVING the key. Deleting rather than writing `true`
 *  keeps "never answered" and "answered and reverted" indistinguishable on disk. */
export function clearHooksEnabled(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksEnabled) {
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Called on extension uninstall: return every hooks-related choice to factory state — all providers' consent and
 *  preferences cleared, hooksInfoShown back to default in both namespaces. Those choices belonged to an installation
 *  that no longer exists, so a future install starts from the first-run experience rather than inheriting a stale
 *  hooks-off that would skip the ask forever. */
export function resetHooksConfig(): void {
  const cfg = readConfig();
  cfg.hooksConsent = {};
  cfg.hooksEnabled = {};
  for (const ns of ['vscode', 'standalone'] as const) {
    cfg[ns].hooksInfoShown = DEFAULT_ADAPTER_SETTINGS.hooksInfoShown;
  }
  writeConfig(cfg);
}

export function writeConfig(config: PixelAgentsConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}
