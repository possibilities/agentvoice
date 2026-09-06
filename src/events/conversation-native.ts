// Generated from stock Codex 0.153.4 by scripts/generate-conversation-native.ts.

// Objects project known fields. Opaque tool JSON is bounded and scrubbed before publication.

import { z } from "zod";

export const ByteRangeSchema = z.object({
  end: z.number().int().safe(),
  start: z.number().int().safe(),
});

export const TextElementSchema = z.object({
  byteRange: ByteRangeSchema,
  placeholder: z.union([z.string().max(262144), z.null()]).optional(),
});

export const ImageDetailSchema = z.union([
  z.literal("auto"),
  z.literal("low"),
  z.literal("high"),
  z.literal("original"),
]);

export const UserInputSchema = z.union([
  z.object({
    text: z.string().max(262144),
    text_elements: z.array(TextElementSchema).max(1024).optional(),
    type: z.literal("text"),
  }),
  z.object({
    detail: z.union([ImageDetailSchema, z.null()]).optional(),
    type: z.literal("image"),
    url: z.string().max(262144),
  }),
  z.object({
    detail: z.union([ImageDetailSchema, z.null()]).optional(),
    path: z.string().max(262144),
    type: z.literal("localImage"),
  }),
  z.object({ type: z.literal("audio"), url: z.string().max(262144) }),
  z.object({ path: z.string().max(262144), type: z.literal("localAudio") }),
  z.object({
    name: z.string().max(262144),
    path: z.string().max(262144),
    type: z.literal("skill"),
  }),
  z.object({
    name: z.string().max(262144),
    path: z.string().max(262144),
    type: z.literal("mention"),
  }),
]);

export const HookPromptFragmentSchema = z.object({
  hookRunId: z.string().max(262144),
  text: z.string().max(262144),
});

export const AgentMessageDeliverySchema = z.literal("async");

export const MemoryCitationEntrySchema = z.object({
  lineEnd: z.number().int().safe(),
  lineStart: z.number().int().safe(),
  note: z.string().max(262144),
  path: z.string().max(262144),
});

export const MemoryCitationSchema = z.object({
  entries: z.array(MemoryCitationEntrySchema).max(1024),
  threadIds: z.array(z.string().max(262144)).max(1024),
});

export const MessagePhaseSchema = z.union([z.literal("commentary"), z.literal("final_answer")]);

export const AsyncUserInputQuestionSchema = z.object({
  options: z.union([z.array(z.string().max(262144)).max(1024), z.null()]).optional(),
  title: z.string().max(262144),
});

export const FunctionCallOutputContentItemSchema = z.union([
  z.object({ text: z.string().max(262144), type: z.literal("input_text") }),
  z.object({
    detail: z.union([ImageDetailSchema, z.null()]).optional(),
    image_url: z.string().max(262144),
    type: z.literal("input_image"),
  }),
  z.object({ audio_url: z.string().max(262144), type: z.literal("input_audio") }),
  z.object({ encrypted_content: z.string().max(262144), type: z.literal("encrypted_content") }),
]);

export const FunctionCallOutputBodySchema = z.union([
  z.string().max(262144),
  z.array(FunctionCallOutputContentItemSchema).max(1024),
]);

export const LegacyAppPathStringSchema = z.string().max(262144);

export const CommandActionSchema = z.union([
  z.object({
    command: z.string().max(262144),
    name: z.string().max(262144),
    path: LegacyAppPathStringSchema,
    type: z.literal("read"),
  }),
  z.object({
    command: z.string().max(262144),
    path: z.union([z.string().max(262144), z.null()]).optional(),
    type: z.literal("listFiles"),
  }),
  z.object({
    command: z.string().max(262144),
    path: z.union([z.string().max(262144), z.null()]).optional(),
    query: z.union([z.string().max(262144), z.null()]).optional(),
    type: z.literal("search"),
  }),
  z.object({ command: z.string().max(262144), type: z.literal("unknown") }),
]);

export const CommandExecutionSourceSchema = z.union([
  z.literal("agent"),
  z.literal("userShell"),
  z.literal("unifiedExecStartup"),
  z.literal("unifiedExecInteraction"),
]);

