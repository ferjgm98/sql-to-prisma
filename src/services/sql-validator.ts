import { SQLParser } from "./sql-parser";

export interface ValidationDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export class SQLValidator {
  /**
   * Validates SQL content and returns diagnostics (errors, warnings, info)
   */
  static validate(sql: string): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = [];

    if (!sql.trim()) {
      return diagnostics;
    }

    try {
      // Parse the SQL to catch syntax errors
      const parseResult = SQLParser.parseSQL(sql);

      // Check for empty schema
      if (parseResult.tables.length === 0 && parseResult.enums.length === 0) {
        diagnostics.push({
          severity: "warning",
          message: "No valid CREATE TABLE or CREATE TYPE statements found",
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
        });
        return diagnostics;
      }

      // Validate each table
      for (const table of parseResult.tables) {
        const tableLocation = this.findTableLocation(sql, table.name);

        // Check for tables without primary keys
        const hasPrimaryKey =
          table.columns.some((col) => col.isPrimaryKey) ||
          table.constraints.some((c) => c.type === "PRIMARY KEY");

        if (!hasPrimaryKey) {
          diagnostics.push({
            severity: "warning",
            message: `Table '${table.name}' has no primary key`,
            line: tableLocation.line,
            column: tableLocation.column,
            endLine: tableLocation.line,
            endColumn: tableLocation.column + table.name.length,
          });
        }

        // Check for foreign key references to non-existent tables
        for (const constraint of table.constraints) {
          if (constraint.type === "FOREIGN KEY" && constraint.referencedTable) {
            const referencedTableExists = parseResult.tables.some(
              (t) =>
                t.name.toLowerCase() ===
                constraint.referencedTable!.toLowerCase()
            );

            if (!referencedTableExists) {
              const constraintLocation = this.findConstraintLocation(
                sql,
                table.name,
                constraint.columns[0]
              );
              diagnostics.push({
                severity: "error",
                message: `Foreign key references non-existent table '${constraint.referencedTable}'`,
                line: constraintLocation.line,
                column: constraintLocation.column,
                endLine: constraintLocation.line,
                endColumn: constraintLocation.column + 20,
              });
            }

            // Check if referenced columns exist
            if (constraint.referencedColumns && referencedTableExists) {
              const referencedTable = parseResult.tables.find(
                (t) =>
                  t.name.toLowerCase() ===
                  constraint.referencedTable!.toLowerCase()
              );
              for (const refCol of constraint.referencedColumns) {
                const columnExists = referencedTable?.columns.some(
                  (c) => c.name.toLowerCase() === refCol.toLowerCase()
                );
                if (!columnExists) {
                  const constraintLocation = this.findConstraintLocation(
                    sql,
                    table.name,
                    constraint.columns[0]
                  );
                  diagnostics.push({
                    severity: "error",
                    message: `Foreign key references non-existent column '${refCol}' in table '${constraint.referencedTable}'`,
                    line: constraintLocation.line,
                    column: constraintLocation.column,
                    endLine: constraintLocation.line,
                    endColumn: constraintLocation.column + 20,
                  });
                }
              }
            }
          }
        }

        // Check for columns with invalid types
        for (const column of table.columns) {
          const columnLocation = this.findColumnLocation(
            sql,
            table.name,
            column.name
          );

          // Check for unsupported types
          const supportedTypes = [
            "SERIAL",
            "BIGSERIAL",
            "INTEGER",
            "INT",
            "BIGINT",
            "SMALLINT",
            "VARCHAR",
            "TEXT",
            "CHAR",
            "BOOLEAN",
            "BOOL",
            "TIMESTAMP",
            "TIMESTAMPTZ",
            "DATE",
            "TIME",
            "DECIMAL",
            "NUMERIC",
            "FLOAT",
            "DOUBLE",
            "REAL",
            "UUID",
            "JSON",
            "JSONB",
            "BYTEA",
          ];

          // Extract base type (strip array brackets [] for validation)
          const baseType = column.type.replace(/\[\]$/, "").toUpperCase();

          if (
            !column.isEnum &&
            !supportedTypes.includes(baseType)
          ) {
            diagnostics.push({
              severity: "warning",
              message: `Column '${column.name}' has potentially unsupported type '${column.type}'`,
              line: columnLocation.line,
              column: columnLocation.column,
              endLine: columnLocation.line,
              endColumn: columnLocation.column + column.name.length,
            });
          }
        }

        // Check for naming convention violations
        if (!/^[a-z][a-z0-9_]*$/.test(table.name)) {
          diagnostics.push({
            severity: "info",
            message: `Table name '${table.name}' should use snake_case convention`,
            line: tableLocation.line,
            column: tableLocation.column,
            endLine: tableLocation.line,
            endColumn: tableLocation.column + table.name.length,
          });
        }

        for (const column of table.columns) {
          if (!/^[a-z][a-z0-9_]*$/.test(column.name)) {
            const columnLocation = this.findColumnLocation(
              sql,
              table.name,
              column.name
            );
            diagnostics.push({
              severity: "info",
              message: `Column name '${column.name}' should use snake_case convention`,
              line: columnLocation.line,
              column: columnLocation.column,
              endLine: columnLocation.line,
              endColumn: columnLocation.column + column.name.length,
            });
          }
        }
      }

      // Validate enums
      for (const enumDef of parseResult.enums) {
        if (enumDef.values.length === 0) {
          const enumLocation = this.findEnumLocation(sql, enumDef.name);
          diagnostics.push({
            severity: "error",
            message: `Enum '${enumDef.name}' has no values`,
            line: enumLocation.line,
            column: enumLocation.column,
            endLine: enumLocation.line,
            endColumn: enumLocation.column + enumDef.name.length,
          });
        }
      }
    } catch (error) {
      // If parsing fails, report a syntax error
      const errorMessage =
        error instanceof Error ? error.message : "Unknown syntax error";
      diagnostics.push({
        severity: "error",
        message: `SQL syntax error: ${errorMessage}`,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      });
    }

