import {
  SQLTable,
  PrismaModel,
  PrismaField,
  SQLParseResult,
  PrismaEnum,
  SQLEnum,
} from "@/types";

export class PrismaGenerator {
  static generatePrismaSchema(parseResult: SQLParseResult): string {
    const enums = this.convertEnumsToPrismaEnums(parseResult.enums);
    const models = this.convertTablesToModels(parseResult.tables, enums);

    const header = `// Generated Prisma schema
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

`;

    const enumsString =
      enums.length > 0
        ? enums.map((enumDef) => this.formatEnum(enumDef)).join("\n\n") + "\n\n"
        : "";
    const modelsString = models
      .map((model) => this.formatModel(model))
      .join("\n\n");

    return header + enumsString + modelsString;
  }

  private static convertTablesToModels(
    tables: SQLTable[],
    enums: PrismaEnum[] = []
  ): PrismaModel[] {
    const models: PrismaModel[] = [];
    const usedRelationNames = new Set<string>();

    // First pass: create basic models with scalar fields only
    for (const table of tables) {
      const model = this.createBasicModel(table, enums);
      models.push(model);
    }

    // Second pass: add relation fields and bidirectional relations
    for (const table of tables) {
      const model = models.find(
        (m) => m.name === this.toPascalCase(table.name)
      )!;

      for (const constraint of table.constraints) {
        if (constraint.type === "FOREIGN KEY" && constraint.referencedTable) {
          // Select the best column for naming (handles composite FKs intelligently)
          const namingColumn = this.selectNamingColumn(constraint);

          // Generate a descriptive, unique relation name for this FK constraint
          const relationName = this.generateDescriptiveRelationName(
            table.name,
            constraint.referencedTable,
            namingColumn,
            usedRelationNames
          );

          // Add forward relation to current model
          const relationField = this.createRelationField(
            constraint,
            table,
            relationName,
            model,
            namingColumn
          );
          if (relationField) {
            model.fields.push(relationField);
          }

          // Add back-relation to referenced model using the same relation name
          const referencedModel = models.find(
            (m) => m.name === this.toPascalCase(constraint.referencedTable!)
          )!;
          if (referencedModel) {
            const backRelationField = this.createBackRelationField(
              constraint,
              table,
              relationName,
              referencedModel,
              namingColumn
            );
            if (backRelationField) {
              referencedModel.fields.push(backRelationField);
            }
          }
        }
      }
    }

    return models;
  }

  private static createBasicModel(
    table: SQLTable,
    enums: PrismaEnum[] = []
  ): PrismaModel {
    const modelName = this.toPascalCase(table.name);
    const fields: PrismaField[] = [];

    // Convert columns to scalar fields only
    for (const column of table.columns) {
      const field = this.convertColumnToField(column, table, enums);
      fields.push(field);
    }

    const attributes: string[] = [];

    // Add index attributes
    if (table.indexes && table.indexes.length > 0) {
      for (const index of table.indexes) {
        const indexColumns = index.columns.map(col => this.toCamelCase(col));
        if (index.unique) {
          attributes.push(`@@unique([${indexColumns.join(', ')}])`);
        } else {
          attributes.push(`@@index([${indexColumns.join(', ')}])`);
        }
      }
    }

    if (table.name !== modelName.toLowerCase()) {
      attributes.push(`@@map("${table.name}")`);
    }

    return {
      name: modelName,
      fields,
      attributes,
      comment: table.comment,
    };
  }

