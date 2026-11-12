/**
 * Raw SQL names tables and columns the way each supported database expects.
 */
import { afterEach, describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { ident } from "../sql.js";

const url = process.env.DATABASE_URL;
afterEach(() => {
  if (url === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = url;
});

const statement = () => Prisma.sql`UPDATE ${ident("Repo")} SET ${ident("formats")} = ${"[]"} WHERE ${ident("id")} = ${"r1"}`;

describe("ident", () => {
  it("double-quotes for SQLite and PostgreSQL, whose placeholders Prisma numbers", () => {
    process.env.DATABASE_URL = "postgresql://forgehub@localhost:5432/forgehub";
    expect(statement().text).toBe('UPDATE "Repo" SET "formats" = $1 WHERE "id" = $2');
    process.env.DATABASE_URL = "file:./dev.db";
    expect(statement().sql).toBe('UPDATE "Repo" SET "formats" = ? WHERE "id" = ?');
  });

  it("uses backticks for MySQL, where double quotes make a string", () => {
    process.env.DATABASE_URL = "mysql://forgehub@localhost:3306/forgehub";
    expect(statement().sql).toBe("UPDATE `Repo` SET `formats` = ? WHERE `id` = ?");
  });

  it("refuses anything that isn't a plain name", () => {
    expect(() => ident('Repo" --')).toThrow();
  });
});
