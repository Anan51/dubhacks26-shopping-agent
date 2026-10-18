import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";

export type AuthPrincipal = {
  id: string;
  email: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthPrincipal;
    }
  }
}

/**
 * Auth method: a signed JWT in the httpOnly cookie `simmer_token`.
 * This is not a server session, so it does not share the in-memory cart store.
 * The same JWT is also accepted as `Authorization: Bearer` for non-browser clients.
 * SESSION_SECRET is unused while this JWT cookie is the session.
 */
export const SESSION_COOKIE = "simmer_token";
const TOKEN_TTL = "7d";

export async function signSession(user: AuthPrincipal, secret: string): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(key(secret));
}

export async function readSession(token: string, secret: string): Promise<AuthPrincipal | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret));
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }
    if (typeof payload.email !== "string" || payload.email.length === 0) {
      return null;
    }
    return { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export function tokenFromRequest(req: Request): string | null {
  const header = req.get("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const bearer = match?.[1];
    if (bearer) {
      return bearer;
    }
  }
  const raw = req.get("cookie");
  if (!raw) {
    return null;
  }
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    if (!value) {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export async function readOptionalUser(req: Request, secret: string): Promise<AuthPrincipal | null> {
  const token = tokenFromRequest(req);
  if (!token) {
    return null;
  }
  return readSession(token, secret);
}

export function requireUser(secret: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = tokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    const user = await readSession(token, secret);
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    req.user = user;
    next();
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(7 * 24 * 60 * 60 * 1000));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
}

function sessionCookieOptions(maxAge?: number): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge?: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
