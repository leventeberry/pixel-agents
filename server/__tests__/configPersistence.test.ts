import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentIdentity, SettingsLoaded } from '../../core/src/messages.js';
import {
  ADAPTER_SETTING_KEYS,
  clearHooksAnswer,
  clearHooksEnabled,
  DEFAULT_HISTORY_SIZE,
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  MAX_HISTORY_SIZE,
  MAX_TICKET_PATTERN_LENGTH,
  parseAgentDirectorySettings,
  parseAreaMappings,
  readConfig,
  recordHooksDecline,
  resetHooksConfig,
  resolveAgentDirectorySettings,
  setHooksEnabled,
  writeConfig,
} from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';

const AGENT_DIRECTORY_KEYS = [
  'agentRosterPath',
  'agentStatusPath',
  'ticketPattern',
  'ticketLabelCase',
  'historySize',
] as const;

describe('configPersistence: areas', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-config-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── parseAreaMappings ────────────────────────────────────────

  describe('parseAreaMappings', () => {
    it('returns empty object for non-object input (null, undefined, primitives)', () => {
      expect(parseAreaMappings(null)).toEqual({});
      expect(parseAreaMappings(undefined)).toEqual({});
      expect(parseAreaMappings(42)).toEqual({});
      expect(parseAreaMappings('foo')).toEqual({});
      expect(parseAreaMappings(true)).toEqual({});
    });

    it('accepts a valid Record<string, string[]>', () => {
      const input = {
        frontend: ['Engineering'],
        'design-system': ['Engineering', 'Design'],
      };
      expect(parseAreaMappings(input)).toEqual(input);
    });

    it('drops entries whose value is not an array', () => {
      const input = {
        frontend: ['Engineering'],
        bad: 'not-an-array',
        worse: { nested: 'object' },
        broken: 42,
      };
      expect(parseAreaMappings(input)).toEqual({ frontend: ['Engineering'] });
    });

    it('filters non-string entries inside the array', () => {
      const input = {
        frontend: ['Engineering', 42, null, 'Platform', { x: 1 }],
      };
      expect(parseAreaMappings(input)).toEqual({
        frontend: ['Engineering', 'Platform'],
      });
    });

    it('handles a mixed valid/malformed payload by retaining only the valid keys', () => {
      const input = {
        frontend: ['Engineering'],
        backend: ['Platform', 'SRE'],
        bogus_value: 12345,
        bogus_array: ['ok', false, 'also-ok'],
      };
      expect(parseAreaMappings(input)).toEqual({
        frontend: ['Engineering'],
        backend: ['Platform', 'SRE'],
        bogus_array: ['ok', 'also-ok'],
      });
    });

    it('preserves empty arrays as a deliberate "folder has no preferred area" signal', () => {
      const input = { frontend: [] };
      expect(parseAreaMappings(input)).toEqual({ frontend: [] });
    });
  });

  // ── per-provider hooks consent + preference ──────────────────

  describe('hooksConsent / hooksEnabled maps', () => {
    it('defaults to unanswered/enabled when the config file is missing or predates the maps', () => {
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      writeConfig(readConfig()); // full config on disk...
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      delete raw.hooksConsent; // ...from an older shape
      delete raw.hooksEnabled;
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify(raw, null, 2),
      );
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
    });

    it('drops junk values from hand-edited maps instead of crashing or trusting them', () => {
      fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify({
          hooksConsent: { claude: 'GRANTED', other: 'declined', junk: 42 },
          hooksEnabled: { claude: 'yes', other: false },
        }),
      );
      // Only exact values survive; everything else degrades to the default.
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksConsent('other')).toBe('declined');
      expect(getHooksConsent('junk')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      expect(getHooksEnabled('other')).toBe(false);
    });

    it('grantHooksConsent persists per provider and is idempotent', () => {
      grantHooksConsent('claude');
      expect(getHooksConsent('claude')).toBe('granted');
      expect(getHooksConsent('other')).toBe('unanswered');
      grantHooksConsent('claude');
      expect(getHooksConsent('claude')).toBe('granted');
    });

    it('recordHooksDecline writes consent + preference in ONE cycle; clearHooksAnswer undoes both', () => {
      grantHooksConsent('claude');
      recordHooksDecline('claude');
      expect(getHooksConsent('claude')).toBe('declined');
      expect(getHooksEnabled('claude')).toBe(false);
      clearHooksAnswer('claude');
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      // Both keys are genuinely gone — "never answered" and "answered and
      // reverted" must be indistinguishable on disk.
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      expect('claude' in (raw.hooksConsent ?? {})).toBe(false);
      expect('claude' in (raw.hooksEnabled ?? {})).toBe(false);
    });

    // Review finding I1 (sol): never→install(fails)→notNow stranded the ask.
    // Install is an absolute state command, so a grant REPLACING a decline
    // deletes the decline's hooks-off remnant in the same write — a failed
    // install then leaves granted + default-enabled, which a later notNow
    // revert fully takes back (the ask returns).
    it('a grant replacing a decline clears the decline preference remnant', () => {
      recordHooksDecline('claude');
      expect(getHooksEnabled('claude')).toBe(false);
      grantHooksConsent('claude');
      expect(getHooksConsent('claude')).toBe('granted');
      expect(getHooksEnabled('claude')).toBe(true);
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      expect('claude' in (raw.hooksEnabled ?? {})).toBe(false);
    });

    // A grant must NOT clobber a Settings toggle-off: the preference delete is
    // scoped to replacing a DECLINE, whose hooks-off was the answer's write.
    it('a repeat grant leaves a toggle-written preference alone', () => {
      grantHooksConsent('claude');
      setHooksEnabled('claude', false); // the Settings toggle, not an answer
      grantHooksConsent('claude'); // idempotent repeat
      expect(getHooksEnabled('claude')).toBe(false);
    });

    it('clearHooksEnabled removes the key so the default (true) applies again', () => {
      setHooksEnabled('claude', false);
      expect(getHooksEnabled('claude')).toBe(false);
      clearHooksEnabled('claude');
      expect(getHooksEnabled('claude')).toBe(true);
      // The key is genuinely gone, not written back as true: "never answered"
      // and "answered and reverted" must be indistinguishable on disk.
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      expect('claude' in (raw.hooksEnabled ?? {})).toBe(false);
    });

    it('resetHooksConfig returns all hooks choices to factory state (uninstall → ask again)', () => {
      grantHooksConsent('claude');
      recordHooksDecline('other');
      setHooksEnabled('claude', false); // a persisted "off" must not survive uninstall,
      setHooksEnabled('other', false); // or the next install never prompts
      const cfg = readConfig();
      cfg.vscode.hooksInfoShown = true;
      cfg.standalone.hooksInfoShown = true;
      writeConfig(cfg);

      resetHooksConfig();

      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksConsent('other')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      expect(getHooksEnabled('other')).toBe(true);
      const reset = readConfig();
      expect(reset.vscode.hooksInfoShown).toBe(false);
      expect(reset.standalone.hooksInfoShown).toBe(false);
    });
  });

  // ── readConfig / writeConfig round-trip ──────────────────────

  describe('readConfig + writeConfig round-trip for area settings', () => {
    it('returns defaults (showAreas=false, areaMappings={}) when no config file exists', () => {
      const cfg = readConfig();
      expect(cfg.vscode.showAreas).toBe(false);
      expect(cfg.vscode.areaMappings).toEqual({});
      expect(cfg.standalone.showAreas).toBe(false);
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('round-trips showAreas + areaMappings per-namespace independently', () => {
      const cfg = readConfig();
      cfg.vscode.showAreas = true;
      cfg.vscode.areaMappings = { frontend: ['Engineering'] };
      cfg.standalone.showAreas = false;
      cfg.standalone.areaMappings = { backend: ['Platform'] };
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.vscode.showAreas).toBe(true);
      expect(reloaded.vscode.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(reloaded.standalone.showAreas).toBe(false);
      expect(reloaded.standalone.areaMappings).toEqual({ backend: ['Platform'] });
    });

    it('coerces a hand-edited config.json with malformed areaMappings into defaults', () => {
      const configDir = path.join(tempHome, '.pixel-agents');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          vscode: { showAreas: 'yes please', areaMappings: 'not-an-object' },
          standalone: { showAreas: true, areaMappings: { frontend: 'broken' } },
        }),
        'utf-8',
      );

      const cfg = readConfig();
      // showAreas: 'yes please' is not a boolean → default false
      expect(cfg.vscode.showAreas).toBe(false);
      expect(cfg.vscode.areaMappings).toEqual({});
      // showAreas: true is valid; areaMappings.frontend: 'broken' is not an array → dropped
      expect(cfg.standalone.showAreas).toBe(true);
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('keeps namespaces isolated when only one writes mappings', () => {
      const cfg = readConfig();
      cfg.vscode.areaMappings = { frontend: ['Engineering'] };
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.vscode.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(reloaded.standalone.areaMappings).toEqual({});
    });
  });

  // ── Agent-directory settings (config.json only) ──────────────

  describe('agent-directory settings', () => {
    const configFile = (): string => path.join(tempHome, '.pixel-agents', 'config.json');
    const writeRaw = (obj: unknown): void => {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true });
      fs.writeFileSync(configFile(), JSON.stringify(obj), 'utf-8');
    };

    it('no settings: no key appears after a read → write cycle (no-settings regression)', () => {
      writeConfig(readConfig());
      const onDisk = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
      for (const key of AGENT_DIRECTORY_KEYS) {
        expect(onDisk.standalone).not.toHaveProperty(key);
        expect(onDisk.vscode).not.toHaveProperty(key);
      }
    });

    it('hand-set values survive another setting being written', () => {
      const settings = {
        agentRosterPath: '/org/roster.json',
        agentStatusPath: '/org/agent-status.json',
        ticketPattern: 'bb-\\d+',
        ticketLabelCase: 'upper',
        historySize: 50,
      };
      writeRaw({ standalone: settings });
      setHooksEnabled('claude', false);
      expect(readConfig().standalone).toMatchObject(settings);
    });

    it('drops wrong-typed and empty values and clamps historySize', () => {
      expect(
        parseAgentDirectorySettings({
          agentRosterPath: 42,
          agentStatusPath: '',
          ticketPattern: ['bb'],
          ticketLabelCase: 'lower',
          historySize: 1000,
        }),
      ).toEqual({ historySize: MAX_HISTORY_SIZE });
      expect(parseAgentDirectorySettings({ historySize: 0 })).toEqual({ historySize: 1 });
      expect(parseAgentDirectorySettings({ historySize: 2.5 })).toEqual({});
      expect(parseAgentDirectorySettings({ historySize: '50' })).toEqual({});
      expect(parseAgentDirectorySettings(null)).toEqual({});
      expect(parseAgentDirectorySettings([])).toEqual({});
    });

    it('is not client-writable: excluded from ADAPTER_SETTING_KEYS and ignored by setSetting', () => {
      for (const key of AGENT_DIRECTORY_KEYS) {
        expect(ADAPTER_SETTING_KEYS as readonly string[]).not.toContain(key);
      }
      const adapter = new FileStateAdapter({ namespace: 'standalone' });
      adapter.setSetting('pixel-agents.agentRosterPath', '/evil.json');
      adapter.setSetting('agentStatusPath', '/evil.json');
      expect(readConfig().standalone.agentRosterPath).toBeUndefined();
      expect(readConfig().standalone.agentStatusPath).toBeUndefined();
    });

    it('the protocol has no set* client message for these settings', () => {
      const yaml = fs.readFileSync(path.join(__dirname, '../../core/asyncapi.yaml'), 'utf-8');
      expect(yaml).not.toMatch(
        /set(AgentRosterPath|AgentStatusPath|TicketPattern|TicketLabelCase|HistorySize)/i,
      );
    });

    it('settingsLoaded carries no ticket keys: the server derives agentIdentity.ticket', () => {
      const yaml = fs.readFileSync(path.join(__dirname, '../../core/asyncapi.yaml'), 'utf-8');
      const settingsLoaded = yaml.match(/\n {4}SettingsLoaded:\n[\s\S]*?(?=\n {4}\S)/)?.[0];
      expect(settingsLoaded).toBeDefined();
      expect(settingsLoaded).not.toMatch(/ticket/i);
      expect(settingsLoaded).toMatch(/\n {8}historySize:/);
      const agentIdentity = yaml.match(/\n {4}AgentIdentity:\n[\s\S]*?(?=\n {4}\S)/)?.[0];
      expect(agentIdentity).toMatch(/\n {8}ticket:\n {10}type: string\n {10}maxLength: 32\n/);

      // Compile-time half (checked by `tsc -p server/tsconfig.test.json`): the generated types agree.
      const noTicketKeys: Extract<keyof SettingsLoaded, `ticket${string}`> extends never
        ? true
        : false = true;
      const identity: AgentIdentity = { type: 'agentIdentity', id: 1, ticket: 'BB-42' };
      expect(noTicketKeys).toBe(true);
      expect(identity.ticket).toBe('BB-42');
    });

    it('resolves defaults when nothing is set', () => {
      expect(resolveAgentDirectorySettings({})).toEqual({
        agentRosterPath: null,
        agentStatusPath: null,
        ticketPattern: null,
        ticketLabelCase: 'upper',
        historySize: DEFAULT_HISTORY_SIZE,
      });
    });

    it('turns off relative paths and unusable ticket patterns instead of throwing', () => {
      const resolved = resolveAgentDirectorySettings({
        agentRosterPath: 'roster.json',
        agentStatusPath: '../status.json',
        ticketPattern: 'bb-(\\d+',
      });
      expect(resolved.agentRosterPath).toBeNull();
      expect(resolved.agentStatusPath).toBeNull();
      expect(resolved.ticketPattern).toBeNull();
      expect(
        resolveAgentDirectorySettings({ ticketPattern: 'a'.repeat(MAX_TICKET_PATTERN_LENGTH + 1) })
          .ticketPattern,
      ).toBeNull();
    });

    it('passes valid values through', () => {
      expect(
        resolveAgentDirectorySettings({
          agentRosterPath: '/org/roster.json',
          agentStatusPath: '/org/agent-status.json',
          ticketPattern: 'bb-\\d+',
          ticketLabelCase: 'asis',
          historySize: 120,
        }),
      ).toEqual({
        agentRosterPath: '/org/roster.json',
        agentStatusPath: '/org/agent-status.json',
        ticketPattern: 'bb-\\d+',
        ticketLabelCase: 'asis',
        historySize: 120,
      });
    });
  });
});
