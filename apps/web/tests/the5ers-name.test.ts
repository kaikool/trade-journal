import { expect, it } from "vitest";
import { the5ersAccountName, the5ersDefaultName } from "../src/lib/the5ers-name";
it("uses package, size and full account number instead of platform", () => {
  expect(
    the5ersDefaultName({
      label: "meta-trader-5 · …8086",
      source: { programName: "High Stakes", accountSize: 50000, accountNumber: "12348086" },
    }),
  ).toBe("High Stakes · 50,000 · 12348086");
});
it("takes package from rules without duplicating size and never invents masked digits", () => {
  expect(
    the5ersDefaultName(
      { label: "c-trader · …1218", source: { accountSize: 50000 } },
      { data: { name: "$50,000 Summer" } },
    ),
  ).toBe("$50,000 Summer · …1218");
  expect(the5ersAccountName("Summer personal account")).toBe("Summer personal account");
});
