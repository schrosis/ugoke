import { z } from "zod";

import { identifierPattern } from "../identifier.js";
import { checkInputValue } from "./input.js";
import type { ValidationError } from "./validate.js";

const inputBase = {
  description: z.string().optional(),
  required: z.boolean(),
};

// z.number() accepts only finite numbers.
const declarationOptions = <Required extends z.ZodType<boolean>>(
  base: { description: z.ZodOptional<z.ZodString>; required: Required },
  multiline: z.ZodOptional<z.ZodBoolean> = z.boolean().optional(),
) =>
  [
    z.strictObject({
      type: z.literal("string"),
      ...base,
      default: z.string().optional(),
      multiline,
    }),
    z.strictObject({ type: z.literal("number"), ...base, default: z.number().optional() }),
    z.strictObject({ type: z.literal("boolean"), ...base, default: z.boolean().optional() }),
    z.strictObject({
      type: z.literal("choice"),
      ...base,
      options: z.array(z.string().min(1)).min(1),
      default: z.string().optional(),
    }),
  ] as const;

/** Schema of a declaration of a value, such as a workflow input, in the intermediate form. */
export const inputDeclarationSchema = z.discriminatedUnion("type", declarationOptions(inputBase));

/** Declaration of a value that a workflow or a step receives, with a type and constraints. */
export type InputDeclaration = z.infer<typeof inputDeclarationSchema>;

/**
 * Checks the parts of declarations that their schema cannot express.
 *
 * The paths of the errors start with the name of the declaration.
 */
export const checkInputDeclarations = (
  declarations: Readonly<Record<string, InputDeclaration>>,
): ValidationError[] =>
  Object.entries(declarations).flatMap(([name, declaration]): ValidationError[] => {
    const errors: ValidationError[] = [];
    if (declaration.type === "choice") {
      const duplicate = declaration.options.find(
        (option, index) => declaration.options.indexOf(option) !== index,
      );
      if (duplicate !== undefined) {
        errors.push({ message: `Duplicate option: ${duplicate}`, path: [name, "options"] });
      }
    }
    if (declaration.default !== undefined) {
      if (declaration.required) {
        errors.push({
          message: "A required input cannot have a default",
          path: [name, "default"],
        });
      }
      const checked = checkInputValue(declaration, declaration.default);
      if (!checked.ok) {
        errors.push({ message: checked.message, path: [name, "default"] });
      }
    }
    return errors;
  });

/**
 * Schema of a single declaration as a definition writes it. `required` defaults to `false`.
 *
 * It does not check what {@link checkInputDeclarations} checks.
 */
export const inputDeclarationDefinitionSchema = z.discriminatedUnion(
  "type",
  declarationOptions(
    {
      description: z.string().optional().describe("Description of the value"),
      required: z
        .boolean()
        .default(false)
        .describe("Whether the value must be given. It cannot be combined with default"),
    },
    z
      .boolean()
      .optional()
      .describe(
        "Whether the value can span lines. The terminal wait method asks for it on several lines",
      ),
  ),
);

/**
 * Schema of declarations as a definition writes them, keyed by name.
 *
 * `required` defaults to `false`. Plugins use it for the values that they receive, such as the
 * answers of a wait step, so that every declaration is written the same way.
 */
export const inputDeclarationsSchema = z
  .record(
    z
      .string()
      .regex(identifierPattern, "Must start with a letter and contain only letters, digits, or _"),
    inputDeclarationDefinitionSchema,
  )
  .superRefine((declarations, context) => {
    for (const { message, path } of checkInputDeclarations(declarations)) {
      context.addIssue({ code: "custom", message, path });
    }
  });
