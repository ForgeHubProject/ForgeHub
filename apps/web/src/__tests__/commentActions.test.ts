import { describe, it, expect } from "vitest";
import { quoteReply } from "../components/CommentActions";

describe("quoteReply", () => {
  it("quotes every line, keeps blank lines inside the quote, and leaves room to answer", () => {
    expect(quoteReply("First\n\nSecond\n")).toBe("> First\n>\n> Second\n\n");
  });
});
