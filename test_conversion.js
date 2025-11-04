// Test script to verify index and comment support
import { readFileSync } from 'fs';
import { SQLParser } from './src/services/sql-parser.ts';
import { PrismaGenerator } from './src/services/prisma-generator.ts';

const sql = readFileSync('./test_indexes_comments.sql', 'utf-8');

console.log('=== Parsing SQL ===\n');
const parseResult = SQLParser.parseSQL(sql);

console.log('Tables:', parseResult.tables.map(t => t.name).join(', '));
console.log('\nTable Details:');
parseResult.tables.forEach(table => {
  console.log(`\n${table.name}:`);
  console.log(`  Comment: ${table.comment || '(none)'}`);
  console.log(`  Indexes: ${table.indexes.length}`);
  table.indexes.forEach(idx => {
    console.log(`    - ${idx.unique ? 'UNIQUE' : 'INDEX'} on [${idx.columns.join(', ')}]`);
  });
  console.log(`  Columns with comments:`);
  table.columns.filter(c => c.comment).forEach(col => {
    console.log(`    - ${col.name}: ${col.comment}`);
  });
});

console.log('\n\n=== Generated Prisma Schema ===\n');
const prismaSchema = PrismaGenerator.generatePrismaSchema(parseResult);
console.log(prismaSchema);
