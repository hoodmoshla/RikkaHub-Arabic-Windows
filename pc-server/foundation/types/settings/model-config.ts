export interface ModelConfig {
  favoriteModels: string[];
  chatModelId: string;
  titleModelId: string;
  translateModeId: string;
  suggestionModelId: string;
  imageGenerationModelId: string;
  ocrModelId: string;
  compressModelId: string;
  // 模型 ID,用于对话界面"优化提示词"按钮。空串 = 未配置(按钮会提示去设置页配置)。
  promptOptimizeModelId: string;
  assistantId: string;
}
