import {
  parsePositionExitSettings,
  type PositionExitSettings,
} from './position-exit-settings.js';
import type { EffectivePositionExitSettings } from './position-exit.types.js';

export interface PositionExitSettingsStore {
  getSettings(): Promise<EffectivePositionExitSettings | null>;
  saveSettings(
    value: PositionExitSettings,
    expectedRevision: number,
    source: 'DASHBOARD',
  ): Promise<EffectivePositionExitSettings>;
  resetSettings(
    expectedRevision: number,
    defaults: PositionExitSettings,
  ): Promise<EffectivePositionExitSettings>;
}

function frozenSnapshot(
  value: EffectivePositionExitSettings,
): EffectivePositionExitSettings {
  return Object.freeze({
    ...value,
    settings: parsePositionExitSettings(value.settings),
  });
}

export class PositionExitSettingsProvider {
  constructor(
    private readonly repository: PositionExitSettingsStore,
    private readonly defaults: Readonly<PositionExitSettings>,
  ) {}

  async get(): Promise<EffectivePositionExitSettings> {
    const persisted = await this.repository.getSettings();
    return persisted
      ? frozenSnapshot(persisted)
      : frozenSnapshot({
          settings: parsePositionExitSettings(this.defaults),
          revision: 0,
          source: 'ENV',
          updatedAt: null,
        });
  }

  async update(
    value: PositionExitSettings,
    expectedRevision: number,
  ): Promise<EffectivePositionExitSettings> {
    const committed = await this.repository.saveSettings(
      parsePositionExitSettings(value),
      expectedRevision,
      'DASHBOARD',
    );
    return frozenSnapshot(committed);
  }

  async reset(expectedRevision: number): Promise<EffectivePositionExitSettings> {
    const committed = await this.repository.resetSettings(
      expectedRevision,
      parsePositionExitSettings(this.defaults),
    );
    return frozenSnapshot(committed);
  }
}
