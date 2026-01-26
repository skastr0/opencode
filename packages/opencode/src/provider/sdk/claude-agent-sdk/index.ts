import { NoSuchModelError } from "ai"
import { ClaudeAgentSDKLanguageModel } from "./claude-agent-sdk-model"
import { ClaudeAgentSDKSessionStore } from "./session-store"
import { CLAUDE_AGENT_SDK_MODELS } from "./models"

export function createClaudeAgentSDK(settings: { sessionStore?: ClaudeAgentSDKSessionStore } = {}) {
  const sessionStore = settings.sessionStore ?? new ClaudeAgentSDKSessionStore()

  const languageModel = (modelId: string) => new ClaudeAgentSDKLanguageModel(modelId, sessionStore)
  const textEmbeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: "textEmbeddingModel" })
  }
  const imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: "imageModel" })
  }

  return {
    languageModel,
    textEmbeddingModel,
    imageModel,
  }
}

export { CLAUDE_AGENT_SDK_MODELS, ClaudeAgentSDKSessionStore }
