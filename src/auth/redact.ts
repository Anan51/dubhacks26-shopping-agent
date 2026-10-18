const MONGO_URI = /mongodb(?:\+srv)?:\/\/[^\s'"]+/gi;

/** Replaces mongodb:// and mongodb+srv:// URIs so logs can be shared. */
export function redactMongoUri(text: string): string {
  return text.replace(MONGO_URI, "[redacted-mongodb-uri]");
}
