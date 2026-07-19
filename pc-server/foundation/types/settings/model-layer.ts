import type { Provider, Assistant, JsonValue } from "..";

export interface ModelLayerConfig {
  providers: Provider[];
  assistants: Assistant[];
  assistantTags: JsonValue[];
}