  private static convertColumnToField(
    column: SQLTable["columns"][0],
    _table: SQLTable,
    enums: PrismaEnum[] = []
  ): PrismaField {
    const name = this.toCamelCase(column.name);
    const type = this.mapSQLTypeToPrismaType(
      column.type,
      column.isEnum ? enums : []
    );
    const attributes: string[] = [];

    if (column.isPrimaryKey) {
      if (column.type === "SERIAL" || column.type === "BIGSERIAL") {
        attributes.push("@id @default(autoincrement())");
      } else if (
        column.type === "UUID" &&
        column.defaultValue?.includes("gen_random_uuid")
      ) {
        attributes.push('@id @default(dbgenerated("gen_random_uuid()"))');
      } else {
        attributes.push("@id");
      }
    }

    if (column.isUnique && !column.isPrimaryKey) {
      attributes.push("@unique");
    }

    if (column.defaultValue && !column.isPrimaryKey) {
      const upperDefault = column.defaultValue.toUpperCase();
      if (
        upperDefault === "CURRENT_TIMESTAMP" ||
        upperDefault === "NOW()" ||
        upperDefault === "(NOW())"
      ) {
        attributes.push("@default(now())");
      } else if (column.defaultValue.includes("gen_random_uuid")) {
        attributes.push('@default(dbgenerated("gen_random_uuid()"))');
      } else if (
        column.defaultValue === "true" ||
        column.defaultValue === "false"
      ) {
        attributes.push(`@default(${column.defaultValue})`);
      } else if (!isNaN(Number(column.defaultValue))) {
        attributes.push(`@default(${column.defaultValue})`);
      } else if (
        upperDefault.includes("NOW()") ||
        upperDefault.includes("CURRENT_TIMESTAMP")
      ) {
        attributes.push("@default(now())");
      } else if (
        column.defaultValue.includes("::json") ||
        column.defaultValue.includes("::jsonb")
      ) {
        // Handle PostgreSQL JSON/JSONB type casts with dbgenerated()
        const cleanedValue = column.defaultValue.replace(/^\(|\)$/g, ""); // Remove outer parentheses if present
        attributes.push(`@default(dbgenerated("${cleanedValue}"))`);
      } else {
        attributes.push(`@default("${column.defaultValue}")`);
      }
    }

    if (
      column.type.includes("TIMESTAMP") &&
      column.name.toLowerCase().includes("updated")
    ) {
      attributes.push("@updatedAt");
    }

    if (column.name !== name) {
      attributes.push(`@map("${column.name}")`);
    }

    // Add @db.Uuid for UUID columns in PostgreSQL
    if (column.type === "UUID") {
      attributes.push("@db.Uuid");
    }

    // Add @db.JsonB for JSON/JSONB columns in PostgreSQL
    if (column.type === "JSONB") {
      attributes.push("@db.JsonB");
    } else if (column.type === "JSON") {
      attributes.push("@db.Json");
    }

    // Fixed optionality: FK fields should be optional based on column.nullable only
    return {
      name,
      type,
      attributes,
      isOptional: column.nullable && !column.isPrimaryKey,
      isArray: false,
      comment: column.comment,
    };
  }

  private static createRelationField(
    constraint: SQLTable["constraints"][0],
    table: SQLTable,
    relationName: string,
    model: PrismaModel,
    namingColumn: string
  ): PrismaField | null {
    if (
      !constraint.referencedTable ||
      !constraint.columns.length ||
      !constraint.referencedColumns
    )
      return null;

    const referencedModelName = this.toPascalCase(constraint.referencedTable);

    // Generate field name from the selected naming column (not always columns[0])
    const baseFieldName = this.extractRelationFieldName(
      namingColumn,
      constraint.referencedTable
    );
    const fieldName = this.ensureUniqueFieldName(
      baseFieldName,
      model,
      namingColumn,
      table.name
    );

    // Support composite foreign keys
    const foreignKeyFields = constraint.columns.map((col) =>
      this.toCamelCase(col)
    );
    const referencedFields = constraint.referencedColumns.map((col) =>
      this.toCamelCase(col)
    );

    return {
      name: fieldName,
      type: referencedModelName,
      attributes: [
        `@relation("${relationName}", fields: [${foreignKeyFields.join(
          ", "
        )}], references: [${referencedFields.join(", ")}])`,
      ],
      isOptional: this.isRelationOptional(constraint, table),
      isArray: false,
    };
  }

