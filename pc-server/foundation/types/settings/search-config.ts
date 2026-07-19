import type { JsonValue } from "..";

export interface SearchConfig {
  enableWebSearch: boolean;
  searchServices: JsonValue[];
  searchCommonOptions: Record<string, JsonValue>;
  searchServiceSelected: number;
}