export const CommandExecutionStatusSchema = z.union([
  z.literal("inProgress"),
  z.literal("completed"),
  z.literal("failed"),
  z.literal("declined"),
]);

export const PatchChangeKindSchema = z.union([
  z.object({ type: z.literal("add") }),
  z.object({ type: z.literal("delete") }),
  z.object({
    move_path: z.union([z.string().max(262144), z.null()]).optional(),
    type: z.literal("update"),
  }),
]);

export const FileUpdateChangeSchema = z.object({
  diff: z.string().max(262144),
  kind: PatchChangeKindSchema,
  path: z.string().max(262144),
});

export const PatchApplyStatusSchema = z.union([
  z.literal("inProgress"),
  z.literal("completed"),
  z.literal("failed"),
  z.literal("declined"),
]);

export const McpToolCallAppContextSchema = z.object({
  actionName: z.union([z.string().max(262144), z.null()]).optional(),
  appName: z.union([z.string().max(262144), z.null()]).optional(),
  connectorId: z.string().max(262144),
  linkId: z.union([z.string().max(262144), z.null()]).optional(),
  resourceUri: z.union([z.string().max(262144), z.null()]).optional(),
});

export const McpToolCallErrorSchema = z.object({ message: z.string().max(262144) });

export const McpToolCallResultSchema = z.object({
  _meta: z.json().optional(),
  content: z.array(z.json()).max(1024),
  structuredContent: z.json().optional(),
});

export const McpToolCallStatusSchema = z.union([
  z.literal("inProgress"),
  z.literal("completed"),
  z.literal("failed"),
]);

export const DynamicToolCallOutputContentItemSchema = z.union([
  z.object({ text: z.string().max(262144), type: z.literal("inputText") }),
  z.object({ imageUrl: z.string().max(262144), type: z.literal("inputImage") }),
  z.object({ audioUrl: z.string().max(262144), type: z.literal("inputAudio") }),
]);

export const DynamicToolCallStatusSchema = z.union([
  z.literal("inProgress"),
  z.literal("completed"),
  z.literal("failed"),
]);

export const CollabAgentStatusSchema = z.union([
  z.literal("pendingInit"),
  z.literal("running"),
  z.literal("interrupted"),
  z.literal("completed"),
  z.literal("errored"),
  z.literal("shutdown"),
  z.literal("notFound"),
]);

export const CollabAgentStateSchema = z.object({
  message: z.union([z.string().max(262144), z.null()]).optional(),
  status: CollabAgentStatusSchema,
});

export const ReasoningEffortSchema = z.string().max(262144);

export const CollabAgentToolCallStatusSchema = z.union([
  z.literal("inProgress"),
  z.literal("completed"),
  z.literal("failed"),
  z.literal("interrupted"),
]);

export const CollabAgentToolSchema = z.union([
  z.literal("spawnAgent"),
  z.literal("sendInput"),
  z.literal("resumeAgent"),
  z.literal("wait"),
  z.literal("closeAgent"),
  z.literal("sendMessage"),
  z.literal("followupTask"),
  z.literal("interruptAgent"),
  z.literal("listAgents"),
]);

export const SubAgentActivityKindSchema = z.union([
  z.literal("started"),
  z.literal("interacted"),
  z.literal("interrupted"),
  z.literal("completed"),
]);

export const WebSearchActionSchema = z.union([
  z.object({
    queries: z.union([z.array(z.string().max(262144)).max(1024), z.null()]).optional(),
    query: z.union([z.string().max(262144), z.null()]).optional(),
    type: z.literal("search"),
  }),
  z.object({
    type: z.literal("openPage"),
    url: z.union([z.string().max(262144), z.null()]).optional(),
  }),
  z.object({
    pattern: z.union([z.string().max(262144), z.null()]).optional(),
    type: z.literal("findInPage"),
    url: z.union([z.string().max(262144), z.null()]).optional(),
  }),
  z.object({ type: z.literal("other") }),
]);