  private static createBackRelationField(
    constraint: SQLTable["constraints"][0],
    table: SQLTable,
    relationName: string,
    referencedModel: PrismaModel,
    namingColumn: string
  ): PrismaField | null {
    if (!constraint.referencedTable || !constraint.columns.length) return null;

    const sourceModelName = this.toPascalCase(table.name);

    // Extract meaningful context from the selected naming column (not always columns[0])
    const fkContext = this.extractForeignKeyContext(namingColumn);
    const baseBackName = this.pluralize(this.toCamelCase(table.name));

    // Always include context if it's meaningful (not just "id" or table name)
    const baseName = this.shouldIncludeContext(fkContext, table.name)
      ? `${baseBackName}${this.toPascalCase(fkContext)}`
      : baseBackName;

    // Ensure the field name is unique in the referenced model
    const fieldName = this.ensureUniqueFieldName(
      baseName,
      referencedModel,
      namingColumn,
      table.name
    );

    return {
      name: fieldName,
      type: sourceModelName,
      attributes: [`@relation("${relationName}")`],
      isOptional: false,
      isArray: true,
    };
  }

  private static pluralize(word: string): string {
    // Basic pluralization with guard to avoid double-pluralizing already-plural table names
    const lower = word.toLowerCase();
    // If it already ends with 's' (common for table names), keep as-is
    if (lower.endsWith("s")) return word;
    if (
      lower.endsWith("sh") ||
      lower.endsWith("ch") ||
      lower.endsWith("x") ||
      lower.endsWith("z")
    )
      return word + "es";
    if (lower.endsWith("y") && !/[aeiou]y$/.test(lower))
      return word.slice(0, -1) + "ies";
    return word + "s";
  }

  /**
   * Selects the best column for naming from a composite FK.
   * For composite FKs like (tenant_id, user_id), we want to use the business key (user_id)
   * rather than the scoping column (tenant_id).
   *
   * Strategy:
   * 1. If any referenced column is 'id' (primary key), use the corresponding FK column
   * 2. Otherwise, use the last column as fallback (business key is usually last)
   * 3. For single-column FKs, this returns constraint.columns[0] unchanged
   */
  private static selectNamingColumn(constraint: SQLTable["constraints"][0]): string {
    if (!constraint.referencedColumns || constraint.columns.length === 1) {
      return constraint.columns[0];
    }

    // Find the index where referencedColumns contains 'id'
    const idIndex = constraint.referencedColumns.findIndex(
      (col) => col.toLowerCase() === "id"
    );

    if (idIndex !== -1 && idIndex < constraint.columns.length) {
      // Use the FK column that references the primary key
      return constraint.columns[idIndex];
    }

    // Fallback: use the last column (business key typically comes after scoping columns)
    return constraint.columns[constraint.columns.length - 1];
  }

  /**
   * Generates a descriptive, unique relation name based on the FK column context.
   * Always includes semantic context for clarity and consistency.
   */
  private static generateDescriptiveRelationName(
    fromTable: string,
    toTable: string,
    fkColumn: string,
    usedNames: Set<string>
  ): string {
    const fromTablePascal = this.toPascalCase(fromTable);
    const toTablePascal = this.toPascalCase(toTable);

    // Extract meaningful context from FK column
    const fkContext = this.extractForeignKeyContext(fkColumn);
    const contextPascal = this.toPascalCase(fkContext);

    // Generate base name with context for clarity
    let baseName: string;
    if (this.shouldIncludeContext(fkContext, fromTable)) {
      // Use context if it's meaningful (e.g., "PostToUser_Author", "PostToUser_Editor")
      baseName = `${fromTablePascal}To${toTablePascal}_${contextPascal}`;
    } else {
      // Fallback to simple name if context is not meaningful
      baseName = `${fromTablePascal}To${toTablePascal}`;
    }

    // Ensure uniqueness by adding numeric suffix if needed
    let uniqueName = baseName;
    let counter = 2;
    while (usedNames.has(uniqueName)) {
      uniqueName = `${baseName}_${counter}`;
      counter++;
    }

    usedNames.add(uniqueName);
    return uniqueName;
  }

