export function apiPathAllowed(path: string): boolean;

export function apiRequestInit(
  method: string,
  token: string | null | undefined,
  body?: unknown,
): {
  method: "GET" | "POST";
  credentials: "include";
  headers: Record<string, string>;
  body?: string;
};
