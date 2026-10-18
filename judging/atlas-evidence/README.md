# Atlas evidence

This folder is for local proof that Simmer's users and purchase records persist in MongoDB Atlas, in the `simmer` database.

## Run it on a machine that can reach Atlas

Port 27017 is blocked from the box and from cloud agents. Those environments cannot connect to Atlas. Run the script on a machine that can, such as Saahil's laptop.

The script reads `MONGODB_URI` from the environment only. It does not load a `.env` file. If the variable is missing or blank, it prints `Set MONGODB_URI in your environment` and exits 1.

```bash
export MONGODB_URI='<atlas-connection-string>'
# Optional. When unset, the script uses the same database selection as the server
# (MONGODB_DB if set, otherwise the database named in the URI, otherwise simmer).
# export MONGODB_DB=simmer
npm run evidence:atlas
```

`npm run evidence:atlas` runs `tsx scripts/evidence-atlas.ts`. The connection is read-only: `autoIndex` and `autoCreate` are off, so the script does not create indexes or collections.

## What it writes

Each run writes two markdown files in this directory, on that machine:

- `atlas-evidence-<timestamp>.md` (colons in the timestamp are dashes, so the name is valid on Windows)
- `latest.md` (replaced on every run)

The header records the run time and the database and collections that were read (`users` and `purchaserecords`). User rows show `_id`, a masked email (first character, `***`, and the domain, such as `f***@example.com`), and the first 12 characters of `passwordHash` followed by `…`. At most 500 users are listed. The purchase section shows the total count and the newest row by `createdAt`: `_id`, `userId`, `item`, `price`, the vote stored in `feedback`, and `createdAt` / `updatedAt`. Purchase records do not store a necessity field.

The script removes `MONGODB_URI`, any `mongodb://` or `mongodb+srv://` connection string, full password hashes, and full email addresses before it prints or writes the file. It refuses to return a report that still contains them.

## Generated reports stay local

The reports are generated locally and git-ignored. They contain only masked emails and ids, and they are not committed. Do not `git add` `latest.md`, `atlas-evidence-*.md`, a connection string, a `.env` file, or a full password hash.

`README.md` is the only documentation file in this directory that belongs in git. Anything else here is a local dump.

## EXAMPLE output (fake values, not a real run)

```markdown
# Atlas evidence

- **Run time:** 2000-01-01T00:00:00.000Z
- **Database:** simmer
- **Collections read:** `simmer.users`, `simmer.purchaserecords`

## users

Shown: 1 of 1 (limit 500)

- **_id:** 000000000000000000000001
- **email:** f***@example.com
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
