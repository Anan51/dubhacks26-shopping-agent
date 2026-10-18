/**
 * Example data. These are made-up windows and dollar amounts.
 * They are not current T-Mobile offers or any carrier's live promotion.
 */
export type ExampleOffer = {
  id: string;
  name: string;
  /** Extra example saving if the shopper waits until `monthsFromNow`. */
  savingCents: number;
  /** How many months from today the example window sits. */
  monthsFromNow: number;
  windowLabel: string;
};

export const EXAMPLE_OFFERS: readonly ExampleOffer[] = [
  {
    id: "example-trade-in-bundle",
    name: "example trade-in bundle",
    savingCents: 50_000,
    monthsFromNow: 2,
    windowLabel: "example window, about 2 months from today",
  },
  {
    id: "example-plan-bundle",
    name: "example plan bundle",
    savingCents: 8_000,
    monthsFromNow: 4,
    windowLabel: "example window, about 4 months from today",
  },
];
