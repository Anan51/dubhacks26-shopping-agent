declare const chrome: {
  runtime: {
    id?: string;
    sendMessage: (message: unknown, response?: (value: unknown) => void) => void | Promise<unknown>;
    lastError?: { message?: string };
  };
  storage: {
    local: {
      get: (keys: string[] | null, callback: (items: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, callback?: () => void) => void;
    };
  };
};
