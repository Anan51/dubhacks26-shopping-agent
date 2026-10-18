import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hoursOfWork, hoursOfWorkText } from "./hoursOfWork.js";

describe("hours of work", () => {
  it("hides a price that is under 8 hours", () => {
    assert.equal(hoursOfWork(79, 10), null);
    assert.equal(hoursOfWork(80, 10), null);
  });

  it("hides a missing or non-positive rate", () => {
    assert.equal(hoursOfWork(200, 0), null);
    assert.equal(hoursOfWork(200, -5), null);
    assert.equal(hoursOfWork(Number.NaN, 20), null);
  });

  it("shows the rounded hours once the price is over 8 hours", () => {
    const justOver = hoursOfWork(84, 10);
    assert.deepEqual(justOver, { hours: 8, hourlyRate: 10 });
    assert.equal(hoursOfWorkText(justOver ?? { hours: 0, hourlyRate: 0 }), "This is about 8 hours of work at $10/hr.");

    const day = hoursOfWork(180, 12.5);
    assert.deepEqual(day, { hours: 14, hourlyRate: 12.5 });
    assert.equal(hoursOfWorkText(day ?? { hours: 0, hourlyRate: 0 }), "This is about 14 hours of work at $12.50/hr.");
  });
});
