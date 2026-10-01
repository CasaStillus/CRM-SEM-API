import { describe, expect, it } from "vitest";
import { seesAllConversations } from "./roles";

describe("seesAllConversations", () => {
  it("lets owner, admin and viewer see every conversation", () => {
    expect(seesAllConversations("owner")).toBe(true);
    expect(seesAllConversations("admin")).toBe(true);
    expect(seesAllConversations("viewer")).toBe(true);
  });

  it("limits a seller to their own leads", () => {
    expect(seesAllConversations("agent")).toBe(false);
  });
});
