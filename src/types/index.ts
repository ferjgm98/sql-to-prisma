// SQL parsing types
export interface SQLTable {
  name: string;
  columns: SQLColumn[];
  constraints: SQLConstraint[];
  indexes: SQLIndex[];
  comment?: string;
}

export interface SQLEnum {
  name: string;
  values: string[];
}

export interface SQLColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  length?: number;
  isEnum?: boolean;
  comment?: string;
}

export interface SQLConstraint {
  type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK';
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface SQLIndex {
  name?: string;
  columns: string[];
  unique: boolean;
  using?: string; // e.g., BTREE, HASH, GIN, etc.
}

// Prisma generation types
export interface PrismaModel {
  name: string;
  fields: PrismaField[];
  attributes: string[];
  comment?: string;
}

export interface PrismaEnum {
  name: string;
  values: string[];
}

export interface PrismaField {
  name: string;
  type: string;
  attributes: string[];
  isOptional: boolean;
  isArray: boolean;
  comment?: string;
}

// Parser result types
export interface SQLParseResult {
  tables: SQLTable[];
  enums: SQLEnum[];
}