  /**
   * Ensures a field name is unique within a model by using progressively more context.
   * Instead of numeric suffixes (like createdBy2), we use more of the FK column name
   * for meaningful disambiguation.
   *
   * Disambiguation strategies (in order of preference):
   * 1. Base name from FK column (e.g., "author" from "author_id")
   * 2. Full FK column context (e.g., "createdByUser" from "created_by_user_id")
   * 3. Source table prefix (e.g., "postsAuthor" for back-relations)
   * 4. Full column name including _id (e.g., "authorId")
   * 5. Source + column (e.g., "postsAuthorId") - very rare
   * 6. Numeric suffix as absolute last resort (should never happen in practice)
   *
   * Examples:
   * - author_id → "author"
   * - created_by_user_id → "createdByUser" (full context)
   * - updated_by_admin_id → "updatedByAdmin" (full context)
   */
  private static ensureUniqueFieldName(
    baseName: string,
    model: PrismaModel,
    fkColumn: string,
    sourceTable: string
  ): string {
    const existingNames = new Set(model.fields.map((f) => f.name));

    // If base name is unique, use it
    if (!existingNames.has(baseName)) {
      return baseName;
    }

    // Strategy 1: Use the full FK column context (without _id suffix)
    const fullContext = this.toCamelCase(fkColumn.replace(/_id$/i, ""));
    if (fullContext !== baseName && !existingNames.has(fullContext)) {
      return fullContext;
    }

    // Strategy 2: Prefix with source table name for back-relations
    // e.g., if User has collision, try "postsAuthor" instead of just "author"
    const withSourcePrefix = this.toCamelCase(sourceTable) + this.toPascalCase(baseName);
    if (!existingNames.has(withSourcePrefix)) {
      return withSourcePrefix;
    }

    // Strategy 3: Use full FK column name as-is (keeping underscores converted to camelCase)
    const fullColumnName = this.toCamelCase(fkColumn);
    if (!existingNames.has(fullColumnName)) {
      return fullColumnName;
    }

    // Strategy 4: Last resort - combine source table + full column name
    // This should be extremely rare
    const lastResort = this.toCamelCase(sourceTable + "_" + fkColumn.replace(/_id$/i, ""));
    if (!existingNames.has(lastResort)) {
      return lastResort;
    }

    // If even this collides, add minimal numeric suffix (should never happen in practice)
    let counter = 2;
    let uniqueName = `${lastResort}${counter}`;
    while (existingNames.has(uniqueName)) {
      uniqueName = `${lastResort}${counter}`;
      counter++;
    }

    return uniqueName;
  }

  /**
   * Determines if the FK context should be included in naming.
   * Returns true if the context is meaningful (not just "id" or matching the table name).
   */
  private static shouldIncludeContext(
    fkContext: string,
    tableName: string
  ): boolean {
    const lowerContext = fkContext.toLowerCase();
    const lowerTable = tableName.toLowerCase();

    // Don't include context if it's just "id" or matches the table name
    if (lowerContext === "id" || lowerContext === lowerTable) {
      return false;
    }

    // Include context if it's meaningful
    return true;
  }

  private static extractRelationFieldName(
    fkColumn: string,
    targetTable: string
  ): string {
    // Handle reverse FK where the FK column is 'id' (primary key)
    if (fkColumn.toLowerCase() === "id") {
      return this.toCamelCase(targetTable);
    }

    // Remove _id suffix if present
    const columnBase = fkColumn.replace(/_id$/i, "");

    // If the column base matches the target table name, just use the table name
    if (columnBase.toLowerCase() === targetTable.toLowerCase()) {
      return this.toCamelCase(targetTable);
    }

    // Use the column base as the field name (provides better context)
    return this.toCamelCase(columnBase);
  }

  private static extractForeignKeyContext(fkColumn: string): string {
    // Extract meaningful context from FK column name for disambiguation
    // Remove _id suffix first
    const cleaned = fkColumn.replace(/_id$/i, "");
    const parts = cleaned.split("_").filter(Boolean);

    // If single part, return it
    if (parts.length === 1) {
      return parts[0];
    }

    // For multi-part columns, return all parts joined with underscore
    // This preserves full context like "created_by_user" or "assigned_to_manager"
    // The caller can decide how much to use
    return parts.join("_");
  }

  private static isRelationOptional(
    constraint: SQLTable["constraints"][0],
    table: SQLTable
  ): boolean {
    // Relation is optional if any of the foreign key columns are nullable
    return constraint.columns.some((colName) => {
      const column = table.columns.find((col) => col.name === colName);
      return column?.nullable || false;
    });
  }

