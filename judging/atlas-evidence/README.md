# Atlas evidence

This folder is for redacted proof that Simmer's users and purchase records persist in MongoDB Atlas, in the `simmer` database.

## Run it on a machine that can reach Atlas

Port 27017 is blocked from the box and from cloud agents. Those environments cannot connect to Atlas. Run the script on a machine that can, such as Saahil's laptop.

The script reads `MONGODB_URI` from the environment. It does not load a `.env` file. If the variable is missing or blank, it prints `Set MONGODB_URI in your environment` and exits 1.

```bash
export MONGODB_URI='<atlas-connection-string>'
# Optional. When unset, the script uses the same database selection as the server
# (MONGODB_DB if set, otherwise the database named in the URI, otherwise simmer).
# export MONGODB_DB=simmer
npm run evidence:atlas
```

`npm run evidence:atlas` runs `tsx scripts/evidence-atlas.ts`.

## What it writes

Each run writes two redacted markdown files in this directory:

- `atlas-evidence-<ISO-8601 timestamp>.md`
- `latest.md` (replaced on every run)

The header records the run time and the database and collections that were read (`users` and `purchaserecords`). User rows show only `_id`, `email`, and the first 12 characters of `passwordHash` followed by `…`. The purchase section shows the total count and the newest row by `createdAt`: `_id`, `userId`, `item`, `price`, the vote stored in `feedback`, and `createdAt` / `updatedAt`. Purchase records do not store a necessity field.

The script removes `MONGODB_URI` and any `mongodb://` or `mongodb+srv://` connection string from the report before it prints or writes the file. It also refuses to write output that still contains the connection string or a full password hash.

## Secrets stay out of git

Do not commit a real connection string, a `.env` file, or a full password hash. Redacted evidence markdown (`README.md`, `latest.md`, and `atlas-evidence-*.md`) is fine to commit after you confirm it contains no connection string.

This directory's `.gitignore` ignores every other filename, so an accidental dump (JSON, logs, env files, or a misnamed export) is not committed. If a generated markdown file still contains a connection string, delete it and do not `git add` it.

## EXAMPLE output (fake values, not a real run)

```markdown
# Atlas evidence

- **Run time:** 2000-01-01T00:00:00.000Z
- **Database:** simmer
- **Collections read:** `simmer.users`, `simmer.purchaserecords`

## users

Rows: 1

- **_id:** 000000000000000000000001
- **email:** fake-shopper@example.com
- **passwordHash prefix:** $argon2id$v=…

## purchaserecords

Total: 1

### Most recent purchase record

Sorted by `createdAt` descending. The shopper's vote is stored as `feedback` (`kept` or `regretted`). This collection does not store a necessity field.

- **_id:** 000000000000000000000002
- **userId:** 000000000000000000000001
- **item:** Example headphones
- **price:** 1
- **feedback (vote):** kept
- **createdAt:** 2000-01-01T00:00:00.000Z
- **updatedAt:** 2000-01-01T00:00:00.000Z
```
