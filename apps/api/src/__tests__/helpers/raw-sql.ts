import { Prisma } from "@prisma/client";
import type { Mock } from "vitest";

/** A mocked $executeRaw call as one statement: fragments inlined, `?` for each value. */
export function rawSql(mock: unknown, i = -1): { text: string; values: unknown[] } {
  const [parts, ...values] = (mock as Mock).mock.calls.at(i)! as [TemplateStringsArray, ...unknown[]];
  const statement = Prisma.sql(parts, ...values);
  return { text: statement.sql, values: statement.values };
}
