declare const chrome: {
  runtime: {
    sendMessage: (message: unknown, response?: (value: unknown) => void) => void;
    lastError?: { message?: string };
  };
  storage: {
    local: {
      get: (keys: string[] | null, callback: (items: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, callback?: () => void) => void;
    };
  };
};
