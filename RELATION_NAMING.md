# Relation Naming Convention

This document explains how the SQL to Prisma converter generates relation names and field names for foreign keys.

## Design Principles

1. **Meaningful names over numeric suffixes**: Never use `author2`, `createdBy2`, etc.
2. **Use full FK column context**: Extract all semantic meaning from foreign key column names
3. **Progressive disambiguation**: Use increasingly specific context when collisions occur
4. **Consistency**: Same naming logic for both forward and back relations
5. **Smart composite FK handling**: For composite FKs, use the business key for naming (not scoping columns)

## Field Naming Strategy

### Forward Relations (Many-to-One)

For a foreign key in the source table, the field name is derived from the FK column:

```sql
-- Simple FK
author_id INTEGER REFERENCES users(id)
→ author User @relation(...)

-- Complex FK with full context
created_by_user_id INTEGER REFERENCES users(id)
→ createdByUser User @relation(...)

-- Administrative context
approved_by_admin_id INTEGER REFERENCES admins(id)
→ approvedByAdmin Admin @relation(...)
```

### Back Relations (One-to-Many)

For the reverse side, we combine the source table name (pluralized) with FK context:

```sql
-- posts.author_id → users(id)
-- In User model:
postsAsAuthor Post[] @relation(...)

-- posts.created_by_user_id → users(id)
-- In User model:
postsCreatedByUser Post[] @relation(...)

-- tickets.assigned_to_id → users(id)
-- In User model:
ticketsAssignedTo Ticket[] @relation(...)
```

## Collision Handling

When a field name already exists, we progressively add more context:

### Strategy 1: Use Full FK Column Context
```sql
-- If "author" already exists, try full column context
author_user_id → authorUser
```

### Strategy 2: Add Source Table Prefix
```sql
-- If that still collides, add source table
author → postsAuthor (for back-relation in User from posts table)
```

### Strategy 3: Include _id Suffix
```sql
-- Very rare: keep the _id part
author_id → authorId
```

### Strategy 4: Combine Source + Full Column
```sql
-- Extremely rare
posts_author_user_id → postsAuthorUser
```

### Strategy 5: Numeric Suffix (Last Resort)
```sql
-- Should never happen in practice
-- Only if all above strategies fail
→ authorUser2
```

## Relation Name Convention

Relation names always include semantic context from FK columns:

```sql
-- Format: {SourceTable}To{TargetTable}_{Context}

posts.author_id → users(id)
→ @relation("PostToUser_Author")

posts.editor_id → users(id)
→ @relation("PostToUser_Editor")

posts.reviewer_id → users(id)
→ @relation("PostToUser_Reviewer")
```

This ensures:
- **Consistency**: All relations between same tables follow the same pattern
- **Clarity**: The relation name indicates the relationship's semantic meaning
- **Uniqueness**: Each relation has a distinct, descriptive name

## Examples

### Multiple FKs to Same Table

```sql
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title TEXT,
  author_id INTEGER REFERENCES users(id),
  editor_id INTEGER REFERENCES users(id),
  reviewer_id INTEGER REFERENCES users(id)
);
```

**Generated Prisma:**

```prisma
model Post {
  id         Int      @id @default(autoincrement())
  title      String?
  authorId   Int      @map("author_id")
  editorId   Int?     @map("editor_id")
  reviewerId Int?     @map("reviewer_id")

  // Relations
  author   User  @relation("PostToUser_Author", fields: [authorId], references: [id])
  editor   User? @relation("PostToUser_Editor", fields: [editorId], references: [id])
  reviewer User? @relation("PostToUser_Reviewer", fields: [reviewerId], references: [id])
}

model User {
  id Int @id @default(autoincrement())

  // Relations
  postsAsAuthor   Post[] @relation("PostToUser_Author")
  postsAsEditor   Post[] @relation("PostToUser_Editor")
  postsAsReviewer Post[] @relation("PostToUser_Reviewer")
}
```

### Complex FK Column Names

```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  created_by_admin_id INTEGER REFERENCES admins(id),
  approved_by_manager_id INTEGER REFERENCES managers(id)
);
```

**Generated Prisma:**

```prisma
model AuditLog {
  id                   Int @id @default(autoincrement())
  createdByAdminId     Int @map("created_by_admin_id")
  approvedByManagerId  Int @map("approved_by_manager_id")

  // Relations
  createdByAdmin     Admin   @relation("AuditLogToAdmin_CreatedByAdmin", ...)
  approvedByManager  Manager @relation("AuditLogToManager_ApprovedByManager", ...)
}

model Admin {
  id Int @id @default(autoincrement())

  // Relations
  auditLogsCreatedByAdmin AuditLog[] @relation("AuditLogToAdmin_CreatedByAdmin")
}

model Manager {
  id Int @id @default(autoincrement())

  // Relations
  auditLogsApprovedByManager AuditLog[] @relation("AuditLogToManager_ApprovedByManager")
}
```

## Composite Foreign Keys

For multi-tenant or scoped schemas with composite foreign keys, the converter intelligently selects the business key for naming rather than the scoping column.

### Naming Column Selection Strategy

1. **If any referenced column is `id`** (primary key), use the corresponding FK column
2. **Otherwise**, use the last column (business keys typically come after scoping columns)
3. **For single-column FKs**, this simply uses that column

### Example: Multi-Tenant Schema

```sql
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255)
);

CREATE TABLE users (
  tenant_id INTEGER NOT NULL,
  id SERIAL NOT NULL,
  name VARCHAR(255),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE posts (
  tenant_id INTEGER NOT NULL,
  id SERIAL NOT NULL,
  author_id INTEGER NOT NULL,
  title TEXT,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  -- Composite FK: (tenant_id, author_id) → users(tenant_id, id)
  FOREIGN KEY (tenant_id, author_id) REFERENCES users(tenant_id, id)
);
```

**Without smart column selection** (BAD):
```prisma
// Would use tenant_id for naming - wrong! ❌
tenant User @relation("PostToUser_Tenant", fields: [tenantId, authorId], ...)
```

**With smart column selection** (GOOD):
```prisma
// Uses author_id for naming - correct! ✓
author User @relation("PostToUser_Author", fields: [tenantId, authorId], references: [tenantId, id])

// Back-relation also uses author context
postsAsAuthor Post[] @relation("PostToUser_Author")
```

### How It Works

The `selectNamingColumn()` method:
1. Checks if any `referencedColumns` is `'id'` (the primary key)
2. If found, uses the corresponding column from `constraint.columns`
3. For `(tenant_id, author_id) → (tenant_id, id)`:
   - Referenced column `id` is at index 1
   - Returns `author_id` (the column at index 1)
4. This gives us the business key (`author_id`) instead of the scoping key (`tenant_id`)

## Benefits

1. **No meaningless numeric suffixes**: All names are semantically meaningful
2. **Readable schemas**: Field names clearly indicate their purpose
3. **Maintainable**: Easy to understand relationships without referring to SQL
4. **Predictable**: Consistent naming across the entire schema
5. **Collision-safe**: Multiple strategies ensure unique names without ambiguity
6. **Multi-tenant friendly**: Composite FKs use business keys for naming, not scoping columns
