import { clampThinkingLevel, getSupportedThinkingLevels, } from "@earendil-works/pi-ai";
export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
export function isThinkingLevel(value) {
    return THINKING_LEVELS.includes(value);
}
export class RuntimeResolutionError extends Error {
    constructor(message) {
        super(message);
        this.name = "RuntimeResolutionError";
    }
}
export function parseExactModelRef(reference) {
    const trimmed = reference.trim();
    const separator = trimmed.indexOf("/");
    if (separator <= 0 || separator === trimmed.length - 1)
        return undefined;
    const provider = trimmed.slice(0, separator).trim();
    const modelId = trimmed.slice(separator + 1).trim();
    return provider && modelId ? { provider, modelId } : undefined;
}
function toRoutingModel(value) {
    if (!value || typeof value.provider !== "string" || typeof value.id !== "string") {
        return undefined;
    }
    return {
        provider: value.provider,
        id: value.id,
        reasoning: value.reasoning ?? false,
        thinkingLevelMap: value.thinkingLevelMap,
        input: Array.isArray(value.input) ? value.input : undefined,
        contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
        maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : undefined,
        cost: value.cost,
    };
}
export function wrapPiModelRegistry(registry) {
    return {
        find(provider, modelId) {
            return toRoutingModel(registry.find(provider, modelId));
        },
        available() {
            const direct = registry.getAvailable?.() ?? [];
            const source = direct.length > 0 ? direct : registry.getAll?.() ?? [];
            const models = [];
            const seen = new Set();
            for (const raw of source) {
                const candidate = toRoutingModel(raw);
                if (!candidate)
                    continue;
                if (direct.length === 0 && registry.hasConfiguredAuth && !registry.hasConfiguredAuth(raw))
                    continue;
                const ref = `${candidate.provider}/${candidate.id}`;
                if (seen.has(ref))
                    continue;
                seen.add(ref);
                models.push(candidate);
            }
            return models;
        },
        hasConfiguredAuth(model) {
            if (!registry.hasConfiguredAuth) {
                return (registry.getAvailable?.() ?? []).some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
            }
            const original = registry.find(model.provider, model.id);
            return !!original && registry.hasConfiguredAuth(original);
        },
    };
}
function asPiModel(model) {
    return {
        provider: model.provider,
        id: model.id,
        name: model.id,
        api: "openai-completions",
        baseUrl: "",
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: (model.input?.filter((entry) => entry === "text" || entry === "image") ?? ["text"]),
        contextWindow: model.contextWindow ?? 0,
        maxTokens: model.maxTokens ?? 0,
        cost: {
            input: model.cost?.input ?? 0,
            output: model.cost?.output ?? 0,
            cacheRead: model.cost?.cacheRead ?? 0,
            cacheWrite: model.cost?.cacheWrite ?? 0,
        },
    };
}
function formatSupported(model) {
    const levels = getSupportedThinkingLevels(asPiModel(model));
    return levels.length > 0 ? levels.join(", ") : "(none)";
}
/** Resolve a subagent runtime from role frontmatter, then the parent runtime. */
export function resolveRuntimePlan(role, parent, registry) {
    let provider = parent.provider;
    let modelId = parent.modelId;
    let selectedModel = registry.find(provider, modelId);
    const modelSource = role.model ? "agent" : "parent";
    if (role.model) {
        const parsed = parseExactModelRef(role.model);
        if (!parsed || role.model !== `${parsed.provider}/${parsed.modelId}`) {
            throw new RuntimeResolutionError(`role model ${JSON.stringify(role.model)} must be one exact authenticated provider/model-id`);
        }
        const found = registry.find(parsed.provider, parsed.modelId);
        if (!found)
            throw new RuntimeResolutionError(`unknown role model ${JSON.stringify(role.model)}`);
        if (!registry.hasConfiguredAuth(found)) {
            throw new RuntimeResolutionError(`role model ${JSON.stringify(role.model)} has no configured authentication`);
        }
        provider = found.provider;
        modelId = found.id;
        selectedModel = found;
    }
    const thinkingSource = role.thinking ? "agent" : "parent";
    const preferredThinking = role.thinking ?? parent.thinking;
    let thinking = preferredThinking;
    let thinkingAdjustment;
    if (role.thinking) {
        if (!selectedModel) {
            throw new RuntimeResolutionError("model capability information is unavailable; cannot validate role thinking");
        }
        const supported = getSupportedThinkingLevels(asPiModel(selectedModel));
        if (!supported.includes(preferredThinking)) {
            throw new RuntimeResolutionError(`role thinking ${JSON.stringify(preferredThinking)} is not supported by ${JSON.stringify(`${provider}/${modelId}`)}; supported: ${formatSupported(selectedModel)}`);
        }
    }
    else if (selectedModel) {
        thinking = clampThinkingLevel(asPiModel(selectedModel), preferredThinking);
        if (thinking !== preferredThinking) {
            thinkingAdjustment = {
                from: preferredThinking,
                to: thinking,
                reason: selectedModel.reasoning ? "inherited-clamp" : "non-reasoning",
            };
        }
    }
    return {
        provider,
        modelId,
        model: `${provider}/${modelId}`,
        thinking,
        modelSource,
        thinkingSource,
        ...(thinkingAdjustment ? { thinkingAdjustment } : {}),
    };
}
