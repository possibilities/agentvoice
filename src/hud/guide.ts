import { z } from "zod";
import { batchSchema, mutationSchema } from "./contract.ts";

const description = {
  name: "agenthud",
  version: 1,
  description:
    "Durable Work, native assignment associations, result acceptance and presentation; read-only live HUD.",
  commands: [
    {
      name: "guide",
      usage: "agenthud guide --json",
      description: "Read this contract without opening the store.",
    },
    {
      name: "snapshot",
      usage: "agenthud snapshot [--native]",
      description: "Read durable Work; --native adds bounded current AgentVoice observation.",
    },
    {
      name: "apply",
      usage: "agenthud apply --json '<mutation>'",
      description:
        "One idempotent revision-fenced mutation; use --file PATH or --file - for stdin.",
    },
    {
      name: "batch",
      usage: "agenthud batch --json '<batch>'",
      description: "Atomically apply up to 100 mutations with a batch operation ID.",
    },
    { name: "mcp", usage: "agenthud mcp", description: "Serve the same contract over stdio MCP." },
    {
      name: "serve",
      usage: "agenthud serve",
      description:
        "Serve built hud/dist at https://agenthud.localhost through the existing shared portless proxy. --port PORT provides direct loopback development access.",
    },
  ],
  trust:
    "One local OS-user trust domain. Actor/lead/assignee identities are declarations, not authenticated native callers. HTTP cannot mutate Work. MCP accepts no database or credential overrides.",
  protocol: [
    "Create Work with objective, authorized scope/evidence and accountable lead. Every write includes operationId, actor, entity id and expectedRevision (0 for creation).",
    "Prepare an assignment before native spawn or follow-up. Assignment ID and operation ID are durable dispatch correlations. Native execution stays native.",
    "Bind once after inspecting native dispatch evidence: exact instanceId, generation, rootThreadId, threadId and turnId. Reused threads need new assignments. An unbound assignment means dispatch outcome unknown; never automatically dispatch again.",
    "Record returned artifacts/native evidence, then issuing-parent or Work-lead review, then Work-lead human presentation as separate mutations. Completion requires accepted results; presentation can remain pending. Presented evidence is immutable; further review needs a successor result.",
    "An unbound assignment may be resolved only with evidence-backed dispatchResolution not_dispatched or dispatch_failed and a failed/interrupted result with null binding. Unknown dispatch stays unresolved. Bind cannot follow a no-execution resolution; prepare a new assignment.",
    "Reuse the same operation ID and identical payload after a lost response. Revision conflicts require rereading and a new decision, never blind retry.",
    "Semantic changes advance Work.scopeRevision. Assignment.scopeRevision captures the scope at prepare; assigned Result.scopeRevision inherits that assignment scope even when returned later. Direct results capture current Work scope. Completion requires an accepted completed result from the current scope revision. Older evidence and receipts remain historical; reopening and changing scope cannot reuse them as current completion proof.",
    "Closed Work permits administrative priority, next action and Attention-reference edits. Changing objective, scope, authority, lead, containment or dependencies requires an explicit open disposition in the same mutation; omitted fields remain unchanged. Routine metadata edits do not change scopeRevision.",
    "Closing Work, including cancellation, requires every descendant Work already completed or cancelled. Close a subtree from children upward, optionally in one atomic batch. Reopen closed ancestors before creating new child obligations.",
    "Human dependency references point to Attention; they do not infer or supply approval. Work never mutates or imports Board.",
    "Native inventory is bounded current observation, not execution authority. Unavailable/incomplete observation and unassigned native threads remain visible.",
  ],
  mutationSchema: z.toJSONSchema(mutationSchema),
  batchSchema: z.toJSONSchema(batchSchema),
};
const mutationArguments = [
  {
    name: "--json",
    type: "string",
    format: "json",
    description: "The complete mutation or batch JSON object.",
  },
  {
    name: "--file",
    type: "string",
    format: "path",
    direction: "in",
    description: "Read JSON from a file; - reads stdin.",
  },
];
export const hudGuide = {
  contract_version: 1,
  meta: { name: "agenthud", version: "1.0.0", purpose: description.description, audience: "agent" },
  guidance: [description.trust, ...description.protocol].join("\n\n"),
  concepts: {
    model: {
      Work: "Durable objective, scope, authority, parent/dependencies and accountable lead.",
      Assignment:
        "Prepared dispatch intent and immutable exact native binding; reused thread turns need new assignments.",
      Result: "Returned evidence with separate append-only review and presentation records.",
      trust: description.trust,
    },
    output_contract: {
      envelope: {
        guide: "{schema_version:1,ok:true,error:null,data:contract}",
        snapshot: "WorkSnapshot or HudSnapshot JSON",
        apply: "Updated entity JSON",
        batch: "{records: entity[]}",
        error: "{error:{code,message}} on stderr; stdout empty",
        mcp: "Same JSON in structuredContent and text; failures set isError.",
      },
      exit_codes: {
        "0": "Success",
        "1": "Invalid input or failed operation",
        "129": "Foreground serve received HUP",
        "130": "Foreground serve received INT",
        "143": "Foreground serve received TERM",
      },
    },
    error_codes: [
      ["usage", "Invalid command or argument syntax"],
      ["invalid_input", "Input fails JSON/schema validation"],
      ["not_found", "Referenced entity does not exist"],
      ["revision_conflict", "Expected revision no longer matches"],
      ["operation_conflict", "Operation ID was used with a different payload"],
      ["owner_conflict", "Declared actor is not the authorized owner"],
      ["unsafe_path", "Database files or ancestors are unsafe"],
      ["schema_version", "Database needs a newer command"],
      ["closed_work", "Reopen Work before adding or changing evidence"],
      ["closed_parent", "Reopen the ancestor before adding or reopening child Work"],
      ["already_bound", "Assignment binding is immutable"],
      ["binding_conflict", "Exact native association is inconsistent or already assigned"],
      ["dispatch_resolved", "No-execution dispatch was already resolved"],
      ["invalid_resolution", "No-execution resolution requires failed/interrupted outcome"],
      ["invalid_assignment", "Assignment reference is invalid"],
      ["invalid_parent", "Parent assignment or Work containment is invalid"],
      ["invalid_dependency", "Dependency graph is invalid or cyclic"],
      ["review_required", "Accepted evidence is required"],
      ["result_required", "Returned/completed result evidence is required"],
      ["dependency_open", "A dependency remains unfinished"],
      ["child_open", "A child Work remains unfinished"],
      ["already_presented", "Presented evidence is immutable; create a successor result"],
      ["internal", "Local operation or required serving dependency failed"],
    ].map(([code, meaning]) => ({ code, meaning })),
    read_only_commands: ["guide", "snapshot"],
    agent_defaults: ["agenthud guide --json", "agenthud snapshot --native"],
  },
  commands: description.commands.map((command) => ({
    name: command.name,
    summary: command.description,
    audience: command.name === "mcp" ? "internal" : command.name === "serve" ? "operator" : "agent",
    mutates: !["guide", "snapshot"].includes(command.name),
    arguments:
      command.name === "guide"
        ? [{ name: "--json", type: "boolean", description: "Print the machine-readable contract." }]
        : command.name === "snapshot"
          ? [
              {
                name: "--native",
                type: "boolean",
                description: "Include bounded current native observation.",
              },
            ]
          : ["apply", "batch"].includes(command.name)
            ? mutationArguments
            : command.name === "serve"
              ? [
                  {
                    name: "--port",
                    type: "integer",
                    minimum: 1,
                    maximum: 65535,
                    description: "Use direct loopback development serving at this port.",
                  },
                  {
                    name: "--direct",
                    type: "boolean",
                    role: "meta",
                    description: "Internal portless child: direct loopback serving using PORT.",
                  },
                ]
              : [],
    ...(["apply", "batch"].includes(command.name)
      ? {
          constraints: [{ kind: "one_of", arguments: ["--json", "--file"], required: true }],
          stdin: {
            accepts: "json",
            required: false,
            description: "Read JSON only when --file - is supplied.",
          },
        }
      : {}),
    ...(["serve", "mcp"].includes(command.name) ? { blocking: true } : {}),
    x_usage: command.usage,
  })),
  x_mutation_schema: description.mutationSchema,
  x_batch_schema: description.batchSchema,
};
export const guideEnvelope = { schema_version: 1, ok: true, error: null, data: hudGuide };
