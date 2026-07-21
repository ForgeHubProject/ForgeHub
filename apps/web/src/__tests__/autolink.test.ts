import { describe, it, expect } from "vitest";
import { tokenizeRefs, type RefToken } from "../lib/autolink";

function kinds(tokens: RefToken[]) {
  return tokens.map((t) => (t.type === "text" ? `t:${t.value}` : `${t.type}:${t.raw}`));
}

describe("tokenizeRefs", () => {
  it("returns a single text token when there are no references", () => {
    expect(tokenizeRefs("just some prose")).toEqual([{ type: "text", value: "just some prose" }]);
  });

  it("splits issue, pull and mention references with surrounding text", () => {
    const tokens = tokenizeRefs("see #12, then !7 and cc @alice done");
    expect(kinds(tokens)).toEqual([
      "t:see ", "issue:#12", "t:, then ", "pull:!7", "t: and cc ", "mention:@alice", "t: done",
    ]);
  });

  it("reconstructs the original string exactly", () => {
    const input = "(fixes #3) ping @bob-cat, supersedes !99!";
    const tokens = tokenizeRefs(input);
    const rebuilt = tokens.map((t) => (t.type === "text" ? t.value : t.raw)).join("");
    expect(rebuilt).toBe(input);
  });

  it("does not match refs mid-word or with trailing alphanumerics", () => {
    expect(kinds(tokenizeRefs("C#7 item#3 #5x"))).toEqual(["t:C#7 item#3 #5x"]);
  });

  it("does not treat emails or path-@ as mentions", () => {
    expect(kinds(tokenizeRefs("mail foo@bar.com"))).toEqual(["t:mail foo@bar.com"]);
    expect(kinds(tokenizeRefs("dir/@x"))).toEqual(["t:dir/@x"]);
  });

  it("handles a reference at the very start", () => {
    expect(kinds(tokenizeRefs("#1 opens"))).toEqual(["issue:#1", "t: opens"]);
  });

  it("parses consecutive references separated by a space", () => {
    expect(kinds(tokenizeRefs("#5 !6 @carol"))).toEqual([
      "issue:#5", "t: ", "pull:!6", "t: ", "mention:@carol",
    ]);
  });
});
