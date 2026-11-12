import { Prisma } from "@prisma/client";

/**
 * A table or column name for raw SQL, quoted the way the database expects:
 * backticks on MySQL, double quotes on SQLite and PostgreSQL (which also needs
 * them to keep Prisma's camelCase names). Values never go here — they go through
 * Prisma's tagged template, which writes the right placeholders for each
 * database.
 */
export function ident(name: string): Prisma.Sql {
  if (!/^\w+$/.test(name)) throw new Error(`Not an SQL identifier: ${name}`);
  return Prisma.raw(/^mysql:/i.test(process.env.DATABASE_URL ?? "") ? `\`${name}\`` : `"${name}"`);
}
