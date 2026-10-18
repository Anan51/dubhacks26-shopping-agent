import { hashPassword, verifyPassword } from "./password.js";
import { User } from "./user.js";

export class AccountError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

export type AccountUser = {
  id: string;
  email: string;
  passwordHash: string;
  backboardAssistantId: string | null;
};

export type AccountDirectory = {
  findByEmail(email: string): Promise<AccountUser | null>;
  findById(id: string): Promise<AccountUser | null>;
  create(input: { email: string; passwordHash: string }): Promise<AccountUser>;
  setAssistantId(id: string, assistantId: string): Promise<void>;
};

export type PublicUser = {
  id: string;
  email: string;
};

export function publicUser(user: AccountUser): PublicUser {
  return { id: user.id, email: user.email };
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

export async function signUp(directory: AccountDirectory, input: { email: string; password: string }): Promise<AccountUser> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new AccountError(400, "Enter a valid email.");
  }
  if (input.password.length < 8 || input.password.length > 200) {
    throw new AccountError(400, "Password must be 8–200 characters.");
  }
  const passwordHash = await hashPassword(input.password);
  if (passwordHash === input.password || passwordHash.includes(input.password)) {
    throw new AccountError(500, "Password was not hashed.");
  }
  try {
    return await directory.create({ email, passwordHash });
  } catch (error) {
    if (isDuplicate(error)) {
      throw new AccountError(409, "An account with that email already exists.");
    }
    throw error;
  }
}

/** Same argon2id parameters as hashPassword, so an unknown email still pays a verify. */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$58DJJV552ep5b0R8DthsDA$jIUPCIOoV4TtoKsI3K1nOVC9gjKlGVu4QLg5EZQvrVo";

export async function logIn(directory: AccountDirectory, input: { email: string; password: string }): Promise<AccountUser> {
  const email = normalizeEmail(input.email);
  const user = email ? await directory.findByEmail(email) : null;
  const matches = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !matches) {
    throw new AccountError(401, "Invalid email or password.");
  }
  return user;
}

export function mongooseDirectory(): AccountDirectory {
  return {
    async findByEmail(email) {
      const doc = await User.findOne({ email });
      return doc ? toAccount(doc) : null;
    },
    async findById(id) {
      if (!/^[a-f0-9]{24}$/i.test(id)) {
        return null;
      }
      const doc = await User.findById(id);
      return doc ? toAccount(doc) : null;
    },
    async create(input) {
      const doc = await User.create({ email: input.email, passwordHash: input.passwordHash });
      return toAccount(doc);
    },
    async setAssistantId(id, assistantId) {
      await User.updateOne({ _id: id }, { $set: { backboardAssistantId: assistantId } });
    },
  };
}

function toAccount(doc: {
  _id: { toString(): string };
  email: string;
  passwordHash: string;
  backboardAssistantId?: string | null;
}): AccountUser {
  return {
    id: doc._id.toString(),
    email: doc.email,
    passwordHash: doc.passwordHash,
    backboardAssistantId: doc.backboardAssistantId ?? null,
  };
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