    return diagnostics;
  }

  /**
   * Find the location (line, column) of a table in the SQL
   */
  private static findTableLocation(
    sql: string,
    tableName: string
  ): { line: number; column: number } {
    const lines = sql.split("\n");
    const regex = new RegExp(
      `CREATE\\s+TABLE\\s+(?:"${tableName}"|${tableName})`,
      "i"
    );

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(regex);
      if (match) {
        return {
          line: i + 1,
          column: match.index! + match[0].indexOf(tableName) + 1,
        };
      }
    }

    return { line: 1, column: 1 };
  }

  /**
   * Find the location of a column in the SQL
   */
  private static findColumnLocation(
    sql: string,
    tableName: string,
    columnName: string
  ): { line: number; column: number } {
    const lines = sql.split("\n");
    let inTable = false;
    const tableRegex = new RegExp(
      `CREATE\\s+TABLE\\s+(?:"${tableName}"|${tableName})`,
      "i"
    );

    for (let i = 0; i < lines.length; i++) {
      if (tableRegex.test(lines[i])) {
        inTable = true;
        continue;
      }

      if (inTable) {
        const columnRegex = new RegExp(
          `(?:"${columnName}"|\\b${columnName}\\b)\\s+`,
          "i"
        );
        const match = lines[i].match(columnRegex);
        if (match && match.index !== undefined) {
          return { line: i + 1, column: match.index + 1 };
        }

        // Stop if we've reached the end of the table
        if (lines[i].includes(");")) {
          break;
        }
      }
    }

    return { line: 1, column: 1 };
  }

  /**
   * Find the location of a constraint in the SQL
   */
  private static findConstraintLocation(
    sql: string,
    tableName: string,
    columnName: string
  ): { line: number; column: number } {
    const lines = sql.split("\n");
    let inTable = false;
    const tableRegex = new RegExp(
      `CREATE\\s+TABLE\\s+(?:"${tableName}"|${tableName})`,
      "i"
    );

    for (let i = 0; i < lines.length; i++) {
      if (tableRegex.test(lines[i])) {
        inTable = true;
        continue;
      }

      if (inTable) {
        // Look for REFERENCES or FOREIGN KEY mentioning this column
        if (
          lines[i].includes("REFERENCES") ||
          lines[i].includes("FOREIGN KEY")
        ) {
          const columnMatch = lines[i].indexOf(columnName);
          if (columnMatch !== -1) {
            return { line: i + 1, column: columnMatch + 1 };
          }
        }

        if (lines[i].includes(");")) {
          break;
        }
      }
    }

    // Also check ALTER TABLE statements
    const alterRegex = new RegExp(
      `ALTER\\s+TABLE\\s+(?:"${tableName}"|${tableName})`,
      "i"
    );
    for (let i = 0; i < lines.length; i++) {
      if (alterRegex.test(lines[i])) {
        return { line: i + 1, column: 1 };
      }
    }

    return { line: 1, column: 1 };
  }

  /**
   * Find the location of an enum in the SQL
   */
  private static findEnumLocation(
    sql: string,
    enumName: string
  ): { line: number; column: number } {
    const lines = sql.split("\n");
    const regex = new RegExp(
      `CREATE\\s+TYPE\\s+(?:"${enumName}"|${enumName})`,
      "i"
    );

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
}
