import {
  checkDotenvPath,
  durationMessage,
  durationPattern,
  envNameMessage,
  envNamePattern,
  identifierPattern,
  identifierSource,
  workflowInputDeclarationDefinitionSchema,
  isJsonObject,
  jsonSchemaTarget,
  toJsonSchema,
} from "@ugoke/core";
import type { JsonObject, PluginRegistry, WaitMethod } from "@ugoke/core";
import { z } from "zod";

const stepIdPattern = new RegExp(`^(?!(?:end|start)$)${identifierSource}$`, "u");

/** Definition format version supported by this package. */
export const definitionVersion = "v0.1";

/** Timeout applied to a script or AI step that does not specify one. */
export const defaultStepTimeout = "30m";

const identifierSchema = z
  .string()
  .regex(identifierPattern, "Must start with a letter and contain only letters, digits, or _");

const stepIdSchema = z
  .string()
  .regex(
    stepIdPattern,
    "Must start with a letter, contain only letters, digits, or _, and not be a reserved word: end or start",
  );

/** Where a step goes next: a step, or branches of which the first that holds is taken. */
const nextSchema = z.union(
  [
    identifierSchema,
    z
      .array(
        z.strictObject({
          if: z.string().min(1).optional().describe("Condition, such as ${{ outputs.ok == true }}"),
          to: identifierSchema.describe("Step to go to, or end"),
        }),
      )
      .min(1),
  ],
  { error: "Must be the name of a step, end, or a list of branches with if and to" },
);

const maxVisitsSchema = z
  .int()
  .positive()
  .optional()
  .describe("Times that the step can run in a run. It has no limit by default");

const continueOnErrorSchema = z
  .boolean()
  .optional()
  .describe(
    "Whether the workflow goes on when the step fails, with result.ok set to false. It stops by default",
  );

const expressionMapSchema = z.record(identifierSchema, z.string().min(1));

/**
 * Environment variables to set, keyed by name. Numbers and booleans become text with `String()`,
 * as YAML reads `PORT: 3000` as a number.
 *
 * When a definition is read from YAML, `parseDefinition` first rejects a number or a boolean
 * whose text differs from how it is written, such as `1.10` or `00123`, because the parsed value no
 * longer shows how it was written.
 */
const envSchema = z
  .record(
    z.string().regex(envNamePattern, envNameMessage),
    z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        'Value of the variable. A number or a boolean becomes text as written, such as 3000 or true. Quote a value that YAML reads differently, such as "1.10" or "00123"',
      )
      .transform(String),
  )
  .optional();

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  run: z.string().min(1),
  next: nextSchema,
  maxVisits: maxVisitsSchema,
  continueOnError: continueOnErrorSchema,
  timeout: z
    .string()
    .regex(durationPattern, durationMessage)
    .default(defaultStepTimeout)
    .describe("Maximum duration of the step"),
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
  env: envSchema.describe("Environment variables of the script. Values may contain expressions"),
});

const waitStepSchema = z.strictObject({
  type: z.literal("wait"),
  method: z.string().min(1).describe("How the step waits, such as terminal"),
  with: z
    .record(z.string(), z.json())
    .optional()
    .describe("Options of the method. Strings may contain expressions"),
  next: nextSchema,
  maxVisits: maxVisitsSchema,
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
});

const aiStepSchema = z.strictObject({
  type: z.literal("ai"),
  provider: z.string().min(1).describe("Provider that runs the step, such as claude-code"),
  model: z.string().min(1).optional().describe("Model to use. The provider chooses one by default"),
  prompt: z.string().min(1).describe("Instructions of the step. It may contain expressions"),
  schema: z
    .record(z.string(), z.json())
    .optional()
    .describe("JSON Schema of the result, which is text without it"),
  session: z
    .enum(["reuse", "new"])
    .default("reuse")
    .describe("Whether a step that runs again continues its previous session"),
  with: z
    .record(z.string(), z.json())
    .optional()
    .describe("Options of the provider. Strings may contain expressions"),
  next: nextSchema,
  maxVisits: maxVisitsSchema,
  continueOnError: continueOnErrorSchema,
  timeout: z
    .string()
    .regex(durationPattern, durationMessage)
    .default(defaultStepTimeout)
    .describe("Maximum duration of the step"),
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
  env: envSchema.describe("Environment variables of the step. Values may contain expressions"),
});