export const ImageGenerationFailureSchema = z.union([
  z.object({
    limitId: z.string().max(262144),
    resetsAt: z.union([z.number().int().safe(), z.null()]).optional(),
    type: z.literal("usageLimitExceeded"),
  }),
]);

export const AbsolutePathBufSchema = z.string().max(262144);

export const ThreadItemSchema = z.union([
  z.object({
    clientId: z.union([z.string().max(262144), z.null()]).optional(),
    content: z.array(UserInputSchema).max(1024),
    id: z.string().max(262144),
    type: z.literal("userMessage"),
  }),
  z.object({
    fragments: z.array(HookPromptFragmentSchema).max(1024),
    id: z.string().max(262144),
    type: z.literal("hookPrompt"),
  }),
  z.object({
    delivery: z.union([AgentMessageDeliverySchema, z.null()]).optional(),
    id: z.string().max(262144),
    memoryCitation: z.union([MemoryCitationSchema, z.null()]).optional(),
    phase: z.union([MessagePhaseSchema, z.null()]).optional(),
    questions: z.union([z.array(AsyncUserInputQuestionSchema).max(1024), z.null()]).optional(),
    text: z.string().max(262144),
    type: z.literal("agentMessage"),
  }),
  z.object({
    id: z.string().max(262144),
    name: z.string().max(262144),
    namespace: z.union([z.string().max(262144), z.null()]).optional(),
    output: FunctionCallOutputBodySchema,
    type: z.literal("functionCallOutput"),
  }),
  z.object({ id: z.string().max(262144), text: z.string().max(262144), type: z.literal("plan") }),
  z.object({
    content: z.array(z.string().max(262144)).max(1024).optional(),
    id: z.string().max(262144),
    summary: z.array(z.string().max(262144)).max(1024).optional(),
    type: z.literal("reasoning"),
  }),
  z.object({
    aggregatedOutput: z.union([z.string().max(262144), z.null()]).optional(),
    command: z.string().max(262144),
    commandActions: z.array(CommandActionSchema).max(1024),
    cwd: LegacyAppPathStringSchema,
    durationMs: z.union([z.number().int().safe(), z.null()]).optional(),
    exitCode: z.union([z.number().int().safe(), z.null()]).optional(),
    id: z.string().max(262144),
    pluginId: z.union([z.string().max(262144), z.null()]).optional(),
    processId: z.union([z.string().max(262144), z.null()]).optional(),
    scriptPath: z.union([z.string().max(262144), z.null()]).optional(),
    source: CommandExecutionSourceSchema.optional(),
    status: CommandExecutionStatusSchema,
    type: z.literal("commandExecution"),
  }),
  z.object({
    changes: z.array(FileUpdateChangeSchema).max(1024),
    id: z.string().max(262144),
    status: PatchApplyStatusSchema,
    type: z.literal("fileChange"),
  }),
  z.object({
    appContext: z.union([McpToolCallAppContextSchema, z.null()]).optional(),
    arguments: z.json(),
    durationMs: z.union([z.number().int().safe(), z.null()]).optional(),
    error: z.union([McpToolCallErrorSchema, z.null()]).optional(),
    id: z.string().max(262144),
    mcpAppResourceUri: z.union([z.string().max(262144), z.null()]).optional(),
    pluginId: z.union([z.string().max(262144), z.null()]).optional(),
    readOnlyHint: z.union([z.boolean(), z.null()]).optional(),
    result: z.union([McpToolCallResultSchema, z.null()]).optional(),
    server: z.string().max(262144),
    status: McpToolCallStatusSchema,
    tool: z.string().max(262144),
    type: z.literal("mcpToolCall"),
  }),
  z.object({
    arguments: z.json(),
    contentItems: z
      .union([z.array(DynamicToolCallOutputContentItemSchema).max(1024), z.null()])
      .optional(),
    durationMs: z.union([z.number().int().safe(), z.null()]).optional(),
    id: z.string().max(262144),
    namespace: z.union([z.string().max(262144), z.null()]).optional(),
    status: DynamicToolCallStatusSchema,
    success: z.union([z.boolean(), z.null()]).optional(),
    tool: z.string().max(262144),
    type: z.literal("dynamicToolCall"),
  }),
  z.object({
    agentsStates: z.record(z.string(), CollabAgentStateSchema),
    id: z.string().max(262144),
    model: z.union([z.string().max(262144), z.null()]).optional(),
    prompt: z.union([z.string().max(262144), z.null()]).optional(),
    reasoningEffort: z.union([ReasoningEffortSchema, z.null()]).optional(),
    receiverThreadIds: z.array(z.string().max(262144)).max(1024),
    senderThreadId: z.string().max(262144),
    status: CollabAgentToolCallStatusSchema,
    tool: CollabAgentToolSchema,
    type: z.literal("collabAgentToolCall"),
  }),
  z.object({
    agentPath: z.string().max(262144),
    agentThreadId: z.string().max(262144),
    id: z.string().max(262144),
    kind: SubAgentActivityKindSchema,
    type: z.literal("subAgentActivity"),
  }),
  z.object({
    action: z.union([WebSearchActionSchema, z.null()]).optional(),
    id: z.string().max(262144),
    query: z.string().max(262144),
    results: z.union([z.array(z.json()).max(1024), z.null()]).optional(),
    type: z.literal("webSearch"),
  }),
  z.object({
    id: z.string().max(262144),
    path: LegacyAppPathStringSchema,
    type: z.literal("imageView"),
  }),
  z.object({
    durationMs: z.number().int().safe(),
    id: z.string().max(262144),
    type: z.literal("sleep"),
  }),
  z.object({
    failure: z.union([ImageGenerationFailureSchema, z.null()]).optional(),
    id: z.string().max(262144),
    revisedPrompt: z.union([z.string().max(262144), z.null()]).optional(),
    savedPath: z.union([AbsolutePathBufSchema, z.null()]).optional(),
    status: z.string().max(262144),
    transparentBackground: z.union([z.boolean(), z.null()]).optional(),
    type: z.literal("imageGeneration"),
  }),
  z.object({
    id: z.string().max(262144),
    review: z.string().max(262144),
    type: z.literal("enteredReviewMode"),
  }),
  z.object({
    id: z.string().max(262144),
    review: z.string().max(262144),
    type: z.literal("exitedReviewMode"),
  }),
  z.object({ id: z.string().max(262144), type: z.literal("contextCompaction") }),
]);

