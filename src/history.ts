import { assertNever, type PersonaId } from "./types.js";

export type { PersonaId };

/** Mock shoppers. The score is the demo input, not a learned model. */

export type MockPurchase = {
  item: string;
  cents: number;
  waited: boolean;
  note: string;
};

export type Persona = {
  id: PersonaId;
  label: string;
  userId: string;
  impulseScore: number;
  history: readonly MockPurchase[];
};

export const IMPULSIVE_USER_ID = "user-impulsive";
export const DELIBERATE_USER_ID = "user-deliberate";

export const IMPULSIVE: Persona = {
  id: "impulsive",
  label: "Example history: frequent buyer",
  userId: IMPULSIVE_USER_ID,
  impulseScore: 2,
  history: [
    { item: "Phone case", cents: 4_900, waited: false, note: "Bought the same afternoon." },
    { item: "AirPods", cents: 17_900, waited: false, note: "No wait." },
  ],
};

export const DELIBERATE: Persona = {
  id: "deliberate",
  label: "Deliberate",
  userId: DELIBERATE_USER_ID,
  impulseScore: 4,
  history: [
    { item: "USB-C charge cable", cents: 1_900, waited: true, note: "Waited a week." },
    { item: "iPhone 15", cents: 79_900, waited: true, note: "Slept on it, then bought." },
  ],
};

export const PERSONAS: readonly Persona[] = [IMPULSIVE, DELIBERATE];

export function personaById(id: PersonaId): Persona {
  switch (id) {
    case "impulsive":
      return IMPULSIVE;
    case "deliberate":
      return DELIBERATE;
    default:
      return assertNever(id);
  }
}

export function isPersonaId(value: string): value is PersonaId {
  return value === "impulsive" || value === "deliberate";
}

/**
 * Assigned ids win. `user-deliberate` is the deliberate seed.
 * Every other id, including the extension's random user, is the impulsive seed.
 */
export function personaFor(userId: string | null, assigned: ReadonlyMap<string, PersonaId> = new Map()): Persona {
  const chosen = userId ? assigned.get(userId) : undefined;
  if (chosen) {
    return personaById(chosen);
  }
  if (userId === DELIBERATE_USER_ID) {
    return DELIBERATE;
  }
  return IMPULSIVE;
}