  private static mapSQLTypeToPrismaType(
    sqlType: string,
    enums: PrismaEnum[] = []
  ): string {
    // First check if this is an enum type by comparing with enum names
    const expectedEnumName = this.toPascalCase(sqlType);
    const matchingEnum = enums.find(
      (enumDef) => enumDef.name === expectedEnumName
    );
    if (matchingEnum) {
      return matchingEnum.name;
    }

    const type = sqlType.toUpperCase();

    switch (type) {
      case "SERIAL":
      case "BIGSERIAL":
      case "INTEGER":
      case "INT":
      case "BIGINT":
        return "Int";
      case "VARCHAR":
      case "TEXT":
      case "CHAR":
        return "String";
      case "BOOLEAN":
      case "BOOL":
        return "Boolean";
      case "TIMESTAMP":
      case "TIMESTAMPTZ":
      case "DATE":
      case "TIME":
        return "DateTime";
      case "DECIMAL":
      case "NUMERIC":
      case "FLOAT":
      case "DOUBLE":
      case "REAL":
        return "Float";
      case "UUID":
        return "String";
      case "JSON":
      case "JSONB":
        return "Json";
      default:
        return "String";
    }
  }

  private static formatModel(model: PrismaModel): string {
    let result = "";

    // Add model comment if present
    if (model.comment) {
      result += `/// ${model.comment}\n`;
    }

    result += `model ${model.name} {\n`;

    // Find the longest field name for alignment
    const maxFieldLength = Math.max(
      ...model.fields.map((field) => field.name.length)
    );
    const maxTypeLength = Math.max(
      ...model.fields
        .map(
          (field) =>
            field.type +
            (field.isOptional ? "?" : "") +
            (field.isArray ? "[]" : "")
        )
        .map((t) => t.length)
    );

    // Separate scalar fields from relation fields
    const scalarFields = model.fields.filter(
      (field) => !this.isRelationField(field)
    );
    const relationFields = model.fields.filter((field) =>
      this.isRelationField(field)
    );

    // Add scalar fields first
    for (const field of scalarFields) {
      // Add field comment if present
      if (field.comment) {
        result += `  /// ${field.comment}\n`;
      }

      const fieldName = field.name.padEnd(maxFieldLength);
      const fieldType = (
        field.type +
        (field.isOptional ? "?" : "") +
        (field.isArray ? "[]" : "")
      ).padEnd(maxTypeLength);
      const attributes = field.attributes.join(" ");

      result += `  ${fieldName} ${fieldType}`;
      if (attributes) {
        result += ` ${attributes}`;
      }
      result += "\n";
    }

    // Add relations with comment separator if there are any
    if (relationFields.length > 0) {
      result += "\n  // Relations\n";
      for (const field of relationFields) {
        // Add field comment if present
        if (field.comment) {
          result += `  /// ${field.comment}\n`;
        }

        const fieldName = field.name.padEnd(maxFieldLength);
        const fieldType = (
          field.type +
          (field.isOptional ? "?" : "") +
          (field.isArray ? "[]" : "")
        ).padEnd(maxTypeLength);
        const attributes = field.attributes.join(" ");

        result += `  ${fieldName} ${fieldType}`;
        if (attributes) {
          result += ` ${attributes}`;
        }
        result += "\n";
      }
    }

    if (model.attributes.length > 0) {
      result += "\n";
      for (const attribute of model.attributes) {
        result += `  ${attribute}\n`;
      }
    }

    result += "}";
    return result;
  }

  private static isRelationField(field: PrismaField): boolean {
    // A field is a relation if it has @relation attribute or is an array of a custom type
    return field.attributes.some((attr) => attr.includes("@relation"));
  }

  private static toPascalCase(str: string): string {
    return str
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join("");
  }

  private static toCamelCase(str: string): string {
    const pascal = this.toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  }

  private static convertEnumsToPrismaEnums(enums: SQLEnum[]): PrismaEnum[] {
    return enums.map((enumDef) => ({
      name: this.toPascalCase(enumDef.name),
      values: enumDef.values,
    }));
  }

  private static formatEnum(enumDef: PrismaEnum): string {
    const values = enumDef.values.map((value) => `  ${value}`).join("\n");
    return `enum ${enumDef.name} {\n${values}\n}`;
  }
}
