import argon2 from "argon2";

/** OWASP argon2id baseline. The hash string is what we persist — never the password. */
const ARGON = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  const passwordHash = await argon2.hash(password, ARGON);
  if (passwordHash === password || !passwordHash.startsWith("$argon2")) {
    throw new Error("Password hasher returned an unexpected value.");
  }
  return passwordHash;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!isPasswordHash(passwordHash)) {
    return false;
  }
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Argon2 is what we write. Bcrypt prefixes are accepted so an older hash still fails closed as a hash, not as plaintext. */
export function isPasswordHash(value: string): boolean {
  return value.startsWith("$argon2") || value.startsWith("$2a$") || value.startsWith("$2b$") || value.startsWith("$2y$");
}