const stepSchema = z.discriminatedUnion("type", [scriptStepSchema, waitStepSchema, aiStepSchema]);

/** Schema for a workflow definition object, independent of its file format. */
export const definitionSchema = z.strictObject({
  $schema: z
    .string()
    .optional()
    .describe("JSON Schema of the file for editors, such as ../schemas/workflow.schema.json"),
  version: z.literal(definitionVersion),
  inputs: z
    .record(identifierSchema, workflowInputDeclarationDefinitionSchema)
    .optional()
    .describe("Values that the workflow receives when it starts"),
  env: envSchema.describe(
    "Environment variables of every script and AI step. Values can reference workflow.inputs",
  ),
  dotenv: z
    .string()
    .min(1)
    .superRefine((path, context) => {
      const message = checkDotenvPath(path);
      if (message !== undefined) {
        context.addIssue({ code: "custom", message });
      }
    })
    .optional()
    .describe("Path of a dotenv file, relative to the project root, that script and AI steps read"),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, stepSchema),
});

/** A workflow definition that has passed {@link definitionSchema}. */
export type Definition = z.infer<typeof definitionSchema>;

/** Options of {@link createDefinitionJsonSchema}. */
export interface DefinitionJsonSchemaOptions {
  /**
   * Plugins whose wait methods and AI providers a definition can use. With it, `method` and
   * `provider` take only their names, and `with` follows the schema of each.
   */
  plugins?: PluginRegistry;
}

/**
 * Restricts the extension of the steps of a type to the names that plugins provide, and the
 * `with` of each name to its schema.
 *
 * A schema that cannot be converted to JSON Schema accepts any `with`.
 */
const constrainExtensions = (
  steps: readonly JsonObject[],
  type: "ai" | "wait",
  field: "method" | "provider",
  extensions: readonly { name: string; with: WaitMethod["with"] }[],
): void => {
  const step = steps.find(
    (candidate) =>
      isJsonObject(candidate.properties) &&
      isJsonObject(candidate.properties.type) &&
      candidate.properties.type.const === type,
  );
  if (step === undefined || !isJsonObject(step.properties)) {
    throw new Error(`The JSON Schema has no ${type} step`);
  }
  step.properties[field] = {
    ...(isJsonObject(step.properties[field]) ? step.properties[field] : {}),
    // An empty enum is not valid JSON Schema, so a field without names accepts no value.
    ...(extensions.length === 0 ? { not: {} } : { enum: extensions.map(({ name }) => name) }),
  };
  if (extensions.length === 0) {
    return;
  }
  step.allOf = extensions.map(({ name, with: schema }) => {
    const converted = toJsonSchema(schema) ?? {};
    // A step without `with` is validated as an empty object, so `with` is required when the
    // empty object would not pass.
    const required = Array.isArray(converted.required) && converted.required.length > 0;
    return {
      if: { properties: { [field]: { const: name } }, required: [field] },
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a keyword of JSON Schema.
      then: { properties: { with: converted }, ...(required ? { required: ["with"] } : {}) },
    };
  });
};

/**
 * Creates the JSON Schema of a workflow definition for editors and other tools.
 *
 * It follows draft-07, which editors for YAML support widely.
 */
export const createDefinitionJsonSchema = ({ plugins }: DefinitionJsonSchemaOptions = {}) => {
  const schema: JsonObject = z.toJSONSchema(definitionSchema, {
    io: "input",
    target: jsonSchemaTarget,
  });
  if (plugins === undefined) {
    return schema;
  }
  const steps =
    isJsonObject(schema.properties) &&
    isJsonObject(schema.properties.steps) &&
    isJsonObject(schema.properties.steps.additionalProperties) &&
    Array.isArray(schema.properties.steps.additionalProperties.oneOf)
      ? schema.properties.steps.additionalProperties.oneOf.filter(isJsonObject)
      : [];
  constrainExtensions(
    steps,
    "wait",
    "method",
    plugins.waitMethodNames().flatMap((name) => {
      const method = plugins.waitMethod(name);
      return method === undefined ? [] : [{ name, with: method.with }];
    }),
  );
  constrainExtensions(
    steps,
    "ai",
    "provider",
    plugins.aiProviderNames().flatMap((name) => {
      const provider = plugins.aiProvider(name);
      return provider === undefined ? [] : [{ name, with: provider.with }];
    }),
  );
  return schema;
};
