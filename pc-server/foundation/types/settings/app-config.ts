import type { JsonValue } from "..";

export interface AppConfig {
  dynamicColor: boolean;
  themeId: string;
  developerMode: boolean;
  displaySetting: Record<string, JsonValue>;
  preferredPort: number | null;
  keybindings: Record<string, JsonValue>;
  webServerJwtEnabled: boolean;
}
