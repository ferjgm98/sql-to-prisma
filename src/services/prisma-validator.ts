export interface ValidationDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export class PrismaValidator {
  /**
   * Validates Prisma schema content and returns diagnostics
   */
  static validate(schema: string): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = [];

    if (!schema.trim()) {
      return diagnostics;
    }

    try {
      // Parse models and enums from the schema
      const models = this.extractModels(schema);
      const enums = this.extractEnums(schema);

      // Check if schema has models
      if (models.length === 0 && enums.length === 0) {
        diagnostics.push({
          severity: "info",
          message: "Schema has no models or enums defined",
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
        });
        return diagnostics;
      }

      // Validate models
      for (const model of models) {
        const modelLocation = this.findModelLocation(schema, model.name);

        // Check for models without @id field
        const hasId = model.fields.some((f) => f.attributes.includes("@id"));
        if (!hasId) {
          diagnostics.push({
            severity: "error",
            message: `Model '${model.name}' must have an @id field`,
            line: modelLocation.line,
            column: modelLocation.column,
            endLine: modelLocation.line,
            endColumn: modelLocation.column + model.name.length,
          });
        }

        // Check for relation fields without proper attributes
        for (const field of model.fields) {
          if (this.isRelationType(field.type, models, enums)) {
            const fieldLocation = this.findFieldLocation(
              schema,
              model.name,
              field.name
            );

            // Check if relation has @relation attribute or is array (back-relation)
            const hasRelationAttr = field.attributes.some((attr) =>
              attr.includes("@relation")
            );
            if (!hasRelationAttr && !field.isArray) {
              diagnostics.push({
                severity: "error",
                message: `Relation field '${field.name}' must have @relation attribute with fields and references`,
                line: fieldLocation.line,
                column: fieldLocation.column,
                endLine: fieldLocation.line,
                endColumn: fieldLocation.column + field.name.length,
              });
            }

            // Check if related model exists
            const relatedModelExists = models.some(
              (m) => m.name === field.type
            );
            const relatedEnumExists = enums.some((e) => e.name === field.type);

            if (!relatedModelExists && !relatedEnumExists) {
              diagnostics.push({
                severity: "error",
                message: `Relation references non-existent model or enum '${field.type}'`,
                line: fieldLocation.line,
                column: fieldLocation.column,
                endLine: fieldLocation.line,
                endColumn: fieldLocation.column + field.name.length,
              });
            }
          }

          // Check for invalid field types
          if (!this.isValidPrismaType(field.type, models, enums)) {
            const fieldLocation = this.findFieldLocation(
              schema,
              model.name,
              field.name
            );
            diagnostics.push({
              severity: "error",
              message: `Invalid field type '${field.type}'`,
              line: fieldLocation.line,
              column: fieldLocation.column,
              endLine: fieldLocation.line,
              endColumn: fieldLocation.column + field.name.length,
            });
          }
        }

        // Check naming conventions
        if (!/^[A-Z][a-zA-Z0-9]*$/.test(model.name)) {
          diagnostics.push({
            severity: "info",
            message: `Model name '${model.name}' should use PascalCase convention`,
            line: modelLocation.line,
            column: modelLocation.column,
            endLine: modelLocation.line,
            endColumn: modelLocation.column + model.name.length,
          });
        }

        for (const field of model.fields) {
          if (!/^[a-z][a-zA-Z0-9]*$/.test(field.name)) {
            const fieldLocation = this.findFieldLocation(
              schema,
              model.name,
              field.name
            );
            diagnostics.push({
              severity: "info",
              message: `Field name '${field.name}' should use camelCase convention`,
              line: fieldLocation.line,
              column: fieldLocation.column,
              endLine: fieldLocation.line,
              endColumn: fieldLocation.column + field.name.length,
            });
          }
        }

        // Check for missing @@map attribute when model name differs from table name
        const hasMapAttr = model.attributes.some((attr) =>
          attr.includes("@@map")
        );
        if (!hasMapAttr) {
          diagnostics.push({
            severity: "info",
            message: `Consider adding @@map("table_name") if the database table name differs from '${model.name}'`,
            line: modelLocation.line,
            column: modelLocation.column,
            endLine: modelLocation.line,
            endColumn: modelLocation.column + model.name.length,
          });
        }
      }

      // Validate enums
      for (const enumDef of enums) {
        if (enumDef.values.length === 0) {
          const enumLocation = this.findEnumLocation(schema, enumDef.name);
          diagnostics.push({
            severity: "error",
            message: `Enum '${enumDef.name}' has no values`,
            line: enumLocation.line,
            column: enumLocation.column,
            endLine: enumLocation.line,
            endColumn: enumLocation.column + enumDef.name.length,
          });
        }

        // Check enum naming convention
        if (!/^[A-Z][a-zA-Z0-9]*$/.test(enumDef.name)) {
          const enumLocation = this.findEnumLocation(schema, enumDef.name);
          diagnostics.push({
            severity: "info",
            message: `Enum name '${enumDef.name}' should use PascalCase convention`,
            line: enumLocation.line,
            column: enumLocation.column,
            endLine: enumLocation.line,
            endColumn: enumLocation.column + enumDef.name.length,
          });
        }
      }

      // Check for syntax errors in attributes
      this.validateAttributeSyntax(schema, diagnostics);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      diagnostics.push({
        severity: "error",
        message: `Schema validation error: ${errorMessage}`,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      });
    }

    return diagnostics;
  }

  /**
   * Extract models from schema
   */
  private static extractModels(schema: string): Array<{
    name: string;
    fields: Array<{
      name: string;
      type: string;
      attributes: string[];
      isArray: boolean;
    }>;
    attributes: string[];
  }> {
    const models: Array<{
      name: string;
      fields: Array<{
        name: string;
        type: string;
        attributes: string[];
        isArray: boolean;
      }>;
      attributes: string[];
    }> = [];

    const modelRegex = /model\s+([A-Z][a-zA-Z0-9]*)\s*\{([^}]*)\}/g;
    let match;

    while ((match = modelRegex.exec(schema)) !== null) {
      const modelName = match[1];
      const modelBody = match[2];

      const fields: Array<{
        name: string;
        type: string;
        attributes: string[];
        isArray: boolean;
      }> = [];
      const attributes: string[] = [];

      // Parse fields
      const fieldLines = modelBody.split("\n").filter((line) => line.trim());
      for (const line of fieldLines) {
        const trimmed = line.trim();

        // Skip comments and empty lines
        if (trimmed.startsWith("//") || !trimmed) continue;

        // Model-level attributes
        if (trimmed.startsWith("@@")) {
          attributes.push(trimmed);
          continue;
        }

        // Field definition
        const fieldMatch = trimmed.match(
          /^([a-zA-Z_]\w*)\s+([A-Z][a-zA-Z0-9]*)([\[\]?]*)\s*(.*)?$/
        );
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          let fieldType = fieldMatch[2];
          const modifiers = fieldMatch[3] || "";
          const fieldAttributes = fieldMatch[4] || "";

          const isArray = modifiers.includes("[]");

          fields.push({
            name: fieldName,
            type: fieldType,
            attributes: fieldAttributes.split(/\s+/).filter(Boolean),
            isArray,
          });
        }
      }

      models.push({ name: modelName, fields, attributes });
    }

    return models;
  }

  /**
   * Extract enums from schema
   */
  private static extractEnums(schema: string): Array<{
    name: string;
    values: string[];
  }> {
    const enums: Array<{ name: string; values: string[] }> = [];
    const enumRegex = /enum\s+([A-Z][a-zA-Z0-9]*)\s*\{([^}]*)\}/g;
    let match;

    while ((match = enumRegex.exec(schema)) !== null) {
      const enumName = match[1];
      const enumBody = match[2];

      const values = enumBody
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//"));

      enums.push({ name: enumName, values });
    }

    return enums;
  }

  /**
   * Check if a type is a relation type (model reference)
   */
  private static isRelationType(
    type: string,
    models: Array<{ name: string }>,
    enums: Array<{ name: string }>
  ): boolean {
    const scalarTypes = [
      "String",
      "Int",
      "Float",
      "Boolean",
      "DateTime",
      "Json",
      "Bytes",
      "Decimal",
      "BigInt",
    ];

    if (scalarTypes.includes(type)) return false;
    if (enums.some((e) => e.name === type)) return false;

    return models.some((m) => m.name === type);
  }

  /**
   * Check if a type is valid in Prisma
   */
  private static isValidPrismaType(
    type: string,
    models: Array<{ name: string }>,
    enums: Array<{ name: string }>
  ): boolean {
    const scalarTypes = [
      "String",
      "Int",
      "Float",
      "Boolean",
      "DateTime",
      "Json",
      "Bytes",
      "Decimal",
      "BigInt",
    ];

    return (
      scalarTypes.includes(type) ||
      models.some((m) => m.name === type) ||
      enums.some((e) => e.name === type)
    );
  }

  /**
   * Validate attribute syntax
   */
  private static validateAttributeSyntax(
    schema: string,
    diagnostics: ValidationDiagnostic[]
  ): void {
    const lines = schema.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check for malformed @relation attributes
      if (trimmed.includes("@relation") && !trimmed.includes("//")) {
        // Basic validation - check for matching parentheses
        const openParens = (trimmed.match(/\(/g) || []).length;
        const closeParens = (trimmed.match(/\)/g) || []).length;

        if (openParens !== closeParens) {
          diagnostics.push({
            severity: "error",
            message: "Mismatched parentheses in @relation attribute",
            line: i + 1,
            column: trimmed.indexOf("@relation") + 1,
            endLine: i + 1,
            endColumn: trimmed.length + 1,
          });
        }

        // Check for fields and references in non-array relations
        if (
          !trimmed.includes("[]") &&
          (!trimmed.includes("fields:") || !trimmed.includes("references:"))
        ) {
          // Only warn if this is not a back-relation (array type)
          const typeMatch = trimmed.match(/\s+([A-Z][a-zA-Z0-9]*)\s/);
          if (typeMatch) {
            diagnostics.push({
              severity: "warning",
              message:
                "@relation should include both fields and references for forward relations",
              line: i + 1,
              column: trimmed.indexOf("@relation") + 1,
              endLine: i + 1,
              endColumn: trimmed.length + 1,
            });
          }
        }
      }

      // Check for malformed @default attributes
      if (trimmed.includes("@default") && !trimmed.includes("//")) {
        const openParens = (trimmed.match(/\(/g) || []).length;
        const closeParens = (trimmed.match(/\)/g) || []).length;

        if (openParens !== closeParens) {
          diagnostics.push({
            severity: "error",
            message: "Mismatched parentheses in @default attribute",
            line: i + 1,
            column: trimmed.indexOf("@default") + 1,
            endLine: i + 1,
            endColumn: trimmed.length + 1,
          });
        }
      }
    }
  }

  /**
   * Find model location in schema
   */
  private static findModelLocation(
    schema: string,
    modelName: string
  ): { line: number; column: number } {
    const lines = schema.split("\n");
    const regex = new RegExp(`model\\s+${modelName}\\s*\\{`, "i");

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(regex);
      if (match) {
        return {
          line: i + 1,
          column: match.index! + match[0].indexOf(modelName) + 1,
        };
      }
    }

    return { line: 1, column: 1 };
  }

  /**
   * Find enum location in schema
   */
  private static findEnumLocation(
    schema: string,
    enumName: string
  ): { line: number; column: number } {
    const lines = schema.split("\n");
    const regex = new RegExp(`enum\\s+${enumName}\\s*\\{`, "i");

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(regex);
      if (match) {
        return {
          line: i + 1,
          column: match.index! + match[0].indexOf(enumName) + 1,
        };
      }
    }

    return { line: 1, column: 1 };
  }

  /**
   * Find field location in schema
   */
  private static findFieldLocation(
    schema: string,
    modelName: string,
    fieldName: string
  ): { line: number; column: number } {
    const lines = schema.split("\n");
    let inModel = false;
    const modelRegex = new RegExp(`model\\s+${modelName}\\s*\\{`, "i");

    for (let i = 0; i < lines.length; i++) {
      if (modelRegex.test(lines[i])) {
        inModel = true;
        continue;
      }

      if (inModel) {
        const fieldRegex = new RegExp(`^\\s*${fieldName}\\s+`, "i");
        const match = lines[i].match(fieldRegex);
        if (match && match.index !== undefined) {
          return { line: i + 1, column: match.index + match[0].indexOf(fieldName) + 1 };
        }

        if (lines[i].includes("}")) {
          break;
        }
      }
    }

    return { line: 1, column: 1 };
  }
}