export const ItemStartedNotificationSchema = z.object({
  item: ThreadItemSchema,
  startedAtMs: z.number().int().safe(),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const ItemCompletedNotificationSchema = z.object({
  completedAtMs: z.number().int().safe(),
  item: ThreadItemSchema,
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const AgentMessageDeltaNotificationSchema = z.object({
  delta: z.string().max(262144),
  itemId: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const PlanDeltaNotificationSchema = z.object({
  delta: z.string().max(262144),
  itemId: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const CommandExecutionOutputDeltaNotificationSchema = z.object({
  delta: z.string().max(262144),
  itemId: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const FileChangeOutputDeltaNotificationSchema = z.object({
  delta: z.string().max(262144),
  itemId: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const ReasoningTextDeltaNotificationSchema = z.object({
  contentIndex: z.number().int().safe(),
  delta: z.string().max(262144),
  itemId: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const ReasoningSummaryTextDeltaNotificationSchema = z.object({
  delta: z.string().max(262144),
  itemId: z.string().max(262144),
  summaryIndex: z.number().int().safe(),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const ReasoningSummaryPartAddedNotificationSchema = z.object({
  itemId: z.string().max(262144),
  summaryIndex: z.number().int().safe(),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const TerminalInteractionNotificationSchema = z.object({
  itemId: z.string().max(262144),
  processId: z.string().max(262144),
  stdin: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const McpToolCallProgressNotificationSchema = z.object({
  itemId: z.string().max(262144),
  message: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const NonSteerableTurnKindSchema = z.union([z.literal("review"), z.literal("compact")]);

export const CodexErrorInfoSchema = z.union([
  z.union([
    z.literal("contextWindowExceeded"),
    z.literal("sessionBudgetExceeded"),
    z.literal("usageLimitExceeded"),
    z.literal("rateLimitExceeded"),
    z.literal("serverOverloaded"),
    z.literal("cyberPolicy"),
    z.literal("misalignmentPolicyViolation"),
    z.literal("internalServerError"),
    z.literal("unauthorized"),
    z.literal("badRequest"),
    z.literal("threadRollbackFailed"),
    z.literal("sandboxError"),
    z.literal("other"),
  ]),
  z.object({
    httpConnectionFailed: z.object({
      httpStatusCode: z.union([z.number().int().safe(), z.null()]).optional(),
    }),
  }),
  z.object({
    responseStreamConnectionFailed: z.object({
      httpStatusCode: z.union([z.number().int().safe(), z.null()]).optional(),
    }),
  }),
  z.object({
    responseStreamDisconnected: z.object({
      httpStatusCode: z.union([z.number().int().safe(), z.null()]).optional(),
    }),
  }),
  z.object({
    responseTooManyFailedAttempts: z.object({
      httpStatusCode: z.union([z.number().int().safe(), z.null()]).optional(),
    }),
  }),
  z.object({ activeTurnNotSteerable: z.object({ turnKind: NonSteerableTurnKindSchema }) }),
]);

export const MisalignmentSteerSchema = z.object({ message: z.string().max(262144) });

export const MisalignmentErrorDetailsSchema = z.object({
  detailedExplanation: z.union([z.string().max(262144), z.null()]).optional(),
  errorType: z.union([z.string().max(262144), z.null()]).optional(),
  steer: z.union([MisalignmentSteerSchema, z.null()]).optional(),
});

export const TurnErrorSchema = z.object({
  additionalDetails: z.union([z.string().max(262144), z.null()]).optional(),
  codexErrorInfo: z.union([CodexErrorInfoSchema, z.null()]).optional(),
  message: z.string().max(262144),
  misalignment: z.union([MisalignmentErrorDetailsSchema, z.null()]).optional(),
});

export const TurnStatusSchema = z.union([
  z.literal("completed"),
  z.literal("interrupted"),
  z.literal("failed"),
  z.literal("inProgress"),
]);

export const TurnSchema = z.object({
  completedAt: z.union([z.number().int().safe(), z.null()]).optional(),
  durationMs: z.union([z.number().int().safe(), z.null()]).optional(),
  error: z.union([TurnErrorSchema, z.null()]).optional(),
  id: z.string().max(262144),
  startedAt: z.union([z.number().int().safe(), z.null()]).optional(),
  status: TurnStatusSchema,
});

export const TurnStartedNotificationSchema = z.object({
  threadId: z.string().max(262144),
  turn: TurnSchema,
});

export const TurnCompletedNotificationSchema = z.object({
  threadId: z.string().max(262144),
  turn: TurnSchema,
});

export const TurnDiffUpdatedNotificationSchema = z.object({
  diff: z.string().max(262144),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const TurnPlanStepStatusSchema = z.union([
  z.literal("pending"),
  z.literal("inProgress"),
  z.literal("completed"),
]);

export const TurnPlanStepSchema = z.object({
  status: TurnPlanStepStatusSchema,
  step: z.string().max(262144),
});

export const TurnPlanUpdatedNotificationSchema = z.object({
  explanation: z.union([z.string().max(262144), z.null()]).optional(),
  plan: z.array(TurnPlanStepSchema).max(1024),
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
});

export const TokenUsageBreakdownSchema = z.object({
  cacheWriteInputTokens: z.number().int().safe().optional(),
  cachedInputTokens: z.number().int().safe(),
  inputTokens: z.number().int().safe(),
  outputTokens: z.number().int().safe(),
  reasoningOutputTokens: z.number().int().safe(),
  totalTokens: z.number().int().safe(),
});

export const ThreadTokenUsageSchema = z.object({
  last: TokenUsageBreakdownSchema,
  modelContextWindow: z.union([z.number().int().safe(), z.null()]).optional(),
  total: TokenUsageBreakdownSchema,
});

export const ThreadTokenUsageUpdatedNotificationSchema = z.object({
  threadId: z.string().max(262144),
  tokenUsage: ThreadTokenUsageSchema,
  turnId: z.string().max(262144),
});

export const ActivePermissionProfileSchema = z.object({
  extends: z.union([z.string().max(262144), z.null()]).optional(),
  id: z.string().max(262144),
});

export const AskForApprovalSchema = z.union([
  z.union([z.literal("untrusted"), z.literal("on-request"), z.literal("never")]),
  z.object({
    granular: z.object({
      mcp_elicitations: z.boolean(),
      request_permissions: z.boolean().optional(),
      rules: z.boolean(),
      sandbox_approval: z.boolean(),
      skill_approval: z.boolean().optional(),
    }),
  }),
]);

export const ApprovalsReviewerSchema = z.union([
  z.literal("user"),
  z.literal("auto_review"),
  z.literal("guardian_subagent"),
]);

export const ModeKindSchema = z.union([z.literal("plan"), z.literal("default")]);

export const SettingsSchema = z.object({
  developer_instructions: z.union([z.string().max(262144), z.null()]).optional(),
  model: z.string().max(262144),
  reasoning_effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
});

export const CollaborationModeSchema = z.object({ mode: ModeKindSchema, settings: SettingsSchema });

export const MultiAgentModeSchema = z.union([
  z.union([z.literal("explicitRequestOnly"), z.literal("proactive")]),
  z.object({ custom: z.string().max(262144) }),
]);

export const PersonalitySchema = z.union([
  z.literal("none"),
  z.literal("friendly"),
  z.literal("pragmatic"),
]);

export const NetworkAccessSchema = z.union([z.literal("restricted"), z.literal("enabled")]);

export const SandboxPolicySchema = z.union([
  z.object({ type: z.literal("dangerFullAccess") }),
  z.object({ networkAccess: z.boolean().optional(), type: z.literal("readOnly") }),
  z.object({ networkAccess: NetworkAccessSchema.optional(), type: z.literal("externalSandbox") }),
  z.object({
    excludeSlashTmp: z.boolean().optional(),
    excludeTmpdirEnvVar: z.boolean().optional(),
    networkAccess: z.boolean().optional(),
    type: z.literal("workspaceWrite"),
    writableRoots: z.array(AbsolutePathBufSchema).max(1024).optional(),
  }),
]);

export const ReasoningSummarySchema = z.union([
  z.union([z.literal("auto"), z.literal("concise"), z.literal("detailed")]),
  z.literal("none"),
]);

export const ThreadSettingsSchema = z.object({
  activePermissionProfile: z.union([ActivePermissionProfileSchema, z.null()]).optional(),
  approvalPolicy: AskForApprovalSchema,
  approvalsReviewer: ApprovalsReviewerSchema,
  collaborationMode: CollaborationModeSchema,
  cwd: AbsolutePathBufSchema,
  effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
  model: z.string().max(262144),
  modelProvider: z.string().max(262144),
  multiAgentMode: MultiAgentModeSchema.optional(),
  personality: z.union([PersonalitySchema, z.null()]).optional(),
  sandboxPolicy: SandboxPolicySchema,
  serviceTier: z.union([z.string().max(262144), z.null()]).optional(),
  summary: z.union([ReasoningSummarySchema, z.null()]).optional(),
});

export const ThreadSettingsUpdatedNotificationSchema = z.object({
  threadId: z.string().max(262144),
  threadSettings: ThreadSettingsSchema,
});

export const ThreadRevertedNotificationSchema = z.object({ threadId: z.string().max(262144) });

export const ErrorNotificationSchema = z.object({
  error: TurnErrorSchema,
  threadId: z.string().max(262144),
  turnId: z.string().max(262144),
  willRetry: z.boolean(),
});

export const HookOutputEntryKindSchema = z.union([
  z.literal("warning"),
  z.literal("stop"),
  z.literal("feedback"),
  z.literal("context"),
  z.literal("error"),
]);

export const HookOutputEntrySchema = z.object({
  kind: HookOutputEntryKindSchema,
  text: z.string().max(262144),
});

export const HookEventNameSchema = z.union([
  z.literal("preToolUse"),
  z.literal("permissionRequest"),
  z.literal("postToolUse"),
  z.literal("preCompact"),
  z.literal("postCompact"),
  z.literal("sessionStart"),
  z.literal("sessionEnd"),
  z.literal("userPromptSubmit"),
  z.literal("subagentStart"),
  z.literal("subagentStop"),
  z.literal("stop"),
  z.literal("interrupt"),
]);

export const HookExecutionModeSchema = z.union([z.literal("sync"), z.literal("async")]);

export const HookHandlerTypeSchema = z.union([
  z.literal("command"),
  z.literal("mcpTool"),
  z.literal("prompt"),
  z.literal("agent"),
]);

export const HookScopeSchema = z.union([z.literal("thread"), z.literal("turn")]);

export const HookSourceSchema = z.union([
  z.literal("system"),
  z.literal("user"),
  z.literal("project"),
  z.literal("mdm"),
  z.literal("sessionFlags"),
  z.literal("plugin"),
  z.literal("cloudRequirements"),
  z.literal("cloudManagedConfig"),
  z.literal("legacyManagedConfigFile"),
  z.literal("legacyManagedConfigMdm"),
  z.literal("unknown"),
]);

export const HookRunStatusSchema = z.union([
  z.literal("running"),
  z.literal("completed"),
  z.literal("failed"),
  z.literal("blocked"),
  z.literal("stopped"),
]);

export const HookRunSummarySchema = z.object({
  completedAt: z.union([z.number().int().safe(), z.null()]).optional(),
  displayOrder: z.number().int().safe(),
  durationMs: z.union([z.number().int().safe(), z.null()]).optional(),
  entries: z.array(HookOutputEntrySchema).max(1024),
  eventName: HookEventNameSchema,
  executionMode: HookExecutionModeSchema,
  handlerType: HookHandlerTypeSchema,
  id: z.string().max(262144),
  scope: HookScopeSchema,
  source: HookSourceSchema.optional(),
  sourcePath: AbsolutePathBufSchema,
  startedAt: z.number().int().safe(),
  status: HookRunStatusSchema,
  statusMessage: z.union([z.string().max(262144), z.null()]).optional(),
});

export const HookStartedNotificationSchema = z.object({
  run: HookRunSummarySchema,
  threadId: z.string().max(262144),
  turnId: z.union([z.string().max(262144), z.null()]).optional(),
});

export const HookCompletedNotificationSchema = z.object({
  run: HookRunSummarySchema,
  threadId: z.string().max(262144),
  turnId: z.union([z.string().max(262144), z.null()]).optional(),
});

export const nativeConversationSchemas = {
  "item/started": ItemStartedNotificationSchema,
  "item/completed": ItemCompletedNotificationSchema,
  "item/agentMessage/delta": AgentMessageDeltaNotificationSchema,
  "item/plan/delta": PlanDeltaNotificationSchema,
  "item/commandExecution/outputDelta": CommandExecutionOutputDeltaNotificationSchema,
  "item/fileChange/outputDelta": FileChangeOutputDeltaNotificationSchema,
  "item/reasoning/textDelta": ReasoningTextDeltaNotificationSchema,
  "item/reasoning/summaryTextDelta": ReasoningSummaryTextDeltaNotificationSchema,
  "item/reasoning/summaryPartAdded": ReasoningSummaryPartAddedNotificationSchema,
  "item/commandExecution/terminalInteraction": TerminalInteractionNotificationSchema,
  "item/mcpToolCall/progress": McpToolCallProgressNotificationSchema,
  "turn/started": TurnStartedNotificationSchema,
  "turn/completed": TurnCompletedNotificationSchema,
  "turn/diff/updated": TurnDiffUpdatedNotificationSchema,
  "turn/plan/updated": TurnPlanUpdatedNotificationSchema,
  "thread/tokenUsage/updated": ThreadTokenUsageUpdatedNotificationSchema,
  "thread/settings/updated": ThreadSettingsUpdatedNotificationSchema,
  "thread/reverted": ThreadRevertedNotificationSchema,
  error: ErrorNotificationSchema,
  "hook/started": HookStartedNotificationSchema,
  "hook/completed": HookCompletedNotificationSchema,
};